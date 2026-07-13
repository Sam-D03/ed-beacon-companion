import assert from "node:assert/strict";
import test from "node:test";

import { resolveBeaconDirectives } from "../src/beacon-event-resolver.mjs";

test("maps flight deck events", () => {
    assert.deepEqual(resolveBeaconDirectives({ event: "DockingGranted" }), [
        { kind: "base", effect: "spin", reason: "DockingGranted" }
    ]);
    assert.deepEqual(resolveBeaconDirectives({ event: "Docked" }), [
        { kind: "base", effect: "off", reason: "Docked" }
    ]);
    assert.deepEqual(resolveBeaconDirectives({ event: "Undocked" }), [
        { kind: "pulse", effect: "spin", durationMs: 5_000, reason: "Undocked" }
    ]);
    assert.deepEqual(resolveBeaconDirectives({ event: "DockingGranted", Taxi: true }), []);
});

test("maps danger events with their durations", () => {
    assert.equal(resolveBeaconDirectives({ event: "Interdicted" })[0].durationMs, 6_000);
    assert.equal(resolveBeaconDirectives({ event: "HeatWarning" })[0].durationMs, 8_000);
    assert.equal(resolveBeaconDirectives({ event: "HeatDamage" })[0].durationMs, 8_000);
    assert.equal(resolveBeaconDirectives({ event: "CockpitBreached" })[0].durationMs, 10_000);
});

test("filters fighter and non-critical hull events", () => {
    assert.deepEqual(resolveBeaconDirectives({ event: "UnderAttack", Target: "Fighter" }), []);
    assert.equal(resolveBeaconDirectives({ event: "UnderAttack", Target: "You" })[0].durationMs, 6_000);
    assert.deepEqual(resolveBeaconDirectives({ event: "HullDamage", Health: 0.8, PlayerPilot: true }), []);
    assert.deepEqual(resolveBeaconDirectives({ event: "HullDamage", Health: 0.4, Fighter: true }), []);
    assert.equal(resolveBeaconDirectives({ event: "HullDamage", Health: 0.5, PlayerPilot: true })[0].durationMs, 8_000);
});

test("hard-stops terminal game events and ignores unrelated events", () => {
    for (const event of ["LoadGame", "Died", "Shutdown"]) {
        assert.deepEqual(resolveBeaconDirectives({ event }), [{ kind: "stop_all", reason: event }]);
    }
    assert.deepEqual(resolveBeaconDirectives({ event: "Scan" }), []);
});
