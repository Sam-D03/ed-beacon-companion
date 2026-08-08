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
        this.baseReason = null;
        this.activeEffect = BEACON_EFFECTS.OFF;
        this.activeReason = null;
        this.pulses = [];
        this.nextPulseSequence = 1;
        this.keepAliveTimer = null;
        this.pulseTimer = null;
        this.retryTimer = null;
        this.stopConfirmTimers = new Set();
        this.destroyed = false;
        this.status = {
            available: true,
            detected: false,
            connected: false,
            effect: BEACON_EFFECTS.OFF,
            baseEffect: BEACON_EFFECTS.OFF,
            triggerReason: null,
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
            baseEffect: this.baseEffect,
            triggerReason: this.activeReason
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
        this.baseReason = effect === BEACON_EFFECTS.OFF ? null : reason;
        this.logger?.info?.("Beacon base effect", { effect, reason });
        this.reconcile();
        return this.getStatus();
    }

    pulse(effect, durationMs, reason = null) {
        if (![BEACON_EFFECTS.SPIN, BEACON_EFFECTS.STROBE].includes(effect)) {
            throw new Error(`Unsupported beacon pulse effect: ${effect}`);
        }
        const duration = Math.max(1, Math.trunc(Number(durationMs) || 0));
        const expiresAt = this.now() + duration;
        const existingPulse = this.pulses.find((pulse) =>
            pulse.effect === effect && pulse.reason === reason);
        if (existingPulse) {
            existingPulse.expiresAt = Math.max(existingPulse.expiresAt, expiresAt);
            existingPulse.sequence = this.nextPulseSequence++;
        } else {
            this.pulses.push({
                effect,
                reason,
                expiresAt,
                sequence: this.nextPulseSequence++
            });
        }
        this.logger?.info?.("Beacon pulse", { effect, durationMs: duration, reason });
        this.schedulePulseExpiry();
        this.reconcile();
        return this.getStatus();
    }

    stopAll(reason = null) {
        this.baseEffect = BEACON_EFFECTS.OFF;
        this.baseReason = null;
        this.pulses = [];
        this.clearPulseTimer();
        this.clearRetryTimer();
        this.logger?.info?.("Beacon stop", { reason });
        this.reconcile({ allowScan: false });
        return this.getStatus();
    }

    disconnect(reason = null) {
        const stopWasWritten = Boolean(this.device && this.activeEffect !== BEACON_EFFECTS.OFF);
        this.stopAll(reason);
        this.confirmStopBeforeClose(stopWasWritten ? 2 : 3);
        this.closeDevice();
        return this.emitStatus();
    }

    destroy(reason = "application_exit") {
        if (this.destroyed) {
            return this.getStatus();
        }
        const stopWasWritten = Boolean(this.device && this.activeEffect !== BEACON_EFFECTS.OFF);
        this.stopAll(reason);
        this.confirmStopBeforeClose(stopWasWritten ? 2 : 3);
        this.destroyed = true;
        this.closeDevice();
        this.clearKeepAlive();
        this.clearPulseTimer();
        this.clearRetryTimer();
        return this.emitStatus({ available: false });
    }

    desiredState() {
        const currentTime = this.now();
        this.pulses = this.pulses.filter((pulse) => pulse.expiresAt > currentTime);
        const candidates = [
            { effect: this.baseEffect, reason: this.baseReason, sequence: 0 },
            ...this.pulses
        ];
        return candidates.reduce((highest, candidate) => {
            const priorityDelta = EFFECT_PRIORITY[candidate.effect] - EFFECT_PRIORITY[highest.effect];
            if (priorityDelta > 0 || (priorityDelta === 0 && candidate.sequence > highest.sequence)) {
                return candidate;
            }
            return highest;
        }, { effect: BEACON_EFFECTS.OFF, reason: null, sequence: -1 });
    }

    desiredEffect() {
        return this.desiredState().effect;
    }

    reconcile({ allowScan = true, forceWrite = false } = {}) {
        if (this.destroyed) {
            return;
        }
        const desiredState = this.desiredState();
        const desired = desiredState.effect;
        this.schedulePulseExpiry();

        if (desired === BEACON_EFFECTS.OFF) {
            this.clearKeepAlive();
            this.clearRetryTimer();
            if (this.device && (forceWrite || this.activeEffect !== BEACON_EFFECTS.OFF)) {
                if (this.writeEffect(BEACON_EFFECTS.OFF, null)) {
                    this.scheduleStopConfirmations();
                }
            } else {
                this.activeEffect = BEACON_EFFECTS.OFF;
                this.activeReason = null;
                this.emitStatus();
            }
            return;
        }

        this.clearStopConfirmations();
        if (!this.device && allowScan) {
            this.tryOpenDevice();
        }
        if (!this.device) {
            this.activeEffect = BEACON_EFFECTS.OFF;
            this.activeReason = null;
            this.emitStatus();
            this.scheduleRetry();
            return;
        }

        this.clearRetryTimer();
        if (forceWrite || this.activeEffect !== desired) {
            if (!this.writeEffect(desired, desiredState.reason)) {
                return;
            }
        } else {
            this.activeReason = desiredState.reason;
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

    writeEffect(effect, reason = this.activeReason) {
        if (!this.device) {
            return false;
        }
        try {
            const changed = effect !== this.activeEffect || reason !== this.activeReason;
            const written = this.device.write(getBeaconReport(effect));
            if (Number.isFinite(Number(written)) && Number(written) <= 0) {
                throw new Error("USB HID write returned no bytes.");
            }
            this.activeEffect = effect;
            this.activeReason = effect === BEACON_EFFECTS.OFF ? null : reason;
            if (changed) {
                this.logger?.info?.("Beacon effect applied", {
                    effect: this.activeEffect,
                    reason: this.activeReason
                });
            }
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
        this.clearStopConfirmations();
        this.closeDevice();
        this.activeEffect = BEACON_EFFECTS.OFF;
        this.activeReason = null;
        this.emitStatus({ connected: false, lastError: message });
        this.scheduleRetry();
    }

    closeDevice() {
        const device = this.device;
        this.device = null;
        this.deviceInfo = null;
        this.activeEffect = BEACON_EFFECTS.OFF;
        this.activeReason = null;
        this.clearKeepAlive();
        this.clearStopConfirmations();
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
                this.writeEffect(this.activeEffect, this.activeReason);
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
        const expiries = this.pulses
            .map((pulse) => pulse.expiresAt)
            .filter((expiry) => expiry > currentTime);
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

    scheduleStopConfirmations() {
        this.clearStopConfirmations();
        for (const delay of [100, 500]) {
            const timer = this.setTimeoutFn(() => {
                this.stopConfirmTimers.delete(timer);
                if (
                    !this.destroyed &&
                    this.device &&
                    this.activeEffect === BEACON_EFFECTS.OFF &&
                    this.desiredEffect() === BEACON_EFFECTS.OFF
                ) {
                    this.writeEffect(BEACON_EFFECTS.OFF, null);
                }
            }, delay);
            this.stopConfirmTimers.add(timer);
        }
    }

    confirmStopBeforeClose(count) {
        this.clearStopConfirmations();
        for (let index = 0; index < count && this.device; index += 1) {
            if (!this.writeEffect(BEACON_EFFECTS.OFF, null)) break;
        }
    }

    clearStopConfirmations() {
        for (const timer of this.stopConfirmTimers) {
            this.clearTimeoutFn(timer);
        }
        this.stopConfirmTimers.clear();
    }
}
