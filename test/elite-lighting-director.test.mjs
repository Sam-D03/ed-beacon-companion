import assert from "node:assert/strict";
import test from "node:test";

import {
    EliteLightingDirector,
    buildElitePersistentLayers,
    decodeEliteStatus,
    hasStatusBit,
    selectEliteBaseScene
} from "../src/lighting/elite-lighting-director.mjs";

class FakeEngine {
    constructor() {
        this.calls = [];
        this.sessionActive = false;
    }
    beginSession(seed) { this.sessionActive = true; this.calls.push(["beginSession", seed]); }
    setSessionActive(active) { this.sessionActive = active; this.calls.push(["setSessionActive", active]); }
    setBaseScene(sceneId, options) { this.calls.push(["base", sceneId, options]); }
    setPersistentLayers(layers) { this.calls.push(["layers", structuredClone(layers)]); }
    triggerOverlay(sceneId, options) { this.calls.push(["cue", sceneId, structuredClone(options)]); }
    clearTransientLayers(options) { this.calls.push(["clearTransient", structuredClone(options)]); }
    stopNow(reason) { this.sessionActive = false; this.calls.push(["stop", reason]); }
    cues(sceneId = null) {
        return this.calls.filter((call) => call[0] === "cue" && (!sceneId || call[1] === sceneId));
    }
    lastBase() { return this.calls.filter((call) => call[0] === "base").at(-1); }
    lastLayers() { return this.calls.filter((call) => call[0] === "layers").at(-1)?.[1] ?? []; }
}

function statusFlags(...bits) {
    return Number(bits.reduce((value, bit) => value | (1n << BigInt(bit)), 0n));
}

function createDirector({ wallNow = Date.parse("2026-08-04T01:00:00Z") } = {}) {
    const engine = new FakeEngine();
    const timers = [];
    const director = new EliteLightingDirector({
        engine,
        wallNow: () => wallNow,
        setTimeoutFn: (callback, delay) => {
            const timer = { callback, delay, cleared: false, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimeoutFn: (timer) => { timer.cleared = true; }
    });
    return { director, engine, timers };
}

test("decodes unsigned high Status bits without JavaScript bitwise overflow", () => {
    const flags = (1n << 31n) | (1n << 30n) | (1n << 4n);
    assert.equal(hasStatusBit(flags, 31), true);
    const decoded = decodeEliteStatus({ Flags: Number(flags), Flags2: statusFlags(20, 21) });
    assert.equal(decoded.srvHighBeam, true);
    assert.equal(decoded.fsdJump, true);
    assert.equal(decoded.supercruise, true);
    assert.equal(decoded.supercruiseOvercharge, true);
    assert.equal(decoded.supercruiseAssist, true);
});

test("decodes SRV, multicrew, drive and fuel instrumentation", () => {
    const decoded = decodeEliteStatus({
        Flags: statusFlags(12, 13, 15, 26),
        Flags2: statusFlags(17, 18, 19),
        Fuel: { FuelMain: 9.5, FuelReservoir: 0.42 },
        Cargo: 18,
        FireGroup: 3,
        SelectedWeapon: "$humanoid_weapon_name_AssaultRifle;",
        Heading: 271,
        Gravity: 0.18
    });
    assert.equal(decoded.srvHandbrake, true);
    assert.equal(decoded.srvTurretView, true);
    assert.equal(decoded.srvDriveAssist, true);
    assert.equal(decoded.telepresenceMulticrew, true);
    assert.equal(decoded.physicalMulticrew, true);
    assert.equal(decoded.hyperdriveCharging, true);
    assert.equal(decoded.fuelMain, 9.5);
    assert.equal(decoded.fuelReservoir, 0.42);
    assert.equal(decoded.cargo, 18);
    assert.equal(decoded.fireGroup, 3);
    assert.equal(decoded.heading, 271);
    assert.equal(decoded.gravity, 0.18);
});

test("selects high-fidelity persistent contexts in precedence order", () => {
    const world = {
        status: decodeEliteStatus({ Flags: statusFlags(4, 24), Flags2: statusFlags(20), GuiFocus: 0 }),
        music: null,
        activity: null,
        thargoidEncounter: false
    };
    assert.equal(selectEliteBaseScene(world).sceneId, "supercruise_overcharge");
    world.status = decodeEliteStatus({ Flags: statusFlags(24, 30), GuiFocus: 6 });
    assert.equal(selectEliteBaseScene(world).sceneId, "galaxy_map");
    world.status = decodeEliteStatus({ Flags2: statusFlags(0, 4) });
    assert.equal(selectEliteBaseScene(world).sceneId, "on_foot_surface");
    world.status = decodeEliteStatus({ Flags: statusFlags(26) });
    world.music = "GuardianSites";
    assert.equal(selectEliteBaseScene(world).sceneId, "guardian_site");
    world.status = decodeEliteStatus();
    world.music = "GalacticPowers";
    assert.equal(selectEliteBaseScene(world).sceneId, "codex");
    world.systemArrivalAtMs = 1_000;
    world.music = "DestinationFromHyperspace";
    assert.equal(selectEliteBaseScene(world).sceneId, "system_flight");
    world.status = decodeEliteStatus({ Flags: statusFlags(21, 24) });
    assert.equal(selectEliteBaseScene(world).sceneId, "planetary_flight");
    world.systemArrivalAtMs = null;
    world.status = decodeEliteStatus();
    assert.equal(selectEliteBaseScene(world).sceneId, "supercruise");
});

test("cockpit GUI focus becomes a zoned persistent panel layer", () => {
    const layers = buildElitePersistentLayers({
        status: decodeEliteStatus({ Flags: statusFlags(24), GuiFocus: 3 })
    });
    const panel = layers.find((layer) => layer.sceneId === "cockpit_panel");
    assert.equal(panel.reason, "Cockpit panel 3");
    assert.equal(panel.context.guiFocus, 3);
});

test("builds composable sustained instrumentation, warning, and survival layers", () => {
    const world = {
        status: decodeEliteStatus({
            Flags: statusFlags(2, 6, 11, 19, 20, 22, 24),
            Flags2: statusFlags(6, 11),
            LegalState: "Wanted",
            Oxygen: 0.2
        }),
        dockingState: "granted",
        hullHealth: 0.18
    };
    const layers = buildElitePersistentLayers(world);
    const ids = layers.map((layer) => layer.sceneId);
    for (const id of ["docking_clearance", "landing_gear", "fuel_scoop", "low_fuel", "overheat", "danger", "wanted", "hot", "low_oxygen", "critical_hull"]) {
        assert.ok(ids.includes(id), id);
    }
    assert.equal(ids.includes("hardpoints"), false);
    assert.equal(ids.includes("analysis_mode"), false);
    assert.ok(layers.find((layer) => layer.sceneId === "critical_hull").priority > layers.find((layer) => layer.sceneId === "danger").priority);
});

test("stale initial Status hydrates silently and cannot energise speakers", () => {
    const { director, engine } = createDirector();
    director.handleStatus({ timestamp: "2026-08-03T22:00:00Z", Flags: statusFlags(4, 24) }, { initial: true });
    assert.equal(director.getWorldState().sessionActive, false);
    assert.equal(engine.calls.length, 0);
});

test("process liveness hydrates old Status while running and releases on game exit", () => {
    const { director, engine } = createDirector();
    director.handleGameProcess(true);
    assert.equal(engine.lastBase()[1], "main_menu");
    director.handleStatus({ timestamp: "2026-08-03T22:00:00Z", Flags: statusFlags(4, 24) }, { initial: true });
    assert.equal(director.getWorldState().sessionActive, true);
    assert.equal(engine.lastBase()[1], "supercruise");
    director.handleGameProcess(false);
    assert.equal(director.getWorldState().sessionActive, false);
    assert.equal(engine.calls.filter((call) => call[0] === "stop").at(-1)[1], "Elite Dangerous closed");
});

test("an explicitly absent game process blocks even a recent initial Status snapshot", () => {
    const { director, engine } = createDirector();
    director.handleGameProcess(false);
    director.handleStatus({ timestamp: "2026-08-04T00:59:59Z", Flags: statusFlags(4, 24) }, { initial: true });
    assert.equal(director.getWorldState().sessionActive, false);
    assert.equal(engine.calls.length, 0);
    director.handleGameProcess(true);
    assert.equal(director.getWorldState().sessionActive, true);
    assert.equal(engine.lastBase()[1], "supercruise");
});

test("fresh initial Status establishes ambience without replaying edge flashes", () => {
    const { director, engine } = createDirector();
    director.handleStatus({ timestamp: "2026-08-04T00:59:50Z", Flags: statusFlags(3, 4, 24) }, { initial: true });
    assert.equal(director.getWorldState().sessionActive, true);
    assert.equal(engine.lastBase()[1], "supercruise");
    assert.equal(engine.cues().length, 0);
});

test("live Status edges cue shield collapse and restore while sustained state reconciles", () => {
    const { director, engine } = createDirector();
    director.handleStatus({ timestamp: "2026-08-04T00:59:50Z", Flags: statusFlags(3, 22, 24) }, { initial: true });
    director.handleStatus({ timestamp: "2026-08-04T00:59:51Z", Flags: statusFlags(22, 24) });
    assert.equal(engine.cues("shield_impact").length, 1);
    assert.ok(engine.lastLayers().some((layer) => layer.sceneId === "shields_down"));
    director.handleStatus({ timestamp: "2026-08-04T00:59:52Z", Flags: statusFlags(3, 24) });
    assert.equal(engine.cues("shields_restored").length, 1);
});

test("terminal travel Status clears stale docking guidance", () => {
    for (const flags of [statusFlags(0, 24), statusFlags(1, 24), statusFlags(4, 24), statusFlags(24, 30)]) {
        const { director, engine } = createDirector();
        director.handleJournalEvent({ event: "LoadGame" });
        director.handleJournalEvent({ event: "DockingGranted" });
        assert.ok(engine.lastLayers().some((layer) => layer.sceneId === "docking_clearance"));
        director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: flags });
        assert.equal(director.getWorldState().dockingState, null);
        assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "docking_clearance"), false);
    }
});

test("Music NoTrack releases the previous music base override", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(4, 24) });
    director.handleJournalEvent({ event: "Music", MusicTrack: "Combat_Dogfight" });
    assert.equal(engine.lastBase()[1], "combat_ambience");
    director.handleJournalEvent({ event: "Music", MusicTrack: "NoTrack" });
    assert.equal(director.getWorldState().music, null);
    assert.equal(engine.lastBase()[1], "supercruise");
});

test("main-menu music overrides a stale docked Status snapshot", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(0, 24) });
    assert.equal(engine.lastBase()[1], "docked");
    director.handleJournalEvent({ event: "Music", MusicTrack: "MainMenu" });
    assert.equal(engine.lastBase()[1], "main_menu");
});

test("explicit combat and damaged-starport music outrank vehicle and concourse snapshots", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(26) });
    director.handleJournalEvent({ event: "Music", MusicTrack: "Combat_SRV" });
    assert.equal(engine.lastBase()[1], "combat_ambience");

    director.handleStatus({ timestamp: "2026-08-04T01:00:01Z", Flags: statusFlags(24), Flags2: statusFlags(0, 6) });
    director.handleJournalEvent({ event: "Music", MusicTrack: "Damaged_Starport" });
    assert.equal(engine.lastBase()[1], "damaged_station");

    director.handleStatus({ timestamp: "2026-08-04T01:00:02Z", Flags: statusFlags(4, 24), Flags2: statusFlags(20) });
    director.handleJournalEvent({ event: "Music", MusicTrack: "Combat_Dogfight" });
    assert.equal(engine.lastBase()[1], "supercruise_overcharge");
});

test("ambient explanation remains the world state after an unrelated event cue", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(24) });
    director.handleJournalEvent({ event: "MaterialCollected", Name: "iron" });
    assert.equal(engine.lastBase()[2].reason, "Normal space");
});

test("StartJump begins the exact countdown over its destination scene and captures the star class", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "StartJump", JumpType: "Hyperspace", StarClass: "A" });
    assert.equal(director.getWorldState().starClass, "A");
    assert.equal(director.getWorldState().pendingJumpType, "Hyperspace");
    assert.equal(engine.lastBase()[1], "witchspace");
    assert.equal(engine.cues("fsd_countdown").at(-1)[2].durationMs, 5_000);
    assert.equal(engine.cues("fsd_countdown").at(-1)[2].key, "journal-fsd-countdown");

    const supercruise = createDirector();
    supercruise.director.handleJournalEvent({ event: "LoadGame" });
    supercruise.director.handleJournalEvent({ event: "StartJump", JumpType: "Supercruise" });
    assert.equal(supercruise.engine.lastBase()[1], "supercruise");
    assert.equal(supercruise.engine.cues("fsd_countdown").at(-1)[2].durationMs, 5_000);
});

test("FSD charge hands off to countdown and destination ambience without overlapping travel layers", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(17, 24) });
    assert.ok(engine.lastLayers().some((layer) => layer.sceneId === "fsd_charge"));

    director.handleJournalEvent({ event: "StartJump", JumpType: "Hyperspace" });
    assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "fsd_charge"), false);
    assert.equal(engine.lastBase()[1], "witchspace");

    director.handleStatus({ timestamp: "2026-08-04T01:00:05Z", Flags: statusFlags(24, 30) });
    assert.equal(director.getWorldState().pendingJumpType, null);
    assert.equal(engine.lastBase()[1], "witchspace");

    director.handleJournalEvent({ event: "FSDJump", StarSystem: "Sol" });
    assert.equal(director.getWorldState().systemArrivalAtMs, Date.parse("2026-08-04T01:00:00Z"));
    director.handleStatus({ timestamp: "2026-08-04T01:00:06Z", Flags: statusFlags(4, 24) });
    assert.equal(engine.lastBase()[1], "system_flight");
    assert.equal(engine.lastBase()[2].context.starClass, null);
});

test("DropshipDeploy is a conflict insertion rather than an FSD launch cue", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "DropshipDeploy" });
    assert.equal(engine.cues("conflict_insertion").length, 1);
    assert.equal(engine.cues("launch").length, 0);
});

test("LoadGame StartDead remains blacked out until Resurrect", () => {
    const { director, engine } = createDirector();
    director.handleGameProcess(true);
    director.handleJournalEvent({ event: "LoadGame", StartDead: true });
    assert.equal(director.getWorldState().sessionActive, false);
    assert.equal(director.getWorldState().shutdownLatched, true);
    assert.equal(engine.calls.filter((call) => call[0] === "stop").at(-1)[1], "LoadGame: commander dead");
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(24) });
    assert.equal(director.getWorldState().sessionActive, false);
    director.handleJournalEvent({ event: "Resurrect" });
    assert.equal(director.getWorldState().sessionActive, true);
});

test("damaged station variants select damage ambience and omitted state clears on the next dock", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(0, 24) });
    director.handleJournalEvent({ event: "Docked", StationName: "Rescue Port", StationState: "DamagedHuman" });
    assert.equal(engine.lastBase()[1], "damaged_station");
    director.handleJournalEvent({ event: "Docked", StationName: "Safe Port" });
    assert.equal(director.getWorldState().stationState, null);
    assert.equal(engine.lastBase()[1], "docked");
});

test("only encounter evidence latches Thargoid ambience and escape or supercruise clears it", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "FSSSignalDiscovered", SignalName: "THARGOID STRIPCLUB", IsStation: true });
    director.handleJournalEvent({ event: "Location", StationName: "MAELSTROM DSE GLN-N5V" });
    assert.equal(director.getWorldState().thargoidEncounter, false);
    director.handleJournalEvent({ event: "Interdicted", IsThargoid: true });
    assert.equal(director.getWorldState().thargoidEncounter, true);
    director.handleJournalEvent({ event: "EscapeInterdiction", IsThargoid: true });
    assert.equal(director.getWorldState().thargoidEncounter, false);
    assert.equal(engine.cues("escape").at(-1)[2].priority, 975);
    director.handleJournalEvent({ event: "USSDrop", USSType: "$USS_Type_NonHuman;", Threat: 7 });
    assert.equal(director.getWorldState().thargoidEncounter, true);
    director.handleJournalEvent({ event: "SupercruiseEntry" });
    assert.equal(director.getWorldState().thargoidEncounter, false);
});

test("shield edges require the same active vehicle", () => {
    const { director, engine } = createDirector();
    director.handleStatus({ timestamp: "2026-08-04T00:59:50Z", Flags: statusFlags(26) }, { initial: true });
    director.handleStatus({ timestamp: "2026-08-04T00:59:51Z", Flags: statusFlags(3, 24) });
    assert.equal(engine.cues("shields_restored").length, 0);
    director.handleStatus({ timestamp: "2026-08-04T00:59:52Z", Flags: statusFlags(24) });
    director.handleStatus({ timestamp: "2026-08-04T00:59:53Z", Flags: statusFlags(3, 24) });
    assert.equal(engine.cues("shields_restored").length, 1);
});

test("fighter and SRV shield loss remains visible while the active vehicle is in danger", () => {
    for (const [vehicleBit, reason] of [[25, "Fighter shields offline"], [26, "SRV shields offline"]]) {
        const layers = buildElitePersistentLayers({
            status: decodeEliteStatus({ Flags: statusFlags(vehicleBit, 22) })
        });
        assert.equal(layers.find((layer) => layer.sceneId === "shields_down")?.reason, reason);
    }
});

test("fighter hull damage never overwrites mothership hull state", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(25) });
    director.handleJournalEvent({ event: "HullDamage", Fighter: true, Health: 0.1 });
    assert.equal(director.getWorldState().fighterHullHealth, 0.1);
    assert.equal(director.getWorldState().hullHealth, null);
    assert.ok(engine.lastLayers().some((layer) => layer.reason === "Fighter hull 10%"));
    director.handleStatus({ timestamp: "2026-08-04T01:00:01Z", Flags: statusFlags(24) });
    assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "critical_hull"), false);
});

test("a destroyed fighter cannot leak critical hull state into its replacement", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(25) });
    director.handleJournalEvent({ event: "HullDamage", Fighter: true, Health: 0.1 });
    assert.ok(engine.lastLayers().some((layer) => layer.reason === "Fighter hull 10%"));
    director.handleJournalEvent({ event: "FighterDestroyed" });
    assert.equal(director.getWorldState().fighterHullHealth, null);
    director.handleJournalEvent({ event: "LaunchFighter", PlayerControlled: true });
    assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "critical_hull"), false);
});

test("SRV hull damage stays with the SRV when the commander boards the ship", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(26) });
    director.handleJournalEvent({ event: "HullDamage", Health: 0.1, PlayerPilot: true, Fighter: false });
    assert.equal(director.getWorldState().srvHullHealth, 0.1);
    assert.equal(director.getWorldState().hullHealth, null);
    assert.ok(engine.lastLayers().some((layer) => layer.reason === "SRV hull 10%"));

    director.handleStatus({ timestamp: "2026-08-04T01:00:01Z", Flags: statusFlags(24) });
    assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "critical_hull"), false);
});

test("terminal FSD events clear the keyed countdown before arrival ambience", () => {
    for (const terminalEvent of ["SupercruiseEntry", "FSDJump"]) {
        const { director, engine } = createDirector();
        director.handleJournalEvent({ event: "LoadGame" });
        director.handleJournalEvent({ event: "StartJump", JumpType: terminalEvent === "FSDJump" ? "Hyperspace" : "Supercruise" });
        director.handleJournalEvent({ event: terminalEvent });
        assert.ok(engine.calls.some((call) =>
            call[0] === "clearTransient" && call[1].key === "journal-fsd-countdown"));
        assert.equal(director.getWorldState().pendingJumpType, null);
    }
});

test("Status and Journal shield edges share stable keys instead of stacking", () => {
    const { director, engine } = createDirector();
    director.handleStatus({ timestamp: "2026-08-04T00:59:50Z", Flags: statusFlags(3, 24) }, { initial: true });
    director.handleStatus({ timestamp: "2026-08-04T00:59:51Z", Flags: statusFlags(24) });
    director.handleJournalEvent({ event: "ShieldState", ShieldsUp: false });
    assert.deepEqual(engine.cues("shield_impact").map((call) => call[2].key), ["shield-collapse", "shield-collapse"]);
});

test("docked shield-generator power cycling does not impersonate combat damage", () => {
    const { director, engine } = createDirector();
    director.handleStatus({ timestamp: "2026-08-04T00:59:50Z", Flags: statusFlags(0, 3, 24) }, { initial: true });
    director.handleStatus({ timestamp: "2026-08-04T00:59:51Z", Flags: statusFlags(0, 24) });
    director.handleJournalEvent({ event: "ShieldState", ShieldsUp: false });
    assert.equal(engine.cues("shield_impact").length, 0);
    director.handleJournalEvent({ event: "ShieldState", ShieldsUp: true });
    assert.equal(engine.cues("shields_restored").length, 0);
});

test("repeated heat damage restarts its finite animation instead of extending it into darkness", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "HeatDamage" });
    director.handleJournalEvent({ event: "HeatDamage" });
    assert.deepEqual(engine.cues("heat_damage").map((call) => call[2].retrigger), ["restart", "restart"]);
});

test("journal events queued after process exit cannot restart lighting", () => {
    const { director, engine } = createDirector();
    director.handleGameProcess(true);
    director.handleGameProcess(false);
    const callCount = engine.calls.length;
    director.handleJournalEvent({ event: "Music", MusicTrack: "Combat_Dogfight" });
    director.handleJournalEvent({ event: "FSDJump", StarSystem: "Sol" });
    assert.equal(director.getWorldState().sessionActive, false);
    assert.equal(engine.calls.length, callCount);
});

test("interdiction outcomes replace the tug cue and support the attacker event", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "Interdicted" });
    assert.equal(engine.cues("interdiction").at(-1)[2].key, "interdiction-active");
    director.handleJournalEvent({ event: "EscapeInterdiction" });
    assert.deepEqual(engine.calls.filter((call) => call[0] === "clearTransient").at(-1)[1], { key: "interdiction-active" });
    director.handleJournalEvent({ event: "Interdiction", Success: true });
    director.handleJournalEvent({ event: "Interdiction", Success: false });
    assert.equal(engine.cues("interdiction_success").length, 1);
    assert.equal(engine.cues("interdiction_failed").length, 1);
});

test("target scans cue only lock and scan-stage edges", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "ShipTargeted", TargetLocked: true, Ship: "anaconda", ScanStage: 0 });
    director.handleJournalEvent({ event: "ShipTargeted", TargetLocked: true, Ship: "anaconda", ScanStage: 0, HullHealth: 99 });
    director.handleJournalEvent({ event: "ShipTargeted", TargetLocked: true, Ship: "anaconda", ScanStage: 1 });
    director.handleJournalEvent({ event: "ShipTargeted", TargetLocked: true, Ship: "anaconda", ScanStage: 3 });
    director.handleJournalEvent({ event: "ShipTargeted", TargetLocked: true, Ship: "anaconda", ScanStage: 3, Bounty: 100 });
    assert.equal(engine.cues("scan").length, 2);
    assert.equal(engine.cues("scan_complete").length, 1);
});

test("airlocks, signal threat, settlement approach, and system chat have dedicated cues", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "Disembark", OnPlanet: true });
    director.handleJournalEvent({ event: "ApproachSettlement", Name: "Dawes Prospect" });
    director.handleJournalEvent({ event: "SupercruiseDestinationDrop", Type_Localised: "Distress Call", Threat: 6 });
    director.handleJournalEvent({ event: "ReceiveText", Channel: "starsystem", From: "CMDR Example" });
    assert.equal(engine.cues("airlock").length, 1);
    assert.equal(engine.cues("settlement_approach").length, 1);
    assert.equal(engine.cues("signal_drop").at(-1)[2].context.threatLevel, 6);
    assert.equal(engine.cues("comms_ping").length, 1);
});

test("Loadout and repair events keep persistent hull state current", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(24) });

    director.handleJournalEvent({ event: "Loadout", HullHealth: 0.18 });
    assert.equal(director.getWorldState().hullHealth, 0.18);
    assert.ok(engine.lastLayers().some((layer) => layer.sceneId === "critical_hull"));

    director.handleJournalEvent({ event: "RepairDrone", HullRepaired: 2.5 });
    assert.equal(director.getWorldState().hullHealth, 0.205);
    assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "critical_hull"), false);

    director.handleJournalEvent({ event: "HullDamage", Health: 0.1, PlayerPilot: true, Fighter: false });
    director.handleJournalEvent({ event: "Repair", Items: ["PowerPlant", "Hull"] });
    assert.equal(director.getWorldState().hullHealth, 1);

    director.handleJournalEvent({ event: "HullDamage", Health: 0.08, PlayerPilot: true, Fighter: false });
    director.handleJournalEvent({ event: "RepairAll" });
    assert.equal(director.getWorldState().hullHealth, 1);
    assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "critical_hull"), false);
});

test("Undocked is a finite cue and never becomes a persistent layer", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame", timestamp: "2026-08-04T01:00:00Z" });
    director.handleJournalEvent({ event: "DockingGranted" });
    assert.ok(engine.lastLayers().some((layer) => layer.sceneId === "docking_clearance"));
    director.handleJournalEvent({ event: "Undocked" });
    const launch = engine.cues("launch").at(-1);
    assert.equal(launch[2].durationMs, 4_000);
    assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "launch"), false);
    assert.equal(engine.lastLayers().some((layer) => layer.sceneId === "docking_clearance"), false);
});

test("filters remote fighter damage and non-player liftoff", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(24) });
    director.handleJournalEvent({ event: "UnderAttack", Target: "Fighter" });
    director.handleJournalEvent({ event: "HullDamage", Fighter: true, Health: 0.1 });
    director.handleJournalEvent({ event: "Liftoff", PlayerControlled: false });
    assert.equal(engine.cues("under_attack").length, 0);
    assert.equal(engine.cues("hull_impact").length, 0);
    assert.equal(engine.cues("launch").length, 0);
});

test("commander fighter launch runs the five-second hangar beacon scene and filters NPC launches", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({
        event: "LaunchFighter",
        Loadout: "galactic",
        ID: 41,
        PlayerControlled: true
    });
    director.handleJournalEvent({ event: "LaunchFighter", ID: 42, PlayerControlled: false });

    const cue = engine.cues("fighter_launch").at(-1);
    assert.equal(engine.cues("fighter_launch").length, 1);
    assert.equal(cue[2].durationMs, 5_000);
    assert.equal(cue[2].reason, "LaunchFighter");
    assert.equal(cue[2].exclusiveGroup, "travel");
    assert.equal(cue[2].context.loadout, "galactic");
    assert.equal(cue[2].context.fighterId, 41);
    assert.equal(director.getWorldState().fighterHullHealth, 1);
});

test("maps exploration, mining, rewards, engineering, and system events", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    for (const event of [
        { event: "FSSDiscoveryScan" },
        { event: "SAAScanComplete" },
        { event: "ScanOrganic", ScanType: "Analyse", Species: "$Codex_Ent_Bacterial_Genus_Name;" },
        { event: "ProspectedAsteroid", MotherlodeMaterial: "Alexandrite" },
        { event: "AsteroidCracked" },
        { event: "MissionCompleted" },
        { event: "EngineerCraft" },
        { event: "SystemsShutdown" },
        { event: "RebootRepair" }
    ]) director.handleJournalEvent(event);
    for (const scene of ["scan", "dss_scan_complete", "organic_scan", "mining", "asteroid_cracked", "reward", "engineer_craft", "systems_shutdown", "systems_reboot"]) {
        assert.ok(engine.cues(scene).length > 0, scene);
    }
    assert.equal(engine.lastBase()[1], "mining_ambience");
});

test("DSS completion uses a calm dedicated accent and deduplicates the accompanying signals event", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "SAAScanComplete", BodyName: "Test 1 A" });
    director.handleJournalEvent({ event: "SAASignalsFound", BodyName: "Test 1 A" });

    const cues = engine.cues("dss_scan_complete");
    assert.equal(cues.length, 1);
    assert.equal(cues[0][2].durationMs, 320);
    assert.equal(cues[0][2].reason, "DSS scan complete");
    assert.equal(cues[0][2].exclusiveGroup, "event-accent");
    assert.equal(engine.cues("scan_complete").length, 0);
});

test("planetary FSS scans use body colour and deduplicate the matching body-signals event", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    const identity = {
        StarSystem: "Colour Test",
        SystemAddress: 771,
        BodyName: "Colour Test 2",
        BodyID: 8
    };
    director.handleJournalEvent({
        event: "Scan",
        ...identity,
        ScanType: "Detailed",
        PlanetClass: "Water world"
    });
    director.handleJournalEvent({ event: "FSSBodySignals", ...identity, Signals: [] });

    const cues = engine.cues("body_scan_complete");
    assert.equal(cues.length, 1);
    assert.equal(cues[0][2].durationMs, 540);
    assert.equal(cues[0][2].reason, "Scan: Water world");
    assert.equal(cues[0][2].context.planetClass, "Water world");
    assert.equal(cues[0][2].exclusiveGroup, "event-accent");
    assert.equal(engine.cues("scan_complete").length, 0);
});

test("non-planet Scan events retain the generic scan-complete accent", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "Scan", BodyName: "Colour Test", StarType: "G" });
    assert.equal(engine.cues("body_scan_complete").length, 0);
    assert.equal(engine.cues("scan_complete").length, 1);
});

test("a live planet Scan follows the same body through orbit, glide, SRV, and on-foot surface scenes", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({
        event: "Scan",
        StarSystem: "Test System",
        SystemAddress: 12345,
        BodyName: "Test System 2 a",
        BodyID: 7,
        PlanetClass: "Rocky body"
    });
    director.handleJournalEvent({
        event: "ApproachBody",
        StarSystem: "Test System",
        SystemAddress: 12345,
        Body: "Test System 2 a",
        BodyID: 7
    });

    let base = engine.lastBase();
    assert.equal(base[1], "planetary_flight");
    assert.equal(base[2].reason, "Planetary flight · Rocky body");
    assert.equal(base[2].context.planetClass, "Rocky body");
    assert.equal(base[2].context.planetColourHex, "#8E715F");

    director.handleStatus({
        BodyName: "Test System 2 a",
        Flags: statusFlags(21),
        Flags2: statusFlags(12)
    });
    base = engine.lastBase();
    assert.equal(base[1], "glide");
    assert.equal(base[2].reason, "Orbital glide · Rocky body");

    director.handleStatus({
        BodyName: "Test System 2 a",
        Flags: statusFlags(21, 26),
        Flags2: 0
    });
    base = engine.lastBase();
    assert.equal(base[1], "srv");
    assert.equal(base[2].reason, "SRV · Rocky body");

    director.handleStatus({
        BodyName: "Test System 2 a",
        Flags: statusFlags(21),
        Flags2: statusFlags(0, 4)
    });
    base = engine.lastBase();
    assert.equal(base[1], "on_foot_surface");
    assert.equal(base[2].reason, "On-foot expedition · Rocky body");
    assert.equal(base[2].context.planetColourName, "dusty stone");
});

test("body colour tracking ignores other scanned planets and clears after LeaveBody", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({
        event: "Scan",
        StarSystem: "Test System",
        SystemAddress: 98765,
        BodyName: "Test System 1",
        BodyID: 4,
        PlanetClass: "Icy body"
    });
    director.handleJournalEvent({
        event: "Scan",
        StarSystem: "Test System",
        SystemAddress: 98765,
        BodyName: "Test System 2",
        BodyID: 5,
        PlanetClass: "Ammonia world"
    });
    director.handleJournalEvent({
        event: "ApproachBody",
        StarSystem: "Test System",
        SystemAddress: 98765,
        Body: "Test System 1",
        BodyID: 4
    });
    assert.equal(engine.lastBase()[2].context.planetClass, "Icy body");

    director.handleJournalEvent({ event: "LeaveBody" });
    director.handleStatus({ Flags: statusFlags(4), Flags2: 0 });
    assert.equal(engine.lastBase()[1], "supercruise");
    assert.equal(engine.lastBase()[2].context.planetClass, null);
});

test("passive body metadata survives process and LoadGame resets without replaying a cue", () => {
    const { director, engine } = createDirector();
    assert.equal(director.primePlanetClassScans([{
        event: "Scan",
        StarSystem: "Remembered",
        SystemAddress: 444,
        BodyName: "Remembered 3 a",
        BodyID: 9,
        PlanetClass: "Icy body"
    }]), 1);
    assert.equal(engine.cues().length, 0);

    director.handleGameProcess(false);
    director.handleGameProcess(true);
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({
        event: "Location",
        StarSystem: "Remembered",
        SystemAddress: 444,
        Body: "Remembered 3 a",
        BodyID: 9,
        BodyType: "Planet",
        OnFoot: true
    });
    director.handleStatus({
        BodyName: "Remembered 3 a",
        Flags: statusFlags(21),
        Flags2: statusFlags(0, 4)
    });
    assert.equal(engine.lastBase()[2].context.planetClass, "Icy body");
    assert.equal(engine.lastBase()[2].reason, "On-foot expedition · Icy body");
});

test("bio sample collection gets a hard accent and Analyse gets the extended species finale", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });

    director.handleJournalEvent({
        event: "ScanOrganic",
        ScanType: "Sample",
        Species: "$Codex_Ent_Bacterial_Genus_Name;"
    });
    director.handleJournalEvent({
        event: "ScanOrganic",
        ScanType: "Analyse",
        Species: "$Codex_Ent_Bacterial_Genus_Name;"
    });

    const [sample, complete] = engine.cues("organic_scan");
    assert.equal(sample[2].durationMs, 880);
    assert.equal(sample[2].reason, "Bio sample collected");
    assert.equal(sample[2].priority, 975);
    assert.equal(sample[2].exclusiveGroup, "event-accent");
    assert.equal(sample[2].context.completed, false);
    assert.equal(complete[2].durationMs, 1_590);
    assert.equal(complete[2].reason, "Bio sample collected: species complete");
    assert.equal(complete[2].priority, 975);
    assert.equal(complete[2].exclusiveGroup, "event-accent");
    assert.equal(complete[2].context.completed, true);
    assert.equal(complete[2].context.scanType, "Analyse");
});

test("combat kills use a dedicated accent instead of the generic payout scene", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    for (const event of ["Bounty", "CapShipBond", "FactionKillBond", "PVPKill"]) {
        director.handleJournalEvent({ event });
    }
    director.handleJournalEvent({ event: "RedeemVoucher", Type: "bounty" });

    assert.equal(engine.cues("kill_confirmed").length, 4);
    assert.equal(engine.cues("reward").length, 1);
    for (const call of engine.cues("kill_confirmed")) {
        assert.equal(call[2].durationMs, 850);
        assert.equal(call[2].priority, 975);
        assert.equal(call[2].exclusiveGroup, "event-accent");
    }
});

test("maps cargo, contracts, rescue, payouts, trades, and screenshots from the real journal corpus", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    for (const event of [
        { event: "CollectCargo", Type: "gold" },
        { event: "EjectCargo", Type: "gold" },
        { event: "MissionAccepted", Name: "Delivery" },
        { event: "SearchAndRescue", Name: "OccupiedEscapePod" },
        { event: "RedeemVoucher", Type: "bounty" },
        { event: "SellOrganicData" },
        { event: "MaterialTrade", Paid: { iron: 1 } },
        { event: "Screenshot", Filename: "example.bmp" }
    ]) director.handleJournalEvent(event);
    for (const scene of ["cargo_transfer", "mission_accepted", "rescue_complete", "reward", "engineer_craft", "camera_flash"]) {
        assert.ok(engine.cues(scene).length > 0, scene);
    }
    assert.deepEqual(engine.cues("cargo_transfer").map((call) => call[2].context.direction), ["in", "out"]);
});

test("colonisation depot snapshots hydrate silently and cue only a real delivery delta", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    const depot = (provided, complete = false) => ({
        event: "ColonisationConstructionDepot",
        MarketID: 42,
        ConstructionComplete: complete,
        ResourcesRequired: [{ Name: "steel", RequiredAmount: 100, ProvidedAmount: provided }]
    });
    director.handleJournalEvent(depot(10));
    director.handleJournalEvent(depot(10));
    assert.equal(engine.cues("cargo_transfer").length, 0);
    director.handleJournalEvent(depot(25));
    assert.equal(engine.cues("cargo_transfer").length, 1);
    assert.equal(engine.cues("cargo_transfer")[0][2].context.amount, 15);
    director.handleJournalEvent(depot(25, true));
    assert.equal(engine.cues("reward").length, 1);
});

test("Shutdown latches off against a trailing Status update until LoadGame", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "Shutdown" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(4, 24) });
    assert.equal(director.getWorldState().sessionActive, false);
    assert.equal(engine.calls.filter((call) => call[0] === "stop").at(-1)[1], "Shutdown");
    director.handleJournalEvent({ event: "LoadGame" });
    assert.equal(director.getWorldState().sessionActive, true);
});

test("manual Stop Now does not relight on the next periodic Status snapshot", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.stopNow("tray_stop");
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(4, 24) });
    assert.equal(director.getWorldState().sessionActive, false);
    assert.equal(engine.calls.filter((call) => call[0] === "beginSession").length, 1);
});

test("an explicit lighting re-enable resumes the current live game", () => {
    const { director, engine } = createDirector();
    director.handleGameProcess(true);
    director.stopNow("tray_stop");
    director.allowResume();
    assert.equal(director.getWorldState().sessionActive, true);
    assert.equal(engine.calls.filter((call) => call[0] === "beginSession").length, 2);
});

test("Resurrect clears the death latch and cancels the pending blackout", () => {
    const { director, engine, timers } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    director.handleJournalEvent({ event: "Died" });
    const deathTimer = timers.at(-1);
    assert.equal(director.getWorldState().shutdownLatched, true);
    director.handleJournalEvent({ event: "Resurrect" });
    assert.equal(deathTimer.cleared, true);
    assert.equal(director.getWorldState().sessionActive, true);
    assert.equal(director.getWorldState().shutdownLatched, false);
    assert.equal(engine.cues("systems_reboot").length, 1);
});

test("BigInt journal IDs are safe and false Thargoid metadata cannot latch an alien scene", () => {
    const { director, engine } = createDirector();
    director.handleJournalEvent({ event: "LoadGame" });
    assert.doesNotThrow(() => director.handleJournalEvent({ event: "MissionAccepted", MissionID: 42n }));
    director.handleJournalEvent({ event: "Location", IsThargoid: false, ThargoidWar: { CurrentState: "None" } });
    assert.equal(director.getWorldState().thargoidEncounter, false);
    director.handleJournalEvent({ event: "Interdicted", IsThargoid: true });
    assert.equal(director.getWorldState().thargoidEncounter, true);
    assert.equal(engine.lastBase()[1], "thargoid_encounter");
});

test("tray previews restore the live scene or stop when no game is active", () => {
    const { director, engine, timers } = createDirector();
    director.previewScene("witchspace", { durationMs: 3_000 });
    assert.equal(engine.lastBase()[1], "witchspace");
    timers.at(-1).callback();
    assert.equal(engine.calls.filter((call) => call[0] === "stop").at(-1)[1], "preview_complete");

    director.handleJournalEvent({ event: "LoadGame" });
    director.handleStatus({ timestamp: "2026-08-04T01:00:00Z", Flags: statusFlags(4, 24) });
    director.previewScene("overheat", { durationMs: 1_000 });
    assert.equal(engine.cues("overheat").at(-1)[2].source, "manual");
    timers.at(-1).callback();
    assert.equal(engine.lastBase()[1], "supercruise");
});

test("game exit cancels a preview so a rapid restart can reconcile immediately", () => {
    const { director, engine, timers } = createDirector();
    director.handleGameProcess(true);
    director.previewScene("witchspace", { durationMs: 10_000 });
    const previewTimer = timers.at(-1);
    director.handleGameProcess(false);
    assert.equal(previewTimer.cleared, true);
    director.handleGameProcess(true);
    assert.equal(engine.lastBase()[1], "main_menu");
});

test("an absent-game probe releases a preview-only G560 session", () => {
    const { director, engine, timers } = createDirector();
    director.previewScene("witchspace", { durationMs: 10_000 });
    const previewTimer = timers.at(-1);
    assert.equal(engine.sessionActive, true);
    assert.equal(director.getWorldState().sessionActive, false);
    director.handleGameProcess(false);
    assert.equal(previewTimer.cleared, true);
    assert.equal(engine.sessionActive, false);
    assert.equal(engine.calls.filter((call) => call[0] === "stop").at(-1)[1], "Elite Dangerous closed");
});

test("LoadGame cancels a manual preview and immediately establishes a live base", () => {
    const { director, engine } = createDirector();
    director.previewScene("overheat", { durationMs: 10_000 });
    director.handleJournalEvent({ event: "LoadGame", timestamp: "2026-08-04T01:00:00Z" });
    assert.equal(engine.calls.filter((call) => call[0] === "clearTransient").at(-1)[1].source, "manual");
    assert.equal(engine.lastBase()[1], "normal_flight");
});
