import { performance } from "node:perf_hooks";

import {
    BLACK_FRAME,
    compositeFrame,
    frameToHex,
    frameToPercentages,
    mixFrames,
    percentageFramesEqual
} from "./lighting-color.mjs";
import { deriveSeed, smoothstep } from "./lighting-random.mjs";
import { getLightingScene, sampleLightingScene } from "./lighting-scene-catalog.mjs";

function errorMessage(error, fallback = "Unknown lighting error.") {
    return String(error?.message ?? error ?? fallback).trim() || fallback;
}

function descriptorKey(descriptor) {
    return String(descriptor?.key ?? descriptor?.sceneId ?? "").trim();
}

function normalizeLayerDescriptor(descriptor = {}) {
    const key = descriptorKey(descriptor);
    const sceneId = String(descriptor.sceneId ?? "").trim();
    if (!key || !sceneId) return null;
    const scene = getLightingScene(sceneId);
    return {
        key,
        sceneId,
        label: descriptor.label ?? scene.label,
        priority: Number(descriptor.priority) || 0,
        blend: descriptor.blend ?? null,
        opacity: descriptor.opacity == null ? 1 : Number(descriptor.opacity),
        dimUnderlay: descriptor.dimUnderlay ?? null,
        exclusiveGroup: descriptor.exclusiveGroup ?? null,
        context: descriptor.context ?? {},
        reason: descriptor.reason ?? null,
        source: descriptor.source ?? "status"
    };
}

export class LightingEngine {
    constructor({
        provider,
        logger = null,
        onStatusChange = null,
        frameIntervalMs = 34,
        brightness = 0.85,
        reducedFlashing = false,
        zoneGains = {
            leftFront: 0.88,
            rightFront: 0.88,
            leftRear: 1,
            rightRear: 1
        },
        installSeed = 0x45444342,
        now = () => performance.now(),
        wallNow = Date.now,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    } = {}) {
        if (!provider || typeof provider.connect !== "function" || typeof provider.writeFrame !== "function") {
            throw new Error("LightingEngine requires a lighting provider.");
        }
        this.provider = provider;
        this.logger = logger;
        this.onStatusChange = onStatusChange;
        this.frameIntervalMs = Math.max(33.34, Number(frameIntervalMs) || 34);
        this.brightness = Math.min(1, Math.max(0.05, Number(brightness) || 0.85));
        this.reducedFlashing = reducedFlashing === true;
        this.zoneGains = { ...zoneGains };
        this.installSeed = Number(installSeed) >>> 0;
        this.sessionSeed = deriveSeed(this.installSeed, Date.now(), process.pid);
        this.now = now;
        this.wallNow = wallNow;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;

        this.enabled = true;
        this.sessionActive = false;
        this.destroyed = false;
        this.base = null;
        this.baseTransition = null;
        this.persistentLayers = new Map();
        this.transientLayers = [];
        this.activationSequence = 1;
        this.timer = null;
        this.tickInFlight = false;
        this.nextDeadline = null;
        this.connectPromise = null;
        this.releasePromise = null;
        this.lastWrittenPercentages = null;
        this.lastOutputFrame = null;
        this.lastOutputAt = null;
        this.retryIndex = 0;
        this.retryAt = 0;
        this.retryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000];
        this.lastSemanticSignature = "";
        this.lastMetricsEmitAt = 0;
        this.status = {
            enabled: true,
            reducedFlashing: this.reducedFlashing,
            sessionActive: false,
            baseScene: null,
            baseLabel: null,
            baseReason: null,
            activeLayers: [],
            dominantCue: null,
            zoneColours: frameToHex(BLACK_FRAME),
            framesRendered: 0,
            framesWritten: 0,
            framesDeduplicated: 0,
            targetFps: Math.round(1_000 / this.frameIntervalMs),
            lastFrameAt: null,
            lastError: null,
            provider: provider.getStatus?.() ?? { connected: false }
        };
    }

    getStatus() {
        return {
            ...this.status,
            activeLayers: this.status.activeLayers.map((layer) => ({ ...layer })),
            zoneColours: { ...this.status.zoneColours },
            provider: { ...(this.provider.getStatus?.() ?? this.status.provider) }
        };
    }

    emitStatus({ force = false, includeMetrics = false } = {}) {
        const status = this.getStatus();
        const semantic = JSON.stringify({
            enabled: status.enabled,
            reducedFlashing: status.reducedFlashing,
            sessionActive: status.sessionActive,
            baseScene: status.baseScene,
            baseReason: status.baseReason,
            activeLayers: status.activeLayers.map(({ key, sceneId, reason }) => ({ key, sceneId, reason })),
            dominantCue: status.dominantCue
                ? {
                    key: status.dominantCue.key,
                    sceneId: status.dominantCue.sceneId,
                    reason: status.dominantCue.reason,
                    source: status.dominantCue.source
                }
                : null,
            provider: {
                available: status.provider?.available,
                detected: status.provider?.detected,
                connected: status.provider?.connected,
                state: status.provider?.state,
                lastError: status.provider?.lastError
            },
            lastError: status.lastError
        });
        if (!force && semantic === this.lastSemanticSignature && !includeMetrics) return status;
        this.lastSemanticSignature = semantic;
        try {
            this.onStatusChange?.(status);
        } catch (error) {
            this.logger?.warn?.("Lighting status listener failed", errorMessage(error));
        }
        return status;
    }

    setEnabled(enabled) {
        this.enabled = enabled === true;
        this.status.enabled = this.enabled;
        if (!this.enabled) {
            void this.release("lighting_disabled");
        } else {
            this.ensureTicking();
        }
        this.emitStatus({ force: true });
    }

    setBrightness(brightness) {
        this.brightness = Math.min(1, Math.max(0.05, Number(brightness) || this.brightness));
        this.lastWrittenPercentages = null;
        this.ensureTicking();
    }

    setReducedFlashing(enabled) {
        this.reducedFlashing = enabled === true;
        this.status.reducedFlashing = this.reducedFlashing;
        this.lastOutputFrame = null;
        this.lastOutputAt = null;
        this.lastWrittenPercentages = null;
        this.ensureTicking();
        this.emitStatus({ force: true });
    }

    async rescanProvider() {
        const detected = await this.provider.rescan?.();
        this.retryIndex = 0;
        this.retryAt = 0;
        this.status.lastError = null;
        this.ensureTicking();
        this.emitStatus({ force: true });
        return detected;
    }

    beginSession(seedHint = Date.now()) {
        this.sessionSeed = deriveSeed(this.installSeed, seedHint, this.activationSequence++);
        this.clearScenes();
        this.setSessionActive(true);
    }

    setSessionActive(active) {
        const next = active === true;
        if (this.sessionActive === next) return;
        this.sessionActive = next;
        this.status.sessionActive = next;
        if (!next) {
            this.clearScenes();
            void this.release("game_inactive");
        } else {
            this.ensureTicking();
        }
        this.emitStatus({ force: true });
    }

    setBaseScene(sceneId, {
        reason = null,
        context = {},
        transitionMs = null
    } = {}) {
        const id = String(sceneId || "idle");
        const nowMs = this.now();
        if (this.base?.sceneId === id) {
            this.base.context = { ...context };
            this.base.reason = reason;
            this.status.baseReason = reason;
            return;
        }
        const previousFrame = this.base ? this.renderBase(nowMs) : BLACK_FRAME;
        const scene = getLightingScene(id);
        this.base = {
            sceneId: id,
            label: scene.label,
            reason,
            context: { ...context },
            enteredAt: nowMs,
            seed: deriveSeed(this.sessionSeed, id, this.activationSequence++)
        };
        const duration = Math.max(0, Number(transitionMs ?? scene.enterMs) || 0);
        this.baseTransition = duration > 0
            ? { fromFrame: previousFrame, startedAt: nowMs, durationMs: duration }
            : null;
        this.status.baseScene = id;
        this.status.baseLabel = scene.label;
        this.status.baseReason = reason;
        this.logger?.info?.("Lighting base scene", { scene: id, reason });
        this.ensureTicking();
        this.updateSemanticStatus(nowMs);
    }

    setPersistentLayers(descriptors = []) {
        const nowMs = this.now();
        const next = new Map();
        for (const raw of descriptors) {
            const descriptor = normalizeLayerDescriptor(raw);
            if (!descriptor) continue;
            next.set(descriptor.key, descriptor);
            const current = this.persistentLayers.get(descriptor.key);
            if (current && current.sceneId === descriptor.sceneId && current.exitingAt == null) {
                Object.assign(current, descriptor, { context: { ...descriptor.context } });
                continue;
            }
            if (current) {
                // A semantic slot can legitimately change scenes (for example
                // docking request -> clearance). Retire the old look under an
                // internal key so its release envelope crossfades against the
                // replacement's attack instead of exposing the bare base.
                const replacementGroup = descriptor.exclusiveGroup ??
                    current.exclusiveGroup ??
                    `replacement:${descriptor.key}`;
                const retiringKey = `${descriptor.key}:retiring:${this.activationSequence++}`;
                this.beginLayerExit(current, nowMs);
                this.persistentLayers.delete(descriptor.key);
                this.persistentLayers.set(retiringKey, {
                    ...current,
                    key: retiringKey,
                    exclusiveGroup: replacementGroup,
                    exitingAt: current.exitingAt
                });
                descriptor.exclusiveGroup = replacementGroup;
            }
            this.persistentLayers.set(descriptor.key, {
                ...descriptor,
                enteredAt: nowMs,
                exitingAt: null,
                seed: deriveSeed(this.sessionSeed, descriptor.key, descriptor.sceneId, this.activationSequence++)
            });
            this.logger?.info?.("Lighting layer activated", {
                scene: descriptor.sceneId,
                reason: descriptor.reason,
                source: descriptor.source
            });
        }
        for (const [key, layer] of this.persistentLayers) {
            if (!next.has(key) && layer.exitingAt == null) {
                this.beginLayerExit(layer, nowMs);
                this.logger?.info?.("Lighting layer released", { scene: layer.sceneId, reason: layer.reason });
            }
        }
        this.ensureTicking();
        this.updateSemanticStatus(nowMs);
    }

    triggerOverlay(sceneId, {
        key = null,
        durationMs = 2_500,
        priority = 500,
        exclusiveGroup = null,
        blend = null,
        opacity = 1,
        dimUnderlay = null,
        context = {},
        reason = null,
        source = "journal",
        retrigger = "restart"
    } = {}) {
        const nowMs = this.now();
        const id = String(sceneId);
        const stableKey = key ? String(key) : null;
        if (stableKey) {
            const existing = this.transientLayers.find((layer) => layer.key === stableKey && layer.expiresAt > nowMs);
            if (existing) {
                existing.expiresAt = Math.max(existing.expiresAt, nowMs + durationMs);
                existing.context = { ...context };
                existing.reason = reason;
                existing.exitingAt = null;
                delete existing.exitStartEnvelope;
                if (retrigger === "restart") existing.enteredAt = nowMs;
                this.ensureTicking();
                this.updateSemanticStatus(nowMs);
                return existing;
            }
        }
        const scene = getLightingScene(id);
        const layer = {
            key: stableKey ?? `transient:${id}:${this.activationSequence}`,
            sceneId: id,
            label: scene.label,
            priority,
            exclusiveGroup,
            blend,
            opacity,
            dimUnderlay,
            context: { ...context },
            reason,
            source,
            enteredAt: nowMs,
            exitingAt: null,
            expiresAt: nowMs + Math.max(1, Number(durationMs) || 1),
            durationMs: Math.max(1, Number(durationMs) || 1),
            seed: deriveSeed(this.sessionSeed, id, reason, this.activationSequence++)
        };
        this.transientLayers.push(layer);
        if (this.transientLayers.length > 24) {
            this.transientLayers.splice(0, this.transientLayers.length - 24);
        }
        this.logger?.info?.("Lighting cue", { scene: id, reason, durationMs: layer.durationMs });
        this.ensureTicking();
        this.updateSemanticStatus(nowMs);
        return layer;
    }

    clearTransientLayers({ source = null, key = null, immediate = false } = {}) {
        const nowMs = this.now();
        let matched = 0;
        this.transientLayers = this.transientLayers.filter((layer) => {
            if (source && layer.source !== source) return true;
            if (key && layer.key !== key) return true;
            matched += 1;
            if (immediate) return false;
            this.beginLayerExit(layer, nowMs);
            return true;
        });
        if (matched > 0) {
            this.ensureTicking();
            this.updateSemanticStatus(nowMs);
        }
        return matched;
    }

    clearScenes() {
        this.base = null;
        this.baseTransition = null;
        this.persistentLayers.clear();
        this.transientLayers = [];
        this.status.baseScene = null;
        this.status.baseLabel = null;
        this.status.baseReason = null;
        this.status.activeLayers = [];
        this.status.dominantCue = null;
    }

    renderBase(nowMs) {
        if (!this.base) return BLACK_FRAME;
        const current = sampleLightingScene(this.base.sceneId, {
            elapsedMs: nowMs - this.base.enteredAt,
            nowMs,
            wallNowMs: this.wallNow(),
            seed: this.base.seed,
            context: this.base.context
        }).frame;
        if (!this.baseTransition) return current;
        const amount = smoothstep((nowMs - this.baseTransition.startedAt) / this.baseTransition.durationMs);
        if (amount >= 1) {
            this.baseTransition = null;
            return current;
        }
        return mixFrames(this.baseTransition.fromFrame, current, amount);
    }

    candidateLayerInstances(nowMs) {
        for (const [key, layer] of this.persistentLayers) {
            if (layer.exitingAt == null) continue;
            const exitMs = getLightingScene(layer.sceneId).exitMs;
            if (nowMs - layer.exitingAt >= exitMs) this.persistentLayers.delete(key);
        }
        this.transientLayers = this.transientLayers.filter((layer) => {
            if (layer.exitingAt == null) return layer.expiresAt > nowMs;
            return nowMs - layer.exitingAt < getLightingScene(layer.sceneId).exitMs;
        });
        return [...this.persistentLayers.values(), ...this.transientLayers]
            .filter((layer) => layer.enteredAt <= nowMs);
    }

    activeLayerInstances(nowMs) {
        const candidates = this.candidateLayerInstances(nowMs)
            .filter((layer) => layer.exitingAt == null);
        const groupWinners = new Map();
        for (const layer of candidates) {
            if (!layer.exclusiveGroup) continue;
            const winner = groupWinners.get(layer.exclusiveGroup);
            if (!winner || layer.priority > winner.priority ||
                (layer.priority === winner.priority && layer.enteredAt > winner.enteredAt)) {
                groupWinners.set(layer.exclusiveGroup, layer);
            }
        }
        return candidates
            .filter((layer) => !layer.exclusiveGroup || groupWinners.get(layer.exclusiveGroup) === layer)
            .sort((left, right) => left.priority - right.priority || left.enteredAt - right.enteredAt);
    }

    compositingLayerInstances(nowMs) {
        const candidates = this.candidateLayerInstances(nowMs);
        const weights = new Map();
        const groups = new Map();
        for (const layer of candidates) {
            if (!layer.exclusiveGroup) {
                weights.set(layer, 1);
                continue;
            }
            const members = groups.get(layer.exclusiveGroup) ?? [];
            members.push(layer);
            groups.set(layer.exclusiveGroup, members);
        }
        for (const members of groups.values()) {
            members.sort((left, right) =>
                right.priority - left.priority || right.enteredAt - left.enteredAt);
            let remainder = 1;
            for (const layer of members) {
                weights.set(layer, remainder);
                const envelope = this.layerEnvelope(layer, getLightingScene(layer.sceneId), nowMs);
                remainder *= 1 - envelope;
            }
        }
        return candidates
            .map((layer) => ({ ...layer, exclusiveWeight: weights.get(layer) ?? 1 }))
            .sort((left, right) => left.priority - right.priority || left.enteredAt - right.enteredAt);
    }

    layerEnvelope(layer, scene, nowMs) {
        const attack = scene.enterMs <= 0 ? 1 : smoothstep((nowMs - layer.enteredAt) / scene.enterMs);
        if (layer.exitingAt != null) {
            const release = 1 - smoothstep((nowMs - layer.exitingAt) / Math.max(1, scene.exitMs));
            const start = Number.isFinite(layer.exitStartEnvelope) ? layer.exitStartEnvelope : attack;
            return Math.max(0, Math.min(1, start * release));
        }
        let release = 1;
        if (layer.expiresAt != null) {
            const remaining = layer.expiresAt - nowMs;
            if (remaining < scene.exitMs) release = smoothstep(remaining / Math.max(1, scene.exitMs));
        }
        return Math.max(0, Math.min(1, attack * release));
    }

    beginLayerExit(layer, nowMs) {
        if (layer.exitingAt != null) return;
        const scene = getLightingScene(layer.sceneId);
        layer.exitStartEnvelope = this.layerEnvelope(layer, scene, nowMs);
        layer.exitingAt = nowMs;
    }

    renderFrameAt(nowMs = this.now()) {
        let frame = this.renderBase(nowMs);
        for (const layer of this.compositingLayerInstances(nowMs)) {
            const scene = getLightingScene(layer.sceneId);
            const envelope = this.layerEnvelope(layer, scene, nowMs);
            if (envelope <= 0) continue;
            const sampled = sampleLightingScene(layer.sceneId, {
                elapsedMs: nowMs - layer.enteredAt,
                durationMs: layer.durationMs,
                nowMs,
                wallNowMs: this.wallNow(),
                seed: layer.seed,
                context: layer.context
            });
            frame = compositeFrame(frame, sampled.frame, {
                opacity: sampled.opacity * layer.opacity * envelope * layer.exclusiveWeight,
                blend: layer.blend ?? sampled.blend,
                dimUnderlay: layer.dimUnderlay ?? sampled.dimUnderlay
            });
        }
        return frame;
    }

    prepareOutputFrame(frame, nowMs) {
        if (!this.reducedFlashing) {
            this.lastOutputFrame = frame;
            this.lastOutputAt = nowMs;
            return frame;
        }
        const previous = this.lastOutputFrame ?? BLACK_FRAME;
        const elapsed = this.lastOutputAt == null
            ? this.frameIntervalMs
            : Math.max(1, nowMs - this.lastOutputAt);
        const alpha = 1 - Math.exp(-elapsed / 220);
        const smoothed = mixFrames(previous, frame, alpha);
        this.lastOutputFrame = smoothed;
        this.lastOutputAt = nowMs;
        return smoothed;
    }

    updateSemanticStatus(nowMs = this.now(), frame = null) {
        const layers = this.activeLayerInstances(nowMs)
            .filter((layer) => layer.exitingAt == null)
            .sort((left, right) => right.priority - left.priority || right.enteredAt - left.enteredAt)
            .map((layer) => ({
                key: layer.key,
                sceneId: layer.sceneId,
                label: layer.label,
                reason: layer.reason,
                source: layer.source,
                remainingMs: layer.expiresAt == null ? null : Math.max(0, Math.round(layer.expiresAt - nowMs))
            }));
        this.status.baseScene = this.base?.sceneId ?? null;
        this.status.baseLabel = this.base?.label ?? null;
        this.status.baseReason = this.base?.reason ?? null;
        this.status.activeLayers = layers;
        this.status.dominantCue = layers[0] ?? (this.base ? {
            key: "base",
            sceneId: this.base.sceneId,
            label: this.base.label,
            reason: this.base.reason,
            source: "state"
        } : null);
        if (frame) this.status.zoneColours = frameToHex(frame);
        this.status.provider = this.provider.getStatus?.() ?? this.status.provider;
        this.emitStatus();
    }

    ensureTicking() {
        if (this.timer || this.tickInFlight || this.destroyed || !this.enabled || !this.sessionActive) return;
        this.nextDeadline = this.now();
        this.timer = this.setTimeoutFn(() => void this.tick(), 0);
        this.timer?.unref?.();
    }

    scheduleNextTick() {
        if (this.destroyed || !this.enabled || !this.sessionActive) {
            this.timer = null;
            return;
        }
        const nowMs = this.now();
        this.nextDeadline = Math.max(this.nextDeadline + this.frameIntervalMs, nowMs + 1);
        const delay = Math.max(1, this.nextDeadline - nowMs);
        this.timer = this.setTimeoutFn(() => void this.tick(), delay);
        this.timer?.unref?.();
    }

    async ensureConnected(nowMs) {
        const providerStatus = this.provider.getStatus?.() ?? {};
        if (providerStatus.connected) return true;
        if (nowMs < this.retryAt) return false;
        if (!this.connectPromise) {
            this.connectPromise = Promise.resolve(this.provider.connect())
                .then((connected) => {
                    if (!connected) throw new Error(this.provider.getStatus?.().lastError || "G560 connection failed.");
                    this.retryIndex = 0;
                    this.retryAt = 0;
                    this.lastWrittenPercentages = null;
                    this.status.lastError = null;
                    this.logger?.info?.("G560 lighting connected");
                    return true;
                })
                .catch((error) => {
                    const delay = this.retryDelaysMs[Math.min(this.retryIndex, this.retryDelaysMs.length - 1)];
                    this.retryIndex += 1;
                    this.retryAt = this.now() + delay;
                    this.status.lastError = errorMessage(error);
                    this.logger?.warn?.("G560 lighting connection failed", {
                        detail: this.status.lastError,
                        retryInMs: delay
                    });
                    return false;
                })
                .finally(() => {
                    this.connectPromise = null;
                    this.status.provider = this.provider.getStatus?.() ?? this.status.provider;
                    this.emitStatus({ force: true });
                });
        }
        return this.connectPromise;
    }

    async tick() {
        if (this.tickInFlight) return;
        this.timer = null;
        if (this.destroyed || !this.enabled || !this.sessionActive) return;
        this.tickInFlight = true;
        try {
            const nowMs = this.now();
            const frame = this.prepareOutputFrame(this.renderFrameAt(nowMs), nowMs);
            this.status.framesRendered += 1;
            this.status.lastFrameAt = new Date().toISOString();
            try {
                if (await this.ensureConnected(nowMs)) {
                    const percentages = frameToPercentages(frame, {
                        brightness: this.brightness,
                        zoneGains: this.zoneGains
                    });
                    if (percentageFramesEqual(percentages, this.lastWrittenPercentages)) {
                        this.status.framesDeduplicated += 1;
                    } else {
                        const written = await this.provider.writeFrame(percentages);
                        if (written !== false) {
                            this.lastWrittenPercentages = percentages;
                            this.status.framesWritten += 1;
                        } else {
                            throw new Error(this.provider.getStatus?.().lastError || "G560 rejected lighting frame.");
                        }
                    }
                }
            } catch (error) {
                this.status.lastError = errorMessage(error);
                this.lastWrittenPercentages = null;
                try {
                    await this.provider.release?.("write_failed");
                } catch {
                    // The render loop will retry the provider with bounded backoff.
                }
                this.retryAt = this.now() + this.retryDelaysMs[Math.min(this.retryIndex++, this.retryDelaysMs.length - 1)];
                this.logger?.warn?.("G560 frame failed", this.status.lastError);
            }
            this.updateSemanticStatus(nowMs, frame);
            if (nowMs - this.lastMetricsEmitAt >= 1_000) {
                this.lastMetricsEmitAt = nowMs;
                this.emitStatus({ includeMetrics: true });
            }
        } catch (error) {
            // Scene/render bugs must degrade to restored G HUB lighting, not
            // become an unhandled rejection from a timer callback while the
            // previous physical frame remains latched.
            this.status.lastError = errorMessage(error);
            this.lastWrittenPercentages = null;
            try {
                await this.provider.release?.("render_failed");
            } catch {}
            this.retryAt = this.now() + this.retryDelaysMs[Math.min(this.retryIndex++, this.retryDelaysMs.length - 1)];
            this.logger?.error?.("G560 render loop failed", this.status.lastError);
            this.emitStatus({ force: true });
        } finally {
            this.tickInFlight = false;
            this.scheduleNextTick();
        }
    }

    async release(reason = "release") {
        if (this.timer) {
            this.clearTimeoutFn(this.timer);
            this.timer = null;
        }
        this.nextDeadline = null;
        this.lastWrittenPercentages = null;
        this.lastOutputFrame = null;
        this.lastOutputAt = null;
        if (!this.releasePromise) {
            this.releasePromise = Promise.resolve()
                .then(() => this.provider.release?.(reason))
                .then((released) => released !== false)
                .catch((error) => {
                    this.status.lastError = errorMessage(error);
                    this.logger?.warn?.("G560 lighting release failed", this.status.lastError);
                    return false;
                })
                .finally(() => {
                    this.releasePromise = null;
                    this.status.provider = this.provider.getStatus?.() ?? this.status.provider;
                    this.emitStatus({ force: true });
                });
        }
        return this.releasePromise;
    }

    stopNow(reason = "manual_stop") {
        this.sessionActive = false;
        this.status.sessionActive = false;
        this.clearScenes();
        this.logger?.info?.("Lighting stopped", { reason });
        void this.release(reason);
        this.emitStatus({ force: true });
    }

    async destroy(reason = "application_exit") {
        if (this.destroyed) return;
        this.destroyed = true;
        this.sessionActive = false;
        this.status.sessionActive = false;
        this.clearScenes();
        if (this.timer) this.clearTimeoutFn(this.timer);
        this.timer = null;
        await this.release(reason);
        await this.provider.destroy?.(reason);
        this.emitStatus({ force: true });
    }
}
