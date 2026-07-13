import { Journal } from "@kayahr/ed-journal";

function messageFromError(error) {
    return String(error?.message ?? error ?? "Journal watcher failed.").trim() || "Journal watcher failed.";
}

async function closeJournalQuietly(journal) {
    if (!journal || typeof journal.close !== "function") {
        return;
    }
    try {
        await journal.close();
    } catch {
        // Closing is best-effort during disable, retry, and application exit.
    }
}

export class JournalRuntime {
    constructor({
        openJournal = (options) => Journal.open(options),
        onEvent,
        onStatusChange = null,
        logger = null,
        retryDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    } = {}) {
        if (typeof onEvent !== "function") {
            throw new Error("JournalRuntime requires an onEvent handler.");
        }
        this.openJournal = openJournal;
        this.onEvent = onEvent;
        this.onStatusChange = onStatusChange;
        this.logger = logger;
        this.retryDelaysMs = retryDelaysMs;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.running = false;
        this.activeJournal = null;
        this.runPromise = null;
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
        this.emitStatus({ state: "starting", lastError: null, retryInMs: null });
        this.runPromise = this.runLoop();
        return true;
    }

    async stop() {
        if (!this.running && !this.runPromise) {
            return false;
        }
        this.running = false;
        this.cancelRetryWait();
        const journal = this.activeJournal;
        this.activeJournal = null;
        await closeJournalQuietly(journal);
        await this.runPromise?.catch(() => {});
        this.runPromise = null;
        this.emitStatus({ state: "stopped", retryInMs: null });
        return true;
    }

    async runLoop() {
        let failureCount = 0;
        while (this.running) {
            let journal = null;
            try {
                journal = await this.openJournal({ position: "end", watch: true });
                if (!this.running) {
                    await journal.close();
                    break;
                }
                this.activeJournal = journal;
                failureCount = 0;
                this.emitStatus({
                    state: "watching",
                    directory: journal.getDirectory?.() ?? null,
                    lastError: null,
                    retryInMs: null
                });
                this.logger?.info?.("Journal watcher started", { directory: journal.getDirectory?.() ?? null });

                for await (const event of journal) {
                    if (!this.running) {
                        break;
                    }
                    await this.onEvent(event);
                    this.emitStatus({
                        lastEvent: String(event?.event ?? "Unknown"),
                        lastEventAt: event?.timestamp ?? new Date().toISOString()
                    });
                }

                if (this.running) {
                    throw new Error("Journal watcher ended unexpectedly.");
                }
            } catch (error) {
                if (!this.running) {
                    break;
                }
                const detail = messageFromError(error);
                const retryInMs = this.retryDelaysMs[Math.min(failureCount, this.retryDelaysMs.length - 1)] ?? 30_000;
                failureCount += 1;
                this.logger?.warn?.("Journal watcher error", { detail, retryInMs });
                this.emitStatus({ state: "retrying", lastError: detail, retryInMs });
                await this.waitForRetry(retryInMs);
            } finally {
                if (this.activeJournal === journal) {
                    this.activeJournal = null;
                }
                await closeJournalQuietly(journal);
            }
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
