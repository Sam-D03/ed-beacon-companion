import assert from "node:assert/strict";
import test from "node:test";

import { BeaconFsdSequence, resolveBeaconDirectives } from "../src/beacon-event-resolver.mjs";

function statusFlags(...bits) {
    return Number(bits.reduce((value, bit) => value | (1n << BigInt(bit)), 0n));
}

test("maps flight deck events", () => {
    assert.deepEqual(resolveBeaconDirectives({ event: "DockingGranted" }), [
        { kind: "base", effect: "spin", reason: "DockingGranted" }
    ]);
    assert.deepEqual(resolveBeaconDirectives({ event: "Docked" }), [
        { kind: "base", effect: "off", reason: "Docked" }
    ]);
    assert.deepEqual(resolveBeaconDirectives({ event: "Undocked" }), [
        { kind: "base", effect: "off", reason: "Undocked" },
        { kind: "pulse", effect: "spin", durationMs: 5_000, reason: "Undocked" }
    ]);
    assert.deepEqual(resolveBeaconDirectives({ event: "DockingGranted", Taxi: true }), []);
});

test("commander-controlled fighter launch spins the beacon for five seconds", () => {
    assert.deepEqual(resolveBeaconDirectives({
        event: "LaunchFighter",
        Loadout: "galactic",
        ID: 41,
        PlayerControlled: true
    }), [{
        kind: "pulse",
        effect: "spin",
        durationMs: 5_000,
        reason: "LaunchFighter"
    }]);
    assert.deepEqual(resolveBeaconDirectives({ event: "LaunchFighter", PlayerControlled: false }), []);
    assert.deepEqual(resolveBeaconDirectives({ event: "LaunchFighter" }), []);
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

test("FSD charging and countdown keep the beacon spinning until witchspace", () => {
    const sequence = new BeaconFsdSequence();
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(17) }), [
        { kind: "base", effect: "spin", reason: "FSD charging" }
    ]);
    assert.deepEqual(sequence.handleJournalEvent({ event: "StartJump", JumpType: "Hyperspace" }), [
        { kind: "base", effect: "spin", reason: "FSD Hyperspace countdown" }
    ]);
    assert.deepEqual(sequence.handleStatus({ Flags: 0 }), []);
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(30) }), [
        { kind: "base", effect: "off", reason: "Witchspace" }
    ]);
});

test("FSD charge cancellation stops the beacon and supercruise has the same countdown lifecycle", () => {
    const sequence = new BeaconFsdSequence();
    sequence.handleStatus({ Flags2: statusFlags(19) });
    assert.deepEqual(sequence.handleStatus({ Flags: 0, Flags2: 0 }), [
        { kind: "base", effect: "off", reason: "FSD charge cancelled" }
    ]);

    assert.deepEqual(sequence.handleJournalEvent({ event: "StartJump", JumpType: "Supercruise" }), [
        { kind: "base", effect: "spin", reason: "FSD Supercruise countdown" }
    ]);
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(4) }), [
        { kind: "base", effect: "off", reason: "SupercruiseEntry" }
    ]);
});

test("stale initial Status cannot start an FSD beacon sequence", () => {
    const sequence = new BeaconFsdSequence();
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(17) }, { initial: true, allowInitial: false }), []);
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(17) }), [
        { kind: "base", effect: "spin", reason: "FSD charging" }
    ]);
    sequence.reset();
    assert.deepEqual(sequence.handleJournalEvent({ event: "StartJump", JumpType: "Hyperspace", Taxi: true }), []);
});

test("supercruise overcharge spins the beacon for the full status lifetime", () => {
    const sequence = new BeaconFsdSequence();
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(4), Flags2: statusFlags(20) }), [
        { kind: "base", effect: "spin", reason: "Supercruise overcharge" }
    ]);
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(4), Flags2: statusFlags(20) }), []);
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(4), Flags2: 0 }), [
        { kind: "base", effect: "off", reason: "Supercruise overcharge ended" }
    ]);
});

test("overcharge and FSD charging hand off without briefly stopping the beacon", () => {
    const sequence = new BeaconFsdSequence();
    sequence.handleStatus({ Flags: statusFlags(4), Flags2: statusFlags(20) });
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(4, 17), Flags2: 0 }), [
        { kind: "base", effect: "spin", reason: "FSD charging" }
    ]);
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(4), Flags2: 0 }), [
        { kind: "base", effect: "off", reason: "FSD charge cancelled" }
    ]);
});

test("stale initial overcharge Status cannot energise the beacon", () => {
    const sequence = new BeaconFsdSequence();
    assert.deepEqual(sequence.handleStatus(
        { Flags: statusFlags(4), Flags2: statusFlags(20) },
        { initial: true, allowInitial: false }
    ), []);
    assert.deepEqual(sequence.handleStatus({ Flags: statusFlags(4), Flags2: statusFlags(20) }), [
        { kind: "base", effect: "spin", reason: "Supercruise overcharge" }
    ]);
});
