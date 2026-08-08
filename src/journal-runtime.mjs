import { Journal } from "@kayahr/ed-journal";

function messageFromError(error) {
    return String(error?.message ?? error ?? "Journal watcher failed.").trim() || "Journal watcher failed.";
}

async function settleWithin(promise, timeoutMs, setTimeoutFn, clearTimeoutFn) {
    if (!promise) return true;
    let timer = null;
    const settled = Promise.resolve(promise).then(() => true, () => true);
    const timedOut = new Promise((resolve) => {
        timer = setTimeoutFn(() => resolve(false), timeoutMs);
        timer?.unref?.();
    });
    const result = await Promise.race([settled, timedOut]);
    if (timer) clearTimeoutFn(timer);
    return result;
}

async function closeJournalQuietly(journal, timeoutMs, setTimeoutFn, clearTimeoutFn) {
    if (!journal || typeof journal.close !== "function") {
        return;
    }
    try {
        const closing = Promise.resolve(journal.close()).catch(() => {});
        await settleWithin(closing, timeoutMs, setTimeoutFn, clearTimeoutFn);
    } catch {
        // Closing is best-effort during disable, retry, and application exit.
    }
}

export class JournalRuntime {
    constructor({
        openJournal = (options) => Journal.open(options),
        onEvent,
        onStatus = null,
        onJournalReady = null,
        onStatusChange = null,
        logger = null,
        retryDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
        shutdownTimeoutMs = 1_500,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    } = {}) {
        if (typeof onEvent !== "function") {
            throw new Error("JournalRuntime requires an onEvent handler.");
        }
        this.openJournal = openJournal;
        this.onEvent = onEvent;
        this.onStatus = onStatus;
        this.onJournalReady = onJournalReady;
        this.onStatusChange = onStatusChange;
        this.logger = logger;
        this.retryDelaysMs = retryDelaysMs;
        this.shutdownTimeoutMs = Math.max(1, Number(shutdownTimeoutMs) || 1_500);
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.running = false;
        this.activeJournal = null;
        this.activeGeneration = null;
        this.runPromise = null;
        this.runGeneration = 0;
        this.retryTimer = null;
        this.retryResolve = null;
        this.status = {
            state: "stopped",
            directory: null,
            lastEvent: null,
            lastEventAt: null,
            lastError: null,
            retryInMs: null
        };
    }

    getStatus() {
        return { ...this.status };
    }

    emitStatus(patch = {}) {
        this.status = { ...this.status, ...patch };
        this.onStatusChange?.(this.getStatus());
        return this.getStatus();
    }

    start() {
        if (this.running) {
            return false;
        }
        this.running = true;
        const generation = ++this.runGeneration;
        this.emitStatus({ state: "starting", lastError: null, retryInMs: null });
        this.runPromise = this.runLoop(generation);
        return true;
    }

    async stop() {
        if (!this.running && !this.runPromise) {
            return false;
        }
        const stoppingPromise = this.runPromise;
        this.runPromise = null;
        this.running = false;
        ++this.runGeneration;
        this.cancelRetryWait();
        const journal = this.activeJournal;
        this.activeJournal = null;
        this.activeGeneration = null;
        await closeJournalQuietly(journal, this.shutdownTimeoutMs, this.setTimeoutFn, this.clearTimeoutFn);
        await settleWithin(stoppingPromise, this.shutdownTimeoutMs, this.setTimeoutFn, this.clearTimeoutFn);
        this.emitStatus({ state: "stopped", retryInMs: null });
        return true;
    }

    isGenerationActive(generation) {
        return this.running && generation === this.runGeneration;
    }

    async runLoop(generation) {
        let failureCount = 0;
        while (this.isGenerationActive(generation)) {
            let journal = null;
            try {
                journal = await this.openJournal({ position: "end", watch: true });
                if (!this.isGenerationActive(generation)) {
                    await closeJournalQuietly(journal, this.shutdownTimeoutMs, this.setTimeoutFn, this.clearTimeoutFn);
                    break;
                }
                this.activeJournal = journal;
                this.activeGeneration = generation;
                failureCount = 0;
                this.emitStatus({
                    state: "watching",
                    directory: journal.getDirectory?.() ?? null,
                    lastError: null,
                    retryInMs: null
                });
                this.logger?.info?.("Journal watcher started", { directory: journal.getDirectory?.() ?? null });

                if (typeof this.onJournalReady === "function") {
                    try {
                        await this.onJournalReady({ directory: journal.getDirectory?.() ?? null });
                    } catch (error) {
                        this.logger?.warn?.("Journal metadata preload failed", { detail: messageFromError(error) });
                    }
                    if (!this.isGenerationActive(generation)) break;
                }

                const watcherPromises = [
                    this.watchJournalEvents(journal, generation).then(() => "journal")
                ];
                if (typeof this.onStatus === "function") {
                    watcherPromises.push(this.watchStatusSnapshots(journal, generation).then(() => "status"));
                }

                try {
                    const endedWatcher = await Promise.race(watcherPromises);
                    if (this.isGenerationActive(generation)) {
                        const label = endedWatcher === "status" ? "Status" : "Journal";
                        throw new Error(`${label} watcher ended unexpectedly.`);
                    }
                } finally {
                    await closeJournalQuietly(journal, this.shutdownTimeoutMs, this.setTimeoutFn, this.clearTimeoutFn);
                    await settleWithin(Promise.allSettled(watcherPromises), this.shutdownTimeoutMs, this.setTimeoutFn, this.clearTimeoutFn);
                }
            } catch (error) {
                if (!this.isGenerationActive(generation)) {
                    break;
                }
                const detail = messageFromError(error);
                const retryInMs = this.retryDelaysMs[Math.min(failureCount, this.retryDelaysMs.length - 1)] ?? 30_000;
                failureCount += 1;
                this.logger?.warn?.("Journal watcher error", { detail, retryInMs });
                this.emitStatus({ state: "retrying", lastError: detail, retryInMs });
                await this.waitForRetry(retryInMs);
            } finally {
                if (this.activeJournal === journal && this.activeGeneration === generation) {
                    this.activeJournal = null;
                    this.activeGeneration = null;
                }
                await closeJournalQuietly(journal, this.shutdownTimeoutMs, this.setTimeoutFn, this.clearTimeoutFn);
            }
        }
    }

    async watchJournalEvents(journal, generation) {
        for await (const event of journal) {
            if (!this.isGenerationActive(generation)) {
                break;
            }
            await this.onEvent(event);
            this.emitStatus({
                lastEvent: String(event?.event ?? "Unknown"),
                lastEventAt: event?.timestamp ?? new Date().toISOString()
            });
        }
    }

    async watchStatusSnapshots(journal, generation) {
        if (typeof journal?.watchStatus !== "function") {
            throw new Error("Journal does not support Status.json watching.");
        }

        let initial = true;
        for await (const snapshot of journal.watchStatus()) {
            if (!this.isGenerationActive(generation)) {
                break;
            }
            await this.onStatus(snapshot, { initial });
            initial = false;
        }
    }

    waitForRetry(delayMs) {
        return new Promise((resolve) => {
            this.retryResolve = resolve;
            this.retryTimer = this.setTimeoutFn(() => {
                this.retryTimer = null;
                this.retryResolve = null;
                resolve();
            }, delayMs);
            this.retryTimer?.unref?.();
        });
    }

    cancelRetryWait() {
        if (this.retryTimer) {
            this.clearTimeoutFn(this.retryTimer);
            this.retryTimer = null;
        }
        const resolve = this.retryResolve;
        this.retryResolve = null;
        resolve?.();
    }
}
