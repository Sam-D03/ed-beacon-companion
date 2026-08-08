const BLACK_ZONES = Object.freeze({
    leftRear: "#000000",
    leftFront: "#000000",
    rightFront: "#000000",
    rightRear: "#000000"
});

function text(value, fallback = null) {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function statusFlag(value) {
    return value === true ? true : value === false ? false : null;
}

function colour(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    return /^#[0-9a-f]{6}$/u.test(normalized) ? normalized : "#000000";
}

function layer(layer = {}) {
    return {
        key: text(layer.key),
        sceneId: text(layer.sceneId),
        label: text(layer.label, text(layer.sceneId, "Unknown layer")),
        reason: text(layer.reason),
        source: text(layer.source),
        remainingMs: finite(layer.remainingMs)
    };
}

export function buildDeveloperMonitorSnapshot({
    version = null,
    settings = {},
    runtime = {},
    lightingStatus = null,
    now = Date.now
} = {}) {
    const beacon = runtime.beaconStatus ?? {};
    const game = runtime.eliteProcessStatus ?? {};
    const journal = runtime.journalStatus ?? {};
    const lighting = lightingStatus ?? runtime.lightingStatus ?? {};
    const provider = lighting.provider ?? {};
    const zones = lighting.zoneColours ?? BLACK_ZONES;

    return {
        generatedAt: new Date(now()).toISOString(),
        version: text(version),
        app: {
            enabled: settings.enabled !== false,
            g560Enabled: settings.g560Enabled !== false,
            brightness: finite(settings.g560Brightness, 0.75),
            reducedFlashing: settings.reducedFlashing === true
        },
        game: {
            running: statusFlag(game.running),
            state: text(game.state, "unknown"),
            lastError: text(game.lastError)
        },
        journal: {
            state: text(journal.state, "stopped"),
            directory: text(journal.directory),
            lastEvent: text(journal.lastEvent),
            lastEventAt: text(journal.lastEventAt),
            retryInMs: finite(journal.retryInMs),
            lastError: text(journal.lastError)
        },
        beacon: {
            available: statusFlag(beacon.available),
            detected: statusFlag(beacon.detected),
            connected: beacon.connected === true,
            effect: text(beacon.effect, "off"),
            baseEffect: text(beacon.baseEffect, "off"),
            triggerReason: text(beacon.triggerReason),
            deviceName: text(beacon.deviceName),
            lastCommandAt: text(beacon.lastCommandAt),
            lastError: text(beacon.lastError)
        },
        lighting: {
            enabled: lighting.enabled === true,
            sessionActive: lighting.sessionActive === true,
            baseScene: text(lighting.baseScene),
            baseLabel: text(lighting.baseLabel),
            baseReason: text(lighting.baseReason),
            dominantCue: lighting.dominantCue ? layer(lighting.dominantCue) : null,
            activeLayers: Array.isArray(lighting.activeLayers)
                ? lighting.activeLayers.map(layer)
                : [],
            zoneColours: Object.fromEntries(Object.keys(BLACK_ZONES).map((zone) => [
                zone,
                colour(zones[zone])
            ])),
            framesRendered: finite(lighting.framesRendered, 0),
            framesWritten: finite(lighting.framesWritten, 0),
            framesDeduplicated: finite(lighting.framesDeduplicated, 0),
            targetFps: finite(lighting.targetFps),
            lastFrameAt: text(lighting.lastFrameAt),
            lastError: text(lighting.lastError),
            provider: {
                available: statusFlag(provider.available),
                detected: statusFlag(provider.detected),
                connected: provider.connected === true,
                state: text(provider.state, "idle"),
                sdkVersion: text(provider.sdkVersion),
                lastFrameAt: text(provider.lastFrameAt),
                lastError: text(provider.lastError)
            }
        }
    };
}
