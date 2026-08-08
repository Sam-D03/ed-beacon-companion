import assert from "node:assert/strict";
import test from "node:test";

import { buildDeveloperMonitorSnapshot } from "../src/developer-monitor-state.mjs";

test("builds a safe read-only developer monitor snapshot", () => {
    const snapshot = buildDeveloperMonitorSnapshot({
        version: "0.2.0",
        now: () => Date.parse("2026-08-06T01:23:45.000Z"),
        settings: {
            enabled: true,
            g560Enabled: true,
            g560Brightness: 0.55,
            reducedFlashing: false
        },
        runtime: {
            beaconStatus: {
                available: true,
                detected: true,
                connected: true,
                effect: "spin",
                triggerReason: "DockingGranted"
            },
            eliteProcessStatus: { state: "watching", running: true },
            journalStatus: {
                state: "watching",
                directory: "C:\\Saved Games\\Elite Dangerous",
                lastEvent: "DockingGranted",
                lastEventAt: "2026-08-06T01:23:44.000Z"
            }
        },
        lightingStatus: {
            enabled: true,
            sessionActive: true,
            baseScene: "docked",
            baseLabel: "Docked ambience",
            baseReason: "Docked",
            activeLayers: [{
                key: "docking",
                sceneId: "docking_clearance",
                label: "Docking clearance",
                reason: "DockingGranted",
                source: "journal",
                remainingMs: 1_250
            }],
            dominantCue: {
                key: "docking",
                sceneId: "docking_clearance",
                label: "Docking clearance",
                reason: "DockingGranted"
            },
            zoneColours: {
                leftRear: "#FF7100",
                leftFront: "#ff160d",
                rightFront: "#39b810",
                rightRear: "invalid"
            },
            framesRendered: 100,
            framesWritten: 80,
            framesDeduplicated: 20,
            targetFps: 29,
            provider: { available: true, detected: true, connected: true, state: "acquired" }
        }
    });

    assert.equal(snapshot.generatedAt, "2026-08-06T01:23:45.000Z");
    assert.equal(snapshot.app.brightness, 0.55);
    assert.equal(snapshot.game.running, true);
    assert.equal(snapshot.journal.lastEvent, "DockingGranted");
    assert.equal(snapshot.beacon.triggerReason, "DockingGranted");
    assert.equal(snapshot.lighting.baseScene, "docked");
    assert.equal(snapshot.lighting.activeLayers[0].remainingMs, 1_250);
    assert.equal(snapshot.lighting.dominantCue.sceneId, "docking_clearance");
    assert.deepEqual(snapshot.lighting.zoneColours, {
        leftRear: "#ff7100",
        leftFront: "#ff160d",
        rightFront: "#39b810",
        rightRear: "#000000"
    });
    assert.equal(snapshot.lighting.provider.connected, true);
});

test("developer monitor snapshot defaults cannot leak non-serializable runtime state", () => {
    const snapshot = buildDeveloperMonitorSnapshot({
        now: () => 0,
        settings: { g560Brightness: Number.NaN },
        runtime: {
            beaconStatus: { connected: "yes", detected: undefined },
            lightingStatus: {
                activeLayers: null,
                zoneColours: { leftRear: () => "not serializable" }
            }
        }
    });

    assert.equal(snapshot.generatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(snapshot.app.brightness, 0.75);
    assert.equal(snapshot.beacon.connected, false);
    assert.deepEqual(snapshot.lighting.activeLayers, []);
    assert.deepEqual(snapshot.lighting.zoneColours, {
        leftRear: "#000000",
        leftFront: "#000000",
        rightFront: "#000000",
        rightRear: "#000000"
    });
    assert.doesNotThrow(() => JSON.stringify(snapshot));
});
