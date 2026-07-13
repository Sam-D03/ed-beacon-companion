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
    assert.deepEqual(await store.load(), { enabled: true, launchAtLogin: false });
    await store.save({ enabled: false, launchAtLogin: true, ignored: true });
    assert.deepEqual(await store.load(), { enabled: false, launchAtLogin: true });
    await fs.writeFile(filePath, "not json", "utf8");
    assert.deepEqual(await store.load(), { enabled: true, launchAtLogin: false });
    await fs.rm(directory, { recursive: true, force: true });
});

test("builds the complete tray control surface", () => {
    const menu = buildTrayMenuTemplate({
        settings: { enabled: true, launchAtLogin: false },
        runtime: {
            beaconStatus: { connected: true, effect: "spin" },
            journalStatus: { state: "watching" }
        },
        actions: {}
    });
    const labels = menu.map((entry) => entry.label).filter(Boolean);
    for (const expected of ["Enabled", "Launch at Login", "Rescan Beacon", "Test Spin (3 seconds)", "Test Strobe (3 seconds)", "Stop Now", "Open Logs", "About", "Quit"]) {
        assert.ok(labels.includes(expected), expected);
    }
    assert.ok(labels.includes("Beacon: Spinning"));
});

test("produces status-aware tray icons", () => {
    assert.equal(resolveTrayIconState({ enabled: true, beaconStatus: { connected: true, effect: "spin" }, journalStatus: { state: "watching" } }), "active");
    assert.equal(resolveTrayIconState({ enabled: true, beaconStatus: { connected: false, lastError: "missing" }, journalStatus: { state: "watching" } }), "error");
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
