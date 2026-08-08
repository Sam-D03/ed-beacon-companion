import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const G560_PROTOCOL_VERSION = 1;
export const G560_VENDOR_ID = 0x046d;
export const G560_PRODUCT_ID = 0x0a78;
export const G560_PROTOCOL_ZONES = Object.freeze([
    "leftFront",
    "leftRear",
    "rightFront",
    "rightRear"
]);

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MAXIMUM_RESPONSE_LENGTH = 1_024;
const MAXIMUM_PENDING_RESPONSES = 16;

function errorMessage(error, fallback = "Unknown G560 bridge error.") {
    return String(error?.message ?? error ?? fallback).trim() || fallback;
}

function safeProtocolText(value, fallback, maximumLength = 96) {
    const printable = String(value ?? "")
        .replace(/[^\x20-\x7e]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximumLength);
    return printable || fallback;
}

function parseFields(tokens) {
    return Object.fromEntries(tokens
        .map((token) => {
            const separator = token.indexOf("=");
            return separator > 0
                ? [token.slice(0, separator), token.slice(separator + 1)]
                : null;
        })
        .filter(Boolean));
}

export function parseG560BridgeResponse(value) {
    const line = String(value ?? "").trim();
    if (!line || line.length > MAXIMUM_RESPONSE_LENGTH) {
        return { type: "invalid", line, reason: line ? "response_too_long" : "empty_response" };
    }
    const tokens = line.split(/\s+/);
    const fields = parseFields(tokens.slice(1));
    switch (tokens[0]) {
        case "READY":
            return {
                type: "ready",
                protocol: Number(fields.protocol),
                line
            };
        case "ACQUIRED":
            return { type: "acquired", sdkVersion: fields.sdk ?? null, line };
        case "FRAME_OK":
            return { type: "frame_ok", sequence: Number(fields.seq), line };
        case "FRAME_DROPPED":
            return { type: "frame_dropped", sequence: Number(fields.seq), line };
        case "RELEASED":
            return { type: "released", line };
        case "PONG":
            return { type: "pong", token: tokens.slice(1).join(" "), line };
        case "BYE":
            return { type: "bye", line };
        case "ERR": {
            const errorFields = parseFields(tokens.slice(3));
            return {
                type: "error",
                scope: tokens[1] ?? "bridge",
                code: tokens[2] ?? "unknown_error",
                sequence: errorFields.seq == null ? null : Number(errorFields.seq),
                zone: errorFields.zone == null ? null : Number(errorFields.zone),
                line
            };
        }
        default:
            return { type: "invalid", line, reason: "unknown_response" };
    }
}

function normalizePercentage(value, zone, channel) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 100) {
        throw new Error(`Invalid ${zone} ${channel} percentage: ${value}`);
    }
    return number;
}

export function formatG560FrameCommand(sequence, frame = {}) {
    const normalizedSequence = Number(sequence);
    if (!Number.isSafeInteger(normalizedSequence) || normalizedSequence < 0) {
        throw new Error(`Invalid G560 frame sequence: ${sequence}`);
    }
    const values = [];
    for (const zone of G560_PROTOCOL_ZONES) {
        const color = frame?.[zone];
        if (!Array.isArray(color) || color.length !== 3) {
            throw new Error(`G560 frame is missing ${zone} RGB percentages.`);
        }
        values.push(
            normalizePercentage(color[0], zone, "red"),
            normalizePercentage(color[1], zone, "green"),
            normalizePercentage(color[2], zone, "blue")
        );
    }
    return `FRAME ${normalizedSequence} ${values.join(" ")}`;
}

export function resolveG560BridgePath({
    resourcesPath = process.resourcesPath,
    existsSyncFn = existsSync
} = {}) {
    const developmentPath = path.resolve(MODULE_DIRECTORY, "../../build/native/g560-bridge.exe");
    const packagedPath = resourcesPath
        ? path.join(resourcesPath, "native", "g560-bridge.exe")
        : null;
    const candidates = [packagedPath, developmentPath].filter(Boolean);
    return candidates.find((candidate) => existsSyncFn(candidate)) ?? candidates[0] ?? developmentPath;
}

export class G560BridgeProvider {
    constructor({
        bridgePath = null,
        applicationName = "ED Beacon Companion",
        logger = null,
        onStatusChange = null,
        spawnFn = spawn,
        existsSyncFn = existsSync,
        listDevicesFn = null,
        platform = process.platform,
        requestTimeoutMs = 2_000,
        startupTimeoutMs = 4_000,
        releaseCloseTimeoutMs = 750,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    } = {}) {
        this.bridgePath = bridgePath ?? resolveG560BridgePath({ existsSyncFn });
        this.applicationName = safeProtocolText(applicationName, "ED Beacon Companion");
        this.logger = logger;
        this.onStatusChange = onStatusChange;
        this.spawnFn = spawnFn;
        this.existsSyncFn = existsSyncFn;
        this.listDevicesFn = listDevicesFn;
        this.platform = platform;
        this.requestTimeoutMs = Math.max(100, Number(requestTimeoutMs) || 2_000);
        this.startupTimeoutMs = Math.max(this.requestTimeoutMs, Number(startupTimeoutMs) || 4_000);
        this.releaseCloseTimeoutMs = Math.max(25, Number(releaseCloseTimeoutMs) || 750);
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;

        this.child = null;
        this.stdoutBuffer = "";
        this.stderrBuffer = "";
        this.responseWaiters = new Set();
        this.nextSequence = 1;
        this.ownershipGeneration = 0;
        this.startPromise = null;
        this.connectPromise = null;
        this.releasePromise = null;
        this.destroyPromise = null;
        this.destroying = false;
        this.destroyed = false;
        this.status = {
            available: platform === "win32",
            detected: null,
            connected: false,
            state: platform === "win32" ? "idle" : "unsupported",
            bridgePath: this.bridgePath,
            bridgePid: null,
            sdkVersion: null,
            lastFrameSequence: null,
            lastFrameAt: null,
            lastError: platform === "win32" ? null : "Logitech G560 lighting is only available on Windows."
        };
    }

    getStatus() {
        return { ...this.status };
    }

    emitStatus(patch = {}) {
        this.status = { ...this.status, ...patch };
        try {
            this.onStatusChange?.(this.getStatus());
        } catch (error) {
            this.logger?.warn?.("G560 status listener failed", errorMessage(error));
        }
        return this.getStatus();
    }

    async rescan() {
        if (typeof this.listDevicesFn !== "function") {
            this.emitStatus({ detected: null });
            return null;
        }
        try {
            const devices = await this.listDevicesFn(G560_VENDOR_ID, G560_PRODUCT_ID);
            const detected = Array.isArray(devices) && devices.length > 0;
            this.emitStatus({ detected });
            return detected;
        } catch (error) {
            this.emitStatus({ detected: null });
            this.logger?.warn?.("Unable to scan for G560 speakers", errorMessage(error));
            return null;
        }
    }

    waitForResponse(predicate, { timeoutMs = this.requestTimeoutMs, label = "response" } = {}) {
        if (this.responseWaiters.size >= MAXIMUM_PENDING_RESPONSES) {
            return Promise.reject(new Error("Too many pending G560 bridge requests."));
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                predicate,
                resolve: (response) => {
                    this.responseWaiters.delete(waiter);
                    this.clearTimeoutFn(waiter.timer);
                    resolve(response);
                },
                reject: (error) => {
                    this.responseWaiters.delete(waiter);
                    this.clearTimeoutFn(waiter.timer);
                    reject(error);
                },
                timer: null
            };
            waiter.timer = this.setTimeoutFn(() => {
                waiter.reject(new Error(`Timed out waiting for G560 bridge ${label}.`));
            }, timeoutMs);
            waiter.timer?.unref?.();
            this.responseWaiters.add(waiter);
        });
    }

    rejectWaiters(error) {
        const failure = error instanceof Error ? error : new Error(errorMessage(error));
        for (const waiter of [...this.responseWaiters]) {
            waiter.reject(failure);
        }
    }

    dispatchResponse(response) {
        let matched = false;
        for (const waiter of [...this.responseWaiters]) {
            let accepts = false;
            try {
                accepts = waiter.predicate(response) === true;
            } catch (error) {
                waiter.reject(error);
                continue;
            }
            if (accepts) {
                matched = true;
                waiter.resolve(response);
            }
        }
        if (!matched && response.type === "error") {
            const detail = `${response.scope}: ${response.code}`;
            this.emitStatus({ lastError: detail });
            this.logger?.warn?.("G560 bridge error", response);
        } else if (!matched && response.type === "invalid") {
            this.failProtocol(new Error(`Invalid G560 bridge response: ${response.reason}`));
        }
    }

    handleStdout(chunk) {
        this.stdoutBuffer += String(chunk);
        if (this.stdoutBuffer.length > MAXIMUM_RESPONSE_LENGTH * 2 && !this.stdoutBuffer.includes("\n")) {
            this.failProtocol(new Error("G560 bridge returned an oversized response."));
            return;
        }
        let newline = this.stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            const response = parseG560BridgeResponse(line);
            this.dispatchResponse(response);
            newline = this.stdoutBuffer.indexOf("\n");
        }
    }

    handleStderr(chunk) {
        this.stderrBuffer = (this.stderrBuffer + String(chunk)).slice(-4_096);
        const lines = this.stderrBuffer.split(/\r?\n/);
        this.stderrBuffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
            this.logger?.warn?.("G560 bridge diagnostic", line.slice(0, 512));
        }
    }

    failProtocol(error) {
        const detail = errorMessage(error);
        this.emitStatus({ connected: false, state: "error", lastError: detail });
        this.rejectWaiters(new Error(detail));
        try {
            this.child?.stdin?.end?.();
        } catch {}
    }

    handleChildExit(child, code, signal) {
        if (this.child !== child) return;
        this.ownershipGeneration += 1;
        this.child = null;
        this.stdoutBuffer = "";
        const expected = this.destroying || this.destroyed;
        const detail = expected
            ? null
            : `G560 bridge exited${code == null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
        this.rejectWaiters(new Error(detail ?? "G560 bridge closed."));
        this.emitStatus({
            connected: false,
            bridgePid: null,
            state: this.destroyed ? "destroyed" : expected ? "idle" : "error",
            lastError: detail
        });
    }

    async ensureBridge() {
        if (this.child) return this.child;
        if (this.startPromise) return this.startPromise;
        if (this.destroying || this.destroyed) {
            throw new Error("G560 bridge provider is shutting down.");
        }
        if (this.platform !== "win32") {
            throw new Error(this.status.lastError);
        }
        if (!this.existsSyncFn(this.bridgePath)) {
            throw new Error(`G560 bridge executable was not found: ${this.bridgePath}`);
        }

        this.emitStatus({ state: "starting", lastError: null });
        this.startPromise = (async () => {
            let child;
            try {
                child = this.spawnFn(this.bridgePath, [], {
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"]
                });
            } catch (error) {
                throw new Error(`Unable to start the G560 bridge: ${errorMessage(error)}`);
            }
            if (!child?.stdin || !child?.stdout || !child?.stderr) {
                throw new Error("G560 bridge did not provide the required stdio pipes.");
            }
            this.child = child;
            child.stdout.setEncoding?.("utf8");
            child.stderr.setEncoding?.("utf8");
            child.stdout.on("data", (chunk) => {
                if (this.child === child) this.handleStdout(chunk);
            });
            child.stderr.on("data", (chunk) => {
                if (this.child === child) this.handleStderr(chunk);
            });
            // Writable streams can report EPIPE asynchronously, after write()
            // has returned. Always consume it and route it through the same
            // bounded recovery path instead of letting Electron crash.
            child.stdin.on("error", (error) => {
                if (this.child === child) this.failProtocol(error);
            });
            child.once("error", (error) => {
                if (this.child === child) this.failProtocol(error);
            });
            child.once("exit", (code, signal) => this.handleChildExit(child, code, signal));
            this.emitStatus({ bridgePid: child.pid ?? null });

            const ready = await this.waitForResponse(
                (response) => response.type === "ready" || response.type === "error",
                { timeoutMs: this.startupTimeoutMs, label: "startup" }
            );
            if (ready.type === "error") {
                throw new Error(`G560 bridge startup failed: ${ready.code}`);
            }
            if (ready.protocol !== G560_PROTOCOL_VERSION) {
                throw new Error(`Unsupported G560 bridge protocol ${ready.protocol}.`);
            }
            this.emitStatus({ state: "ready", lastError: null });
            return child;
        })().catch((error) => {
            this.failProtocol(error);
            throw error;
        }).finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    sendLine(line) {
        if (!this.child?.stdin?.writable) {
            throw new Error("G560 bridge input is not available.");
        }
        if (String(line).length > 512 || /[\r\n]/.test(String(line))) {
            throw new Error("Invalid G560 bridge request.");
        }
        this.child.stdin.write(`${line}\n`, "ascii");
    }

    async request(line, predicate, options = {}) {
        const responsePromise = this.waitForResponse(
            (response) => predicate(response) || (
                response.type === "error" &&
                options.errorPredicate?.(response) !== false
            ),
            options
        );
        try {
            this.sendLine(line);
        } catch (error) {
            // Prevent the waiter from surviving a synchronous pipe failure.
            this.rejectWaiters(error);
            throw error;
        }
        const response = await responsePromise;
        if (response.type === "error") {
            const failure = new Error(`G560 bridge ${response.scope} error: ${response.code}`);
            failure.bridgeResponse = response;
            throw failure;
        }
        return response;
    }

    async connect() {
        if (this.releasePromise) await this.releasePromise;
        if (this.destroying || this.destroyed) {
            throw new Error("G560 bridge provider is shutting down.");
        }
        if (this.status.connected) return true;
        if (this.connectPromise) return this.connectPromise;
        this.connectPromise = (async () => {
            const detected = await this.rescan();
            if (detected === false) {
                throw new Error("Logitech G560 speakers were not found over USB.");
            }
            await this.ensureBridge();
            this.emitStatus({ state: "acquiring", lastError: null });
            const acquired = await this.request(
                `ACQUIRE ${this.applicationName}`,
                (response) => response.type === "acquired",
                { timeoutMs: this.startupTimeoutMs, label: "acquisition" }
            );
            this.emitStatus({
                connected: true,
                state: "connected",
                sdkVersion: acquired.sdkVersion,
                lastError: null
            });
            this.ownershipGeneration += 1;
            return true;
        })().catch((error) => {
            if (!this.destroyed) {
                this.emitStatus({ connected: false, state: "error", lastError: errorMessage(error) });
            }
            throw error;
        }).finally(() => {
            this.connectPromise = null;
        });
        return this.connectPromise;
    }

    async writeFrame(frame) {
        if (!this.status.connected || !this.child) {
            throw new Error("G560 lighting is not connected.");
        }
        const sequence = this.nextSequence++;
        const ownershipGeneration = this.ownershipGeneration;
        const child = this.child;
        const command = formatG560FrameCommand(sequence, frame);
        try {
            const response = await this.request(
                command,
                (candidate) =>
                    (candidate.type === "frame_ok" || candidate.type === "frame_dropped") &&
                    candidate.sequence === sequence,
                {
                    timeoutMs: this.requestTimeoutMs,
                    label: `frame ${sequence}`,
                    errorPredicate: (candidate) => candidate.scope !== "frame" || candidate.sequence === sequence
                }
            );
            if (
                this.status.connected &&
                this.child === child &&
                this.ownershipGeneration === ownershipGeneration
            ) {
                // Frame telemetry is sampled by LightingEngine once per second.
                // Do not notify the tray at frame rate and rebuild it ~30 Hz.
                this.status = { ...this.status,
                    connected: true,
                    state: "connected",
                    lastFrameSequence: sequence,
                    lastFrameAt: new Date().toISOString(),
                    lastError: null
                };
            }
            return response.type === "frame_ok" || response.type === "frame_dropped";
        } catch (error) {
            if (
                this.child !== child ||
                this.ownershipGeneration !== ownershipGeneration
            ) {
                // This acknowledgement belonged to ownership that has already
                // been released or replaced. It must not tear down the new one.
                if (this.child !== null) return true;
                throw error;
            }
            if (!this.destroyed) {
                this.emitStatus({ connected: false, state: "error", lastError: errorMessage(error) });
            }
            throw error;
        }
    }

    async release(reason = "release") {
        if (this.releasePromise) return this.releasePromise;
        this.releasePromise = (async () => {
            if (this.connectPromise) {
                await this.connectPromise.catch(() => {});
            }
            if (!this.child) {
                this.emitStatus({ connected: false, state: this.destroyed ? "destroyed" : "idle" });
                return true;
            }
            // Drop the public ownership flag before the async SDK release so a
            // rapid preview/re-enable cannot send another frame into teardown.
            this.ownershipGeneration += 1;
            this.emitStatus({ connected: false, state: "releasing" });
            await this.request(
                `RELEASE ${safeProtocolText(reason, "release")}`,
                (response) => response.type === "released",
                { timeoutMs: this.requestTimeoutMs, label: "release" }
            );
            this.emitStatus({ connected: false, state: "ready", lastError: null });
            return true;
        })().catch(async (error) => {
            await this.closeBridgeAfterReleaseFailure(error);
            this.emitStatus({ connected: false, state: "error", lastError: errorMessage(error) });
            throw error;
        }).finally(() => {
            this.releasePromise = null;
        });
        return this.releasePromise;
    }

    async closeBridgeAfterReleaseFailure(error) {
        const child = this.child;
        this.ownershipGeneration += 1;
        if (!child) return true;
        const detail = errorMessage(error);
        this.logger?.warn?.("G560 bridge release failed; closing helper to relinquish SDK ownership", detail);
        this.rejectWaiters(new Error(`G560 bridge closing after release failure: ${detail}`));
        try {
            child.stdin?.end?.();
        } catch {}
        if (await this.waitForChildExit(child, this.releaseCloseTimeoutMs)) return true;
        try {
            child.kill?.();
        } catch {}
        const exited = await this.waitForChildExit(child, 250);
        if (!exited && this.child === child) {
            // Do not reuse a pipe whose process could not confirm exit. A
            // subsequent connect gets a fresh helper; the old process has
            // already received both EOF and termination requests.
            this.child = null;
            this.stdoutBuffer = "";
            this.emitStatus({ connected: false, bridgePid: null });
        }
        return exited;
    }

    waitForChildExit(child, timeoutMs) {
        if (!child || this.child !== child) return Promise.resolve(true);
        return new Promise((resolve) => {
            let timer = null;
            const finish = (result) => {
                child.removeListener?.("exit", onExit);
                if (timer) this.clearTimeoutFn(timer);
                resolve(result);
            };
            const onExit = () => finish(true);
            child.once("exit", onExit);
            timer = this.setTimeoutFn(() => finish(false), timeoutMs);
            timer?.unref?.();
        });
    }

    forceTerminate(reason = "forced_shutdown") {
        const child = this.child;
        this.ownershipGeneration += 1;
        this.destroying = true;
        this.destroyed = true;
        this.child = null;
        this.rejectWaiters(new Error(`G560 bridge terminated: ${safeProtocolText(reason, "forced_shutdown")}`));
        try {
            child?.stdin?.destroy?.();
        } catch {}
        try {
            child?.kill?.();
        } catch {}
        this.emitStatus({
            connected: false,
            state: "destroyed",
            bridgePid: null,
            lastError: reason === "shutdown_timeout" ? "Bridge was force-closed during application shutdown." : null
        });
        return child != null;
    }

    async destroy(reason = "application_exit") {
        if (this.destroyPromise) return this.destroyPromise;
        this.destroying = true;
        this.destroyPromise = (async () => {
            await this.release(reason).catch(() => {});
            const child = this.child;
            if (child) {
                try {
                    await this.request(
                        "QUIT",
                        (response) => response.type === "bye",
                        { timeoutMs: this.requestTimeoutMs, label: "shutdown" }
                    );
                } catch (error) {
                    this.logger?.warn?.("G560 bridge graceful shutdown failed", errorMessage(error));
                }
                try {
                    child.stdin?.end?.();
                } catch {}
                if (!await this.waitForChildExit(child, 750)) {
                    child.kill?.();
                    await this.waitForChildExit(child, 250);
                }
            }
            this.destroyed = true;
            this.emitStatus({ connected: false, state: "destroyed", bridgePid: null });
        })().finally(() => {
            this.destroying = false;
        });
        return this.destroyPromise;
    }
}
