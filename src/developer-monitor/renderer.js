const zones = ["leftRear", "rightRear", "leftFront", "rightFront"];

function byId(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    byId(id).textContent = value ?? "—";
}

function sentence(value) {
    const text = String(value ?? "").replaceAll("_", " ").trim();
    return text ? text[0].toUpperCase() + text.slice(1) : "Unknown";
}

function ago(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return "—";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
    if (seconds < 2) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
    return new Date(timestamp).toLocaleString();
}

function setDot(id, state) {
    byId(id).className = `status-dot ${state}`;
}

function deviceState({ connected, detected, state, enabled = true, running = null } = {}) {
    if (!enabled) return ["Disabled", "bad"];
    if (running === true) return ["Running", "good"];
    if (running === false) return ["Not running", "bad"];
    if (connected) return ["Connected", "good"];
    if (state === "watching") return ["Watching", "good"];
    if (state === "retrying" || state === "starting" || detected) return [sentence(state === "retrying" ? "retrying" : state || "detected"), "warning"];
    return [sentence(state || "not found"), "bad"];
}

function renderLayers(snapshot) {
    const container = byId("layers");
    const entries = [];
    if (snapshot.lighting.baseScene) {
        entries.push({
            type: "base",
            label: snapshot.lighting.baseLabel || snapshot.lighting.baseScene,
            sceneId: snapshot.lighting.baseScene,
            reason: snapshot.lighting.baseReason || "Persistent world scene"
        });
    }
    for (const layer of snapshot.lighting.activeLayers) entries.push({ ...layer, type: "overlay" });
    setText("layer-count", String(entries.length));
    container.replaceChildren();

    if (entries.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No lighting layers are active.";
        container.append(empty);
        return;
    }

    for (const entry of entries) {
        const card = document.createElement("article");
        card.className = `layer ${entry.type}`;
        const top = document.createElement("div");
        top.className = "layer-top";
        const label = document.createElement("strong");
        label.textContent = entry.label || entry.sceneId || "Unknown layer";
        const id = document.createElement("code");
        id.textContent = entry.sceneId || "—";
        top.append(label, id);
        const reason = document.createElement("p");
        const remaining = Number.isFinite(entry.remainingMs)
            ? ` · ${(entry.remainingMs / 1_000).toFixed(1)}s remaining`
            : "";
        reason.textContent = `${entry.reason || (entry.type === "base" ? "Persistent world scene" : "Active cue")}${remaining}`;
        card.append(top, reason);
        container.append(card);
    }
}

function render(snapshot) {
    const lighting = snapshot.lighting;
    const cue = lighting.dominantCue;
    const currentLabel = cue?.label || lighting.baseLabel || "No active lighting";
    const currentReason = cue?.reason || lighting.baseReason || (snapshot.game.running ? "Waiting for lighting state." : "Elite Dangerous is not active.");
    const layerIds = lighting.activeLayers.map((layer) => layer.sceneId).filter(Boolean);

    setText("current-scene", currentLabel);
    setText("current-reason", currentReason);
    setText("scene-id", cue?.sceneId || lighting.baseScene || "—");
    setText("brightness", `${Math.round(snapshot.app.brightness * 100)}%`);
    setText("reduced-flashing", snapshot.app.reducedFlashing ? "On" : "Off");
    setText("feedback-line", `scene: ${lighting.baseScene || "none"} · cue: ${cue?.sceneId || "none"} · layers: ${layerIds.join(", ") || "none"}`);

    for (const zone of zones) {
        const hex = lighting.zoneColours[zone] || "#000000";
        const element = byId(`zone-${zone}`);
        element.style.backgroundColor = hex;
        element.style.setProperty("--zone-glow", `${hex}55`);
        setText(`hex-${zone}`, hex.toUpperCase());
    }
    document.documentElement.style.setProperty("--scene-glow", lighting.zoneColours.leftRear || "#ff7100");
    renderLayers(snapshot);

    const [gameText, gameState] = deviceState({ enabled: snapshot.app.enabled, running: snapshot.game.running, state: snapshot.game.state });
    const [journalText, journalState] = deviceState({ enabled: snapshot.app.enabled, state: snapshot.journal.state });
    const [g560Text, g560State] = deviceState({ enabled: snapshot.app.enabled && snapshot.app.g560Enabled, ...lighting.provider });
    const [beaconText, beaconState] = deviceState({ enabled: snapshot.app.enabled, connected: snapshot.beacon.connected, detected: snapshot.beacon.detected, state: snapshot.beacon.connected ? "connected" : snapshot.beacon.detected ? "detected" : "not found" });
    setText("game-status", gameText); setDot("game-dot", gameState);
    setText("journal-status", journalText); setDot("journal-dot", journalState);
    setText("g560-status", g560Text); setDot("g560-dot", g560State);
    setText("beacon-status", snapshot.beacon.effect !== "off" ? `${beaconText} · ${sentence(snapshot.beacon.effect)}` : beaconText); setDot("beacon-dot", beaconState);

    setText("last-event", snapshot.journal.lastEvent || "No journal event yet");
    setText("last-event-time", ago(snapshot.journal.lastEventAt));
    setText("beacon-trigger", snapshot.beacon.triggerReason || "None");
    setText("frames-rendered", lighting.framesRendered.toLocaleString());
    setText("frames-written", lighting.framesWritten.toLocaleString());
    setText("frames-deduplicated", lighting.framesDeduplicated.toLocaleString());
    const liveState = byId("live-state");
    if (!snapshot.app.enabled) {
        liveState.dataset.state = "idle";
        setText("live-label", "Companion disabled");
    } else if (snapshot.game.running && lighting.sessionActive) {
        liveState.dataset.state = lighting.provider.connected ? "live" : "warning";
        setText("live-label", lighting.provider.connected ? "Live output" : "Scene active · G560 offline");
    } else {
        liveState.dataset.state = "idle";
        setText("live-label", snapshot.game.running ? "Waiting for scene" : "Game not running");
    }
}

let unsubscribe = () => {};
if (window.edBeaconMonitor) {
    unsubscribe = window.edBeaconMonitor.onSnapshot(render);
    window.edBeaconMonitor.requestSnapshot().then(render).catch(() => {
        setText("live-label", "Unable to read app state");
    });
}
window.addEventListener("beforeunload", () => unsubscribe(), { once: true });
