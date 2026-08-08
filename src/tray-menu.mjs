function beaconStatusLabel(status = {}, enabled = true) {
    if (!enabled) return "Beacon: Disabled";
    if (status.connected && status.effect && status.effect !== "off") {
        return `Beacon: ${status.effect === "strobe" ? "Strobing" : "Spinning"}`;
    }
    if (status.connected) return "Beacon: Ready";
    if (status.detected) return "Beacon: Detected, unavailable";
    return "Beacon: Not found";
}

function journalStatusLabel(status = {}) {
    switch (status.state) {
        case "watching": return "Journal: Watching";
        case "retrying": return "Journal: Retrying";
        case "starting": return "Journal: Starting";
        default: return "Journal: Stopped";
    }
}

function eliteProcessStatusLabel(status = {}) {
    if (status.state === "stopped") return "Elite Dangerous: Not monitored";
    if (status.running === true) return "Elite Dangerous: Running";
    if (status.state === "error") return "Elite Dangerous: Process check unavailable";
    if (status.running === false) return "Elite Dangerous: Not running";
    return "Elite Dangerous: Checking";
}

function g560StatusLabel(status = {}, enabled = true) {
    const provider = status.provider ?? status;
    if (!enabled) return "G560: Disabled";
    if (provider.connected) return "G560: Connected";
    if (provider.detected) return "G560: Detected, G HUB unavailable";
    if (provider.available === false && provider.lastError) return "G560: Unavailable";
    return "G560: Not found";
}

const TRIGGER_REASON_LABELS = Object.freeze({
    DockingGranted: "Docking granted",
    Undocked: "Undocked",
    Interdicted: "Interdicted",
    UnderAttack: "Under attack",
    HeatWarning: "Heat warning",
    HeatDamage: "Heat damage",
    CockpitBreached: "Cockpit breached",
    HullDamage: "Hull at or below 50%",
    tray_test: "Manual tray test"
});

function triggerReasonLabel(reason) {
    if (!reason) return null;
    return TRIGGER_REASON_LABELS[reason] ?? String(reason);
}

export function buildTrayMenuTemplate({ settings = {}, runtime = {}, actions = {} } = {}) {
    const masterEnabled = settings.enabled !== false;
    const g560Enabled = settings.g560Enabled !== false;
    const beacon = runtime.beaconStatus ?? {};
    const eliteProcess = runtime.eliteProcessStatus ?? {};
    const journal = runtime.journalStatus ?? {};
    const lighting = runtime.lightingStatus ?? {};
    const triggerReason = beacon.effect && beacon.effect !== "off"
        ? triggerReasonLabel(beacon.triggerReason)
        : null;
    const lightingLayers = Array.isArray(lighting.activeLayers)
        ? lighting.activeLayers.slice(0, 3).map((layer) => layer.label ?? layer.sceneId).filter(Boolean)
        : [];
    const lightingReason = lighting.dominantCue?.reason
        ? triggerReasonLabel(lighting.dominantCue.reason)
        : null;
    const brightness = Number(settings.g560Brightness) || 0.75;
    return [
        { label: "ED Beacon Companion", enabled: false },
        { label: beaconStatusLabel(beacon, masterEnabled), enabled: false },
        ...(triggerReason ? [{ label: `Triggered by: ${triggerReason}`, enabled: false }] : []),
        { label: eliteProcessStatusLabel(eliteProcess), enabled: false },
        { label: journalStatusLabel(journal), enabled: false },
        ...(beacon.lastError ? [{ label: `Error: ${beacon.lastError}`, enabled: false }] : []),
        { type: "separator" },
        { label: g560StatusLabel(lighting, masterEnabled && g560Enabled), enabled: false },
        ...(lighting.baseLabel ? [{ label: `Scene: ${lighting.baseLabel}`, enabled: false }] : []),
        ...(lighting.baseReason && lighting.baseReason !== lighting.baseLabel
            ? [{ label: `Environment: ${lighting.baseReason}`, enabled: false }]
            : []),
        ...(lightingLayers.length ? [{ label: `Layers: ${lightingLayers.join(" + ")}`, enabled: false }] : []),
        ...(lightingReason ? [{ label: `Lighting cue: ${lightingReason}`, enabled: false }] : []),
        ...(lighting.lastError ? [{ label: `Lighting error: ${lighting.lastError}`, enabled: false }] : []),
        { type: "separator" },
        {
            label: "Enabled",
            type: "checkbox",
            checked: settings.enabled !== false,
            click: (item) => actions.setEnabled?.(item.checked)
        },
        {
            label: "Launch at Login",
            type: "checkbox",
            checked: settings.launchAtLogin === true,
            click: (item) => actions.setLaunchAtLogin?.(item.checked)
        },
        {
            label: "G560 Lighting",
            type: "checkbox",
            checked: settings.g560Enabled !== false,
            click: (item) => actions.setG560Enabled?.(item.checked)
        },
        {
            label: "G560 Brightness",
            submenu: [0.35, 0.55, 0.75, 1].map((level) => ({
                label: `${Math.round(level * 100)}%`,
                type: "radio",
                checked: Math.abs(brightness - level) < 0.01,
                click: () => actions.setG560Brightness?.(level)
            }))
        },
        {
            label: "Reduced Flashing",
            type: "checkbox",
            checked: settings.reducedFlashing === true,
            click: (item) => actions.setReducedFlashing?.(item.checked)
        },
        { type: "separator" },
        { label: "Rescan Beacon", enabled: masterEnabled, click: () => actions.rescan?.() },
        { label: "Test Spin (3 seconds)", enabled: masterEnabled, click: () => actions.testSpin?.() },
        { label: "Test Strobe (3 seconds)", enabled: masterEnabled, click: () => actions.testStrobe?.() },
        { label: "Rescan G560", enabled: masterEnabled && g560Enabled, click: () => actions.rescanG560?.() },
        {
            label: "Preview G560 Scene",
            submenu: [
                ["Deep-space Flight", "normal_flight"],
                ["Supercruise", "supercruise"],
                ["Witchspace", "witchspace"],
                ["Docking Clearance", "docking_clearance"],
                ["Combat", "combat_ambience"],
                ["Heat Warning", "overheat"]
            ].map(([label, sceneId]) => ({
                label,
                enabled: masterEnabled && g560Enabled,
                click: () => actions.previewG560?.(sceneId)
            }))
        },
        { label: "Restore G HUB Lighting", click: () => actions.restoreG560?.() },
        { label: "Windows Dynamic Lighting", click: () => actions.openDynamicLighting?.() },
        { label: "Stop Now", click: () => actions.stopNow?.() },
        { type: "separator" },
        { label: "Developer Monitor", click: () => actions.openDeveloperMonitor?.() },
        { label: "Open Logs", click: () => actions.openLogs?.() },
        { label: "About", click: () => actions.showAbout?.() },
        { label: "Quit", click: () => actions.quit?.() }
    ];
}
