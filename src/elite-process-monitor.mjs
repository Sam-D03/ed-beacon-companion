import { execFile } from "node:child_process";

const ELITE_EXECUTABLE = "EliteDangerous64.exe";

function errorMessage(error) {
    return String(error?.message ?? error ?? "Unable to inspect the Elite Dangerous process.").trim();
}

export function queryEliteProcess({
    execFileFn = execFile,
    platform = process.platform
} = {}) {
    if (platform !== "win32") return Promise.resolve(false);
    return new Promise((resolve, reject) => {
        execFileFn(
            "tasklist.exe",
            ["/FI", `IMAGENAME eq ${ELITE_EXECUTABLE}`, "/FO", "CSV", "/NH"],
            { windowsHide: true, timeout: 3_000, maxBuffer: 256 * 1024 },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(new RegExp(`^"?${ELITE_EXECUTABLE.replace(".", "\\.")}"?`, "imu").test(String(stdout ?? "")));
            }
        );
    });
}

export class EliteProcessMonitor {
    constructor({
        probe = () => queryEliteProcess(),
        onChange = null,
        onStatusChange = null,
        logger = null,
        intervalMs = 3_000,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    } = {}) {
        this.probe = probe;
        this.onChange = onChange;
        this.onStatusChange = onStatusChange;
        this.logger = logger;
        this.intervalMs = Math.max(500, Number(intervalMs) || 3_000);
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.running = false;
        this.timer = null;
        this.checkPromise = null;
        this.status = {
            state: "stopped",
            running: null,
            lastCheckedAt: null,
            lastError: null
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

    async start() {
        if (this.running) return false;
        this.running = true;
        this.emitStatus({ state: "checking", lastError: null });
        await this.checkNow();
        this.scheduleNext();
        return true;
    }

    async checkNow() {
        if (this.checkPromise) return this.checkPromise;
        this.checkPromise = Promise.resolve()
            .then(() => this.probe())
            .then(async (value) => {
                const next = value === true;
                const changed = next !== this.status.running;
                this.emitStatus({
                    state: this.running ? "watching" : "stopped",
                    running: next,
                    lastCheckedAt: new Date().toISOString(),
                    lastError: null
                });
                if (changed) {
                    this.logger?.info?.("Elite Dangerous process state changed", { running: next });
                    await this.onChange?.(next);
                }
                return next;
            })
            .catch((error) => {
                const detail = errorMessage(error);
                this.emitStatus({
                    state: this.running ? "error" : "stopped",
                    lastCheckedAt: new Date().toISOString(),
                    lastError: detail
                });
                this.logger?.warn?.("Elite Dangerous process check failed", detail);
                return this.status.running;
            })
            .finally(() => {
                this.checkPromise = null;
            });
        return this.checkPromise;
    }

    scheduleNext() {
        if (!this.running || this.timer) return;
        this.timer = this.setTimeoutFn(async () => {
            this.timer = null;
            await this.checkNow();
            this.scheduleNext();
        }, this.intervalMs);
        this.timer?.unref?.();
    }

    async stop() {
        if (!this.running && !this.checkPromise) return false;
        this.running = false;
        if (this.timer) this.clearTimeoutFn(this.timer);
        this.timer = null;
        await this.checkPromise?.catch(() => {});
        this.emitStatus({ state: "stopped", running: null });
        return true;
    }
}
