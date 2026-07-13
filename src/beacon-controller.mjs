import { BEACON_EFFECTS, getBeaconReport } from "./beacon-protocol.mjs";

const EFFECT_PRIORITY = Object.freeze({
    [BEACON_EFFECTS.OFF]: 0,
    [BEACON_EFFECTS.SPIN]: 1,
    [BEACON_EFFECTS.STROBE]: 2
});

function errorMessage(error, fallback = "Unknown beacon error.") {
    return String(error?.message ?? error ?? fallback).trim() || fallback;
}

export class BeaconController {
    constructor({
        adapter,
        logger = null,
        onStatusChange = null,
        keepAliveMs = 4_000,
        retryMs = 5_000,
        now = () => Date.now(),
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval
    } = {}) {
        if (!adapter || typeof adapter.list !== "function" || typeof adapter.open !== "function") {
            throw new Error("BeaconController requires a HID adapter.");
        }

        this.adapter = adapter;
        this.logger = logger;
        this.onStatusChange = onStatusChange;
        this.keepAliveMs = keepAliveMs;
        this.retryMs = retryMs;
        this.now = now;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;

        this.device = null;
        this.deviceInfo = null;
        this.baseEffect = BEACON_EFFECTS.OFF;
        this.activeEffect = BEACON_EFFECTS.OFF;
        this.pulseExpiries = new Map();
        this.keepAliveTimer = null;
        this.pulseTimer = null;
        this.retryTimer = null;
        this.destroyed = false;
        this.status = {
            available: true,
            detected: false,
            connected: false,
            effect: BEACON_EFFECTS.OFF,
            baseEffect: BEACON_EFFECTS.OFF,
            deviceName: null,
            lastSeenAt: null,
            lastCommandAt: null,
            lastError: null
        };
    }

    getStatus() {
        return { ...this.status };
    }

    emitStatus(patch = {}) {
        this.status = {
            ...this.status,
            ...patch,
            effect: this.activeEffect,
            baseEffect: this.baseEffect
        };
        try {
            this.onStatusChange?.(this.getStatus());
        } catch (error) {
            this.logger?.warn?.("Beacon status listener failed", errorMessage(error));
        }
        return this.getStatus();
    }

    scan({ force = false } = {}) {
        if (this.destroyed) {
            return this.getStatus();
        }
        if (force) {
            this.closeDevice();
        }
        if (!this.device) {
            this.tryOpenDevice();
        }
        // A freshly opened beacon may have been left active by a crashed process,
        // so a scan always asserts the current desired state, including OFF.
        this.reconcile({ allowScan: false, forceWrite: true });
        return this.getStatus();
    }

    setBaseEffect(effect, reason = null) {
        if (![BEACON_EFFECTS.OFF, BEACON_EFFECTS.SPIN].includes(effect)) {
            throw new Error(`Unsupported base beacon effect: ${effect}`);
        }
        this.baseEffect = effect;
        this.logger?.info?.("Beacon base effect", { effect, reason });
        this.reconcile();
        return this.getStatus();
    }

    pulse(effect, durationMs, reason = null) {
        if (![BEACON_EFFECTS.SPIN, BEACON_EFFECTS.STROBE].includes(effect)) {
            throw new Error(`Unsupported beacon pulse effect: ${effect}`);
        }
        const duration = Math.max(1, Math.trunc(Number(durationMs) || 0));
        const nextExpiry = this.now() + duration;
        const existingExpiry = this.pulseExpiries.get(effect) ?? 0;
        this.pulseExpiries.set(effect, Math.max(existingExpiry, nextExpiry));
        this.logger?.info?.("Beacon pulse", { effect, durationMs: duration, reason });
        this.schedulePulseExpiry();
        this.reconcile();
        return this.getStatus();
    }

    stopAll(reason = null) {
        this.baseEffect = BEACON_EFFECTS.OFF;
        this.pulseExpiries.clear();
        this.clearPulseTimer();
        this.clearRetryTimer();
        this.logger?.info?.("Beacon stop", { reason });
        this.reconcile({ allowScan: false });
        return this.getStatus();
    }

    disconnect(reason = null) {
        this.stopAll(reason);
        this.closeDevice();
        return this.emitStatus();
    }

    destroy(reason = "application_exit") {
        if (this.destroyed) {
            return this.getStatus();
        }
        this.stopAll(reason);
        this.destroyed = true;
        this.closeDevice();
        this.clearKeepAlive();
        this.clearPulseTimer();
        this.clearRetryTimer();
        return this.emitStatus({ available: false });
    }

    desiredEffect() {
        const currentTime = this.now();
        for (const [effect, expiry] of this.pulseExpiries) {
            if (expiry <= currentTime) {
                this.pulseExpiries.delete(effect);
            }
        }

        const candidates = [this.baseEffect, ...this.pulseExpiries.keys()];
        return candidates.reduce((highest, effect) =>
            EFFECT_PRIORITY[effect] > EFFECT_PRIORITY[highest] ? effect : highest,
        BEACON_EFFECTS.OFF);
    }

    reconcile({ allowScan = true, forceWrite = false } = {}) {
        if (this.destroyed) {
            return;
        }
        const desired = this.desiredEffect();
        this.schedulePulseExpiry();

        if (desired === BEACON_EFFECTS.OFF) {
            this.clearKeepAlive();
            this.clearRetryTimer();
            if (this.device && (forceWrite || this.activeEffect !== BEACON_EFFECTS.OFF)) {
                this.writeEffect(BEACON_EFFECTS.OFF);
            } else {
                this.activeEffect = BEACON_EFFECTS.OFF;
                this.emitStatus();
            }
            return;
        }

        if (!this.device && allowScan) {
            this.tryOpenDevice();
        }
        if (!this.device) {
            this.activeEffect = BEACON_EFFECTS.OFF;
            this.emitStatus();
            this.scheduleRetry();
            return;
        }

        this.clearRetryTimer();
        if (forceWrite || this.activeEffect !== desired) {
            if (!this.writeEffect(desired)) {
                return;
            }
        }
        this.startKeepAlive();
        this.emitStatus();
    }

    tryOpenDevice() {
        try {
            const deviceInfo = this.adapter.list().find(Boolean) ?? null;
            if (!deviceInfo) {
                this.emitStatus({
                    detected: false,
                    connected: false,
                    deviceName: null,
                    lastError: "Farming Simulator beacon not found."
                });
                return false;
            }

            this.device = this.adapter.open(deviceInfo);
            this.deviceInfo = deviceInfo;
            if (typeof this.device?.on === "function") {
                this.device.on("error", (error) => this.handleDeviceFailure(error));
            }
            const seenAt = new Date(this.now()).toISOString();
            this.emitStatus({
                detected: true,
                connected: true,
                deviceName: deviceInfo.product || "Farming Simulator 22 USB Beacon",
                lastSeenAt: seenAt,
                lastError: null
            });
            this.logger?.info?.("Beacon connected", { path: deviceInfo.path ?? null });
            return true;
        } catch (error) {
            this.handleDeviceFailure(error);
            return false;
        }
    }

    writeEffect(effect) {
        if (!this.device) {
            return false;
        }
        try {
            const written = this.device.write(getBeaconReport(effect));
            if (Number.isFinite(Number(written)) && Number(written) <= 0) {
                throw new Error("USB HID write returned no bytes.");
            }
            this.activeEffect = effect;
            this.emitStatus({
                connected: true,
                detected: true,
                lastCommandAt: new Date(this.now()).toISOString(),
                lastError: null
            });
            return true;
        } catch (error) {
            this.handleDeviceFailure(error);
            return false;
        }
    }

    handleDeviceFailure(error) {
        const message = errorMessage(error);
        this.logger?.warn?.("Beacon device error", message);
        this.clearKeepAlive();
        this.closeDevice();
        this.activeEffect = BEACON_EFFECTS.OFF;
        this.emitStatus({ connected: false, lastError: message });
        this.scheduleRetry();
    }

    closeDevice() {
        const device = this.device;
        this.device = null;
        this.deviceInfo = null;
        this.activeEffect = BEACON_EFFECTS.OFF;
        this.clearKeepAlive();
        if (device) {
            try {
                device.removeAllListeners?.();
                device.close?.();
            } catch (error) {
                this.logger?.warn?.("Beacon close failed", errorMessage(error));
            }
        }
        this.emitStatus({ connected: false });
    }

    startKeepAlive() {
        if (this.keepAliveTimer || this.activeEffect === BEACON_EFFECTS.OFF) {
            return;
        }
        this.keepAliveTimer = this.setIntervalFn(() => {
            if (this.activeEffect !== BEACON_EFFECTS.OFF && this.device) {
                this.writeEffect(this.activeEffect);
            }
        }, this.keepAliveMs);
        this.keepAliveTimer?.unref?.();
    }

    clearKeepAlive() {
        if (this.keepAliveTimer) {
            this.clearIntervalFn(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    scheduleRetry() {
        if (this.destroyed || this.retryTimer || this.desiredEffect() === BEACON_EFFECTS.OFF) {
            return;
        }
        this.retryTimer = this.setTimeoutFn(() => {
            this.retryTimer = null;
            this.tryOpenDevice();
            this.reconcile({ allowScan: false, forceWrite: true });
        }, this.retryMs);
        this.retryTimer?.unref?.();
    }

    clearRetryTimer() {
        if (this.retryTimer) {
            this.clearTimeoutFn(this.retryTimer);
            this.retryTimer = null;
        }
    }

    schedulePulseExpiry() {
        this.clearPulseTimer();
        const currentTime = this.now();
        const expiries = [...this.pulseExpiries.values()].filter((expiry) => expiry > currentTime);
        if (!expiries.length) {
            return;
        }
        const delay = Math.max(1, Math.min(...expiries) - currentTime);
        this.pulseTimer = this.setTimeoutFn(() => {
            this.pulseTimer = null;
            this.reconcile();
        }, delay);
        this.pulseTimer?.unref?.();
    }

    clearPulseTimer() {
        if (this.pulseTimer) {
            this.clearTimeoutFn(this.pulseTimer);
            this.pulseTimer = null;
        }
    }
}
