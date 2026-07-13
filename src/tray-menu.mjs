function beaconStatusLabel(status = {}) {
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

export function buildTrayMenuTemplate({ settings = {}, runtime = {}, actions = {} } = {}) {
    const beacon = runtime.beaconStatus ?? {};
    const journal = runtime.journalStatus ?? {};
    return [
        { label: "ED Beacon Companion", enabled: false },
        { label: beaconStatusLabel(beacon), enabled: false },
        { label: journalStatusLabel(journal), enabled: false },
        ...(beacon.lastError ? [{ label: `Error: ${beacon.lastError}`, enabled: false }] : []),
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
        { type: "separator" },
        { label: "Rescan Beacon", click: () => actions.rescan?.() },
        { label: "Test Spin (3 seconds)", click: () => actions.testSpin?.() },
        { label: "Test Strobe (3 seconds)", click: () => actions.testStrobe?.() },
        { label: "Stop Now", click: () => actions.stopNow?.() },
        { type: "separator" },
        { label: "Open Logs", click: () => actions.openLogs?.() },
        { label: "About", click: () => actions.showAbout?.() },
        { label: "Quit", click: () => actions.quit?.() }
    ];
}
