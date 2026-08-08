import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RotatingLogger } from "../src/logger.mjs";
import { SettingsStore } from "../src/settings-store.mjs";
import { buildTrayIconDataUrl, buildTrayIconPng, resolveTrayIconState } from "../src/tray-icon.mjs";
import { buildTrayMenuTemplate } from "../src/tray-menu.mjs";

test("persists normalized settings and recovers from invalid JSON", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ed-beacon-settings-"));
    const filePath = path.join(directory, "settings.json");
    const store = new SettingsStore(filePath);
    const initial = await store.load();
    assert.equal(initial.enabled, true);
    assert.equal(initial.launchAtLogin, false);
    assert.equal(initial.g560Enabled, true);
    assert.equal(initial.g560Brightness, 0.75);
    assert.equal(initial.reducedFlashing, false);
    assert.ok(Number.isInteger(initial.installationSeed));
    await store.save({ ...initial, enabled: false, launchAtLogin: true, g560Brightness: 0.55, ignored: true });
    assert.deepEqual(await store.load(), { ...initial, enabled: false, launchAtLogin: true, g560Brightness: 0.55 });
    await fs.writeFile(filePath, "not json", "utf8");
    const recovered = await store.load();
    assert.equal(recovered.enabled, true);
    assert.equal(recovered.g560Enabled, true);
    assert.ok(Number.isInteger(recovered.installationSeed));
    await fs.rm(directory, { recursive: true, force: true });
});

test("builds the complete tray control surface", () => {
    const menu = buildTrayMenuTemplate({
        settings: { enabled: true, launchAtLogin: false },
        runtime: {
            beaconStatus: { connected: true, effect: "spin", triggerReason: "DockingGranted" },
            eliteProcessStatus: { state: "watching", running: true },
            journalStatus: { state: "watching" },
            lightingStatus: {
                provider: { connected: true },
                baseLabel: "Supercruise flow",
                baseReason: "Planetary flight · Rocky body",
                activeLayers: [{ label: "Fuel scooping" }],
                dominantCue: { reason: "FuelScoop" }
            }
        },
        actions: {}
    });
    const labels = menu.map((entry) => entry.label).filter(Boolean);
    for (const expected of ["Enabled", "Launch at Login", "G560 Lighting", "G560 Brightness", "Reduced Flashing", "Rescan Beacon", "Test Spin (3 seconds)", "Test Strobe (3 seconds)", "Rescan G560", "Preview G560 Scene", "Restore G HUB Lighting", "Windows Dynamic Lighting", "Stop Now", "Developer Monitor", "Open Logs", "About", "Quit"]) {
        assert.ok(labels.includes(expected), expected);
    }
    assert.ok(labels.includes("Beacon: Spinning"));
    assert.ok(labels.includes("Triggered by: Docking granted"));
    assert.ok(labels.includes("Elite Dangerous: Running"));
    assert.ok(labels.includes("G560: Connected"));
    assert.ok(labels.includes("Scene: Supercruise flow"));
    assert.ok(labels.includes("Environment: Planetary flight · Rocky body"));
    assert.ok(labels.includes("Layers: Fuel scooping"));
});

test("shows friendly manual-test trigger text only while active", () => {
    const activeLabels = buildTrayMenuTemplate({
        runtime: {
            beaconStatus: { connected: true, effect: "strobe", triggerReason: "tray_test" }
        }
    }).map((entry) => entry.label).filter(Boolean);
    assert.ok(activeLabels.includes("Triggered by: Manual tray test"));

    const dangerLabels = buildTrayMenuTemplate({
        runtime: {
            beaconStatus: { connected: true, effect: "strobe", triggerReason: "HullDamage" }
        }
    }).map((entry) => entry.label).filter(Boolean);
    assert.ok(dangerLabels.includes("Triggered by: Hull at or below 50%"));

    const inactiveLabels = buildTrayMenuTemplate({
        runtime: {
            beaconStatus: { connected: true, effect: "off", triggerReason: "HeatWarning" }
        }
    }).map((entry) => entry.label).filter(Boolean);
    assert.equal(inactiveLabels.some((label) => label.startsWith("Triggered by:")), false);
});

test("hardware tests and previews are unavailable while the companion is disabled", () => {
    const menu = buildTrayMenuTemplate({ settings: { enabled: false, g560Enabled: true } });
    const labels = menu.map((entry) => entry.label).filter(Boolean);
    assert.ok(labels.includes("Beacon: Disabled"));
    assert.ok(labels.includes("G560: Disabled"));
    for (const label of ["Rescan Beacon", "Test Spin (3 seconds)", "Test Strobe (3 seconds)", "Rescan G560"]) {
        assert.equal(menu.find((entry) => entry.label === label)?.enabled, false, label);
    }
    const previews = menu.find((entry) => entry.label === "Preview G560 Scene")?.submenu ?? [];
    assert.ok(previews.length > 0);
    assert.equal(previews.every((entry) => entry.enabled === false), true);
});

test("produces status-aware tray icons", () => {
    assert.equal(resolveTrayIconState({ enabled: true, beaconStatus: { connected: true, effect: "spin" }, journalStatus: { state: "watching" } }), "active");
    assert.equal(resolveTrayIconState({ enabled: true, beaconStatus: { connected: false, lastError: "missing" }, journalStatus: { state: "watching" } }), "error");
    assert.equal(resolveTrayIconState({ enabled: true, g560Enabled: true, beaconStatus: { connected: false }, lightingStatus: { sessionActive: true, provider: { connected: true } }, journalStatus: { state: "watching" } }), "active");
    assert.equal(resolveTrayIconState({ enabled: true, g560Enabled: true, beaconStatus: { connected: false }, lightingStatus: { provider: { detected: true } }, journalStatus: { state: "watching" } }), "ready");
    assert.match(buildTrayIconDataUrl("ready"), /^data:image\/png;base64,/u);
    const buildIcon = buildTrayIconPng("ready", 256);
    assert.equal(buildIcon.readUInt32BE(16), 256);
    assert.equal(buildIcon.readUInt32BE(20), 256);
});

test("rotates local logs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ed-beacon-logs-"));
    const logger = new RotatingLogger({ directory, maxBytes: 20 });
    logger.info("first record that exceeds the limit");
    logger.info("second record rotates the first");
    await fs.access(path.join(directory, "ed-beacon-companion.log.1"));
    await fs.rm(directory, { recursive: true, force: true });
});

test("logging failures never escape into hardware control paths", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ed-beacon-logs-failure-"));
    const logger = new RotatingLogger({ directory });
    await fs.rm(directory, { recursive: true, force: true });
    assert.doesNotThrow(() => logger.info("this write cannot create its missing parent"));
});
