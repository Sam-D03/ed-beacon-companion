import assert from "node:assert/strict";
import test from "node:test";

import {
    BLACK_FRAME,
    LIGHTING_ZONES,
    compositeFrame,
    createFrame,
    frameToPercentages,
    hexColor,
    scaleColor
} from "../src/lighting/lighting-color.mjs";
import { LightingEngine } from "../src/lighting/lighting-engine.mjs";
import { deriveSeed, fractalNoise, randomImpulse } from "../src/lighting/lighting-random.mjs";
import { isWhiteDwarfClass, listLightingScenes, sampleLightingScene, starClassColor } from "../src/lighting/lighting-scene-catalog.mjs";

function assertValidFrame(frame) {
    assert.deepEqual(Object.keys(frame).sort(), [...LIGHTING_ZONES].sort());
    for (const zone of LIGHTING_ZONES) {
        for (const channel of ["r", "g", "b"]) {
            assert.equal(Number.isFinite(frame[zone][channel]), true, `${zone}.${channel} should be finite`);
            assert.ok(frame[zone][channel] >= 0 && frame[zone][channel] <= 1, `${zone}.${channel} should be bounded`);
        }
    }
}

class FakeProvider {
    constructor() {
        this.connected = false;
        this.frames = [];
        this.releases = [];
    }
    getStatus() {
        return { available: true, detected: true, connected: this.connected, state: this.connected ? "connected" : "ready" };
    }
    async connect() {
        this.connected = true;
        return true;
    }
    async writeFrame(frame) {
        this.frames.push(structuredClone(frame));
        return true;
    }
    async release(reason) {
        this.releases.push(reason);
        this.connected = false;
    }
    async destroy() {}
}

function createTestEngine({ provider = new FakeProvider(), nowRef = { value: 0 } } = {}) {
    return {
        provider,
        nowRef,
        engine: new LightingEngine({
            provider,
            now: () => nowRef.value,
            setTimeoutFn: () => ({ unref() {} }),
            clearTimeoutFn: () => {},
            installSeed: 12345,
            brightness: 1,
            zoneGains: Object.fromEntries(LIGHTING_ZONES.map((zone) => [zone, 1]))
        })
    };
}

test("all catalogue scenes render finite four-zone frames", () => {
    const scenes = listLightingScenes();
    assert.equal(scenes.length, 108);
    for (const scene of scenes) {
        for (const elapsedMs of [0, 137, 1_000, 8_765, 60_000]) {
            assertValidFrame(sampleLightingScene(scene.id, {
                elapsedMs,
                durationMs: 10_000,
                nowMs: elapsedMs,
                seed: 0xdecafbad,
                context: { temperature: 430, health: 0.25, oxygen: 0.3 }
            }).frame);
        }
    }
});

test("release failures are observable even though fire-and-forget callers remain safe", async () => {
    const provider = new FakeProvider();
    provider.release = async () => {
        throw new Error("release timeout");
    };
    const { engine } = createTestEngine({ provider });
    assert.equal(await engine.release("test_failure"), false);
    assert.match(engine.getStatus().lastError, /release timeout/);
});

test("render faults are contained, reported, and release physical ownership", async () => {
    const { engine, provider } = createTestEngine();
    engine.beginSession("render-fault");
    engine.setBaseScene("normal_flight", { transitionMs: 0 });
    engine.renderFrameAt = () => { throw new Error("synthetic render fault"); };
    await assert.doesNotReject(() => engine.tick());
    assert.match(engine.getStatus().lastError, /synthetic render fault/);
    assert.deepEqual(provider.releases, ["render_failed"]);
});

test("journal star-class codes select the intended destination palette", () => {
    for (const [code, color] of [
        ["N", "#8f43ff"],
        ["W", "#8f43ff"],
        ["WNC", "#8f43ff"],
        ["H", "#ffffff"],
        ["SuperMassiveBlackHole", "#ffffff"],
        ["D", "#dffaff"],
        ["DO", "#dffaff"],
        ["DAZ", "#dffaff"],
        ["O", "#187cff"],
        ["G", "#ffd35a"]
    ]) assert.deepEqual(starClassColor(code), hexColor(color), code);
    for (const code of ["D", "DA", "DAB", "DAO", "DAZ", "DAV", "DB", "DBZ", "DBV", "DO", "DOV", "DQ", "DC", "DCV", "DX"]) {
        assert.equal(isWhiteDwarfClass(code), true, code);
    }
});

test("primary-star arrival starts at maximum class colour then decays into in-system starlight", () => {
    const context = { starClass: "G", systemArrivalAtMs: 1_000, supercruise: true };
    const entry = sampleLightingScene("system_flight", { elapsedMs: 2_000, wallNowMs: 3_000, seed: 42, context }).frame;
    const distant = sampleLightingScene("system_flight", { elapsedMs: 100_000, wallNowMs: 101_000, seed: 42, context }).frame;
    for (const zone of LIGHTING_ZONES) {
        assert.ok(entry[zone].r >= 0.95, `${zone} should hold maximum G-star red output near arrival`);
        assert.ok(entry[zone].g >= 0.6, `${zone} should be strongly gold near arrival`);
        assert.notDeepEqual(distant[zone], entry[zone]);
        assert.ok(distant[zone].r + distant[zone].g + distant[zone].b < entry[zone].r + entry[zone].g + entry[zone].b);
    }
});

test("white-dwarf arrival is an ice-white and electric-blue irregular flicker mix", () => {
    const context = { starClass: "DAZ", systemArrivalAtMs: 1_000, supercruise: true };
    const first = sampleLightingScene("system_flight", { elapsedMs: 1_200, wallNowMs: 2_200, seed: 73, context }).frame;
    const second = sampleLightingScene("system_flight", { elapsedMs: 1_530, wallNowMs: 2_530, seed: 73, context }).frame;
    assert.notDeepEqual(first, second);
    for (const frame of [first, second]) {
        for (const zone of LIGHTING_ZONES) {
            assert.ok(frame[zone].b >= frame[zone].r, `${zone} should remain blue/ice weighted`);
            assert.ok(frame[zone].b >= 0.95, `${zone} should retain a maximum-bright blue channel`);
        }
    }
});

test("hyperspace arrival flare inherits the primary star colour instead of generic cyan", () => {
    const redStar = sampleLightingScene("arrival", { elapsedMs: 0, durationMs: 2_800, seed: 19, context: { starClass: "M" } }).frame;
    assert.ok(redStar.leftRear.r > redStar.leftRear.b * 5);
    assert.ok(redStar.rightRear.r > redStar.rightRear.g * 2);

    const whiteDwarf = sampleLightingScene("arrival", { elapsedMs: 80, durationMs: 2_800, seed: 19, context: { starClass: "DBV" } }).frame;
    assert.ok(whiteDwarf.leftFront.b >= whiteDwarf.leftFront.r);
    assert.ok(whiteDwarf.rightFront.b >= whiteDwarf.rightFront.r);
});

test("the scanned body colour dominates orbit, glide, landed, SRV, and on-foot ambience", () => {
    for (const sceneId of ["planetary_flight", "glide", "landed", "srv", "on_foot_surface"]) {
        const water = sampleLightingScene(sceneId, {
            elapsedMs: 2_100,
            seed: 73,
            context: { planetClass: "Water world", gravity: 0.18 }
        }).frame;
        const metal = sampleLightingScene(sceneId, {
            elapsedMs: 2_100,
            seed: 73,
            context: { planetClass: "High metal content body", gravity: 0.18 }
        }).frame;

        for (const zone of LIGHTING_ZONES) {
            assert.ok(water[zone].b > water[zone].r, `${sceneId}/${zone} should be water-blue dominant`);
            assert.ok(metal[zone].r > metal[zone].b, `${sceneId}/${zone} should be rust dominant`);
        }
        assert.notDeepEqual(water, metal, `${sceneId} should visibly follow PlanetClass`);
    }
});

test("discrete event accents use hard full-room cuts and completely suppress ambience", () => {
    const accentIds = [
        "fuel_scoop_complete", "shields_restored", "scan_complete", "body_scan_complete", "dss_scan_complete", "organic_scan",
        "asteroid_cracked", "kill_confirmed", "reward", "crime", "mission_failed",
        "engineer_craft", "escape", "interdiction_success", "interdiction_failed",
        "docking_denied", "mission_accepted", "rescue_complete", "camera_flash"
    ];
    const metadata = new Map(listLightingScenes().map((scene) => [scene.id, scene]));
    for (const sceneId of accentIds) {
        const scene = metadata.get(sceneId);
        assert.equal(scene.blend, "replace", sceneId);
        assert.equal(scene.enterMs, 0, sceneId);
        assert.equal(scene.exitMs, 0, sceneId);
        const sample = sampleLightingScene(sceneId, { elapsedMs: 0, durationMs: 2_000, context: {} });
        assert.equal(sample.opacity, 1, sceneId);
        assert.equal(sample.dimUnderlay, 1, sceneId);
        assert.equal(new Set(LIGHTING_ZONES.map((zone) => JSON.stringify(sample.frame[zone]))).size, 1, `${sceneId} must fill the room with one solid colour`);
    }

    const { engine, nowRef } = createTestEngine();
    engine.beginSession("accent-test");
    engine.setBaseScene("docked", { transitionMs: 0 });
    engine.triggerOverlay("scan_complete", { durationMs: 540, priority: 975, exclusiveGroup: "event-accent" });
    assert.deepEqual(engine.renderFrameAt(), createFrame(hexColor("#20d8ff")));
    nowRef.value = 170;
    assert.deepEqual(engine.renderFrameAt(), BLACK_FRAME, "the black cut must suppress the ambient scene rather than reveal it");
    nowRef.value = 260;
    assert.deepEqual(engine.renderFrameAt(), createFrame(hexColor("#ffd35a")));
});

test("DSS completion is one restrained cool-blue acknowledgement with no orange beat", () => {
    const active = sampleLightingScene("dss_scan_complete", { elapsedMs: 100, durationMs: 320 });
    const finished = sampleLightingScene("dss_scan_complete", { elapsedMs: 320, durationMs: 320 });
    for (const zone of LIGHTING_ZONES) {
        assert.ok(active.frame[zone].b > active.frame[zone].g);
        assert.ok(active.frame[zone].g > active.frame[zone].r);
        assert.ok(active.frame[zone].b <= 0.32, `${zone} should stay at restrained output`);
    }
    assert.deepEqual(finished.frame, BLACK_FRAME);
});

test("FSS body completion uses the scanned planet class colour for every hard beat", () => {
    const water = sampleLightingScene("body_scan_complete", {
        elapsedMs: 80,
        durationMs: 540,
        context: { planetClass: "Water world" }
    }).frame;
    const rocky = sampleLightingScene("body_scan_complete", {
        elapsedMs: 300,
        durationMs: 540,
        context: { planetClass: "Rocky body" }
    }).frame;
    assert.deepEqual(water, createFrame(hexColor("#2c86ae")));
    assert.deepEqual(rocky, createFrame(hexColor("#8e715f")));
});

test("fighter launch rotates a bright orange hangar beacon clockwise around all four zones", () => {
    const brightestZone = (elapsedMs) => {
        const frame = sampleLightingScene("fighter_launch", { elapsedMs, durationMs: 5_000 }).frame;
        return LIGHTING_ZONES.reduce((brightest, zone) => {
            const intensity = frame[zone].r + frame[zone].g + frame[zone].b;
            return intensity > brightest.intensity ? { zone, intensity } : brightest;
        }, { zone: null, intensity: -1 }).zone;
    };
    assert.deepEqual(
        [0, 230, 460, 690].map(brightestZone),
        ["leftRear", "leftFront", "rightFront", "rightRear"]
    );
    for (const elapsedMs of [0, 230, 460, 690, 920]) {
        const sample = sampleLightingScene("fighter_launch", { elapsedMs, durationMs: 5_000 });
        assert.equal(sample.dimUnderlay, 0.68);
        for (const zone of LIGHTING_ZONES) {
            assert.ok(sample.frame[zone].r >= sample.frame[zone].b, `${zone} should stay in the orange family`);
        }
    }
});

test("bio sample and species completion use crisp colour beats with no interpolated frames", () => {
    const sampleAt = (elapsedMs, completed = false) => sampleLightingScene("organic_scan", {
        elapsedMs,
        durationMs: completed ? 1_590 : 880,
        context: { scanType: completed ? "Analyse" : "Sample", completed }
    }).frame;

    assert.deepEqual(sampleAt(0), createFrame(hexColor("#ffffff")));
    assert.deepEqual(sampleAt(150), BLACK_FRAME);
    assert.deepEqual(sampleAt(250), createFrame(hexColor("#9cff26")));
    assert.deepEqual(sampleAt(650), createFrame(hexColor("#20d8ff")));
    assert.deepEqual(sampleAt(1_100, true), createFrame(hexColor("#ffd35a")));
    assert.deepEqual(sampleAt(1_450, true), createFrame(hexColor("#ffffff")));
});

test("docked ambience holds a warm four-zone wash with sparse varied station activity", () => {
    const seed = 0x5a17;
    const zones = ["leftRear", "leftFront", "rightFront", "rightRear"];
    const quiet = sampleLightingScene("docked", { elapsedMs: 0, seed }).frame;

    for (const zone of zones) {
        assert.ok(quiet[zone].r > 0 && quiet[zone].g > 0 && quiet[zone].b > 0);
        assert.ok(quiet[zone].r >= quiet[zone].g);
        assert.ok(quiet[zone].g >= quiet[zone].b);
    }

    const longFormFrames = new Set();
    let active = false;
    let activityRuns = 0;
    let sawElectricBlue = false;
    for (let elapsedMs = 0; elapsedMs <= 600_000; elapsedMs += 25) {
        const frame = sampleLightingScene("docked", { elapsedMs, seed }).frame;
        const peak = Math.max(...zones.flatMap((zone) => [frame[zone].r, frame[zone].g, frame[zone].b]));
        const activity = peak > 0.45;
        if (activity && !active) activityRuns += 1;
        active = activity;
        sawElectricBlue ||= zones.some((zone) =>
            frame[zone].b > 0.3 && frame[zone].b > frame[zone].r * 1.2
        );
        if (elapsedMs % 2_000 === 0) {
            longFormFrames.add(JSON.stringify(frame));
        }
    }

    assert.ok(activityRuns >= 5 && activityRuns <= 40);
    assert.equal(sawElectricBlue, true);
    assert.ok(longFormFrames.size > 250);
});

test("docking clearance mirrors station lane lights with a hard orange double rear strobe", () => {
    const firstFlash = sampleLightingScene("docking_clearance", { elapsedMs: 50 });
    const interFlash = sampleLightingScene("docking_clearance", { elapsedMs: 160 });
    const secondFlash = sampleLightingScene("docking_clearance", { elapsedMs: 260 });
    const pause = sampleLightingScene("docking_clearance", { elapsedMs: 500 });

    for (const sample of [firstFlash, interFlash, secondFlash, pause]) {
        assert.deepEqual(sample.frame.leftFront, hexColor("#ff160d"));
        assert.deepEqual(sample.frame.rightFront, hexColor("#39b810"));
        assert.equal(sample.blend, "replace");
        assert.equal(sample.opacity, 1);
    }

    assert.deepEqual(firstFlash.frame.leftRear, hexColor("#ff7100"));
    assert.deepEqual(firstFlash.frame.rightRear, hexColor("#ff7100"));
    assert.deepEqual(interFlash.frame.leftRear, hexColor("#000000"));
    assert.deepEqual(interFlash.frame.rightRear, hexColor("#000000"));
    assert.deepEqual(secondFlash.frame.leftRear, hexColor("#ff7100"));
    assert.deepEqual(secondFlash.frame.rightRear, hexColor("#ff7100"));
    assert.deepEqual(pause.frame.leftRear, hexColor("#000000"));
    assert.deepEqual(pause.frame.rightRear, hexColor("#000000"));
});

test("FSD charging copies the MDCU 840ms cadence as synchronized blue brightness", () => {
    for (const [elapsedMs, intensity] of [
        [100, 1 / 3],
        [300, 2 / 3],
        [500, 1],
        [690, 160 / 255],
        [750, 64 / 255],
        [810, 0]
    ]) {
        const sample = sampleLightingScene("fsd_charge", { elapsedMs });
        const expected = scaleColor(hexColor("#187cff"), intensity);
        for (const zone of LIGHTING_ZONES) assert.deepEqual(sample.frame[zone], expected);
        assert.equal(sample.blend, "replace");
    }
});

test("FSD countdown copies the MDCU five-second red beat and final fill timing", () => {
    for (const elapsedMs of [100, 1_100, 2_100, 3_100]) {
        const sample = sampleLightingScene("fsd_countdown", { elapsedMs });
        for (const zone of LIGHTING_ZONES) assert.deepEqual(sample.frame[zone], hexColor("#ff160d"));
        assert.equal(sample.blend, "replace");
    }
    for (const elapsedMs of [500, 1_500, 2_500, 3_500, 5_000]) {
        const sample = sampleLightingScene("fsd_countdown", { elapsedMs });
        for (const zone of LIGHTING_ZONES) assert.deepEqual(sample.frame[zone], hexColor("#000000"));
    }
    for (const [elapsedMs, intensity] of [[4_050, 1 / 3], [4_180, 2 / 3], [4_500, 1]]) {
        const sample = sampleLightingScene("fsd_countdown", { elapsedMs });
        const expected = scaleColor(hexColor("#ff160d"), intensity);
        for (const zone of LIGHTING_ZONES) assert.deepEqual(sample.frame[zone], expected);
    }
});

test("supercruise overcharge is a violent blue pulse with irregular white star streaks", () => {
    const seed = 0x5c0;
    const frames = [];
    const whiteFlashByZone = Object.fromEntries(LIGHTING_ZONES.map((zone) => [zone, false]));
    let redTotal = 0;
    let blueTotal = 0;

    for (let elapsedMs = 0; elapsedMs <= 8_000; elapsedMs += 10) {
        const frame = sampleLightingScene("supercruise_overcharge", { elapsedMs, seed }).frame;
        frames.push(JSON.stringify(frame));
        for (const zone of LIGHTING_ZONES) {
            redTotal += frame[zone].r;
            blueTotal += frame[zone].b;
            whiteFlashByZone[zone] ||= frame[zone].r > 0.72 && frame[zone].g > 0.72 && frame[zone].b > 0.9;
        }
    }

    assert.ok(blueTotal > redTotal * 4, "the sustained SCO wash should remain strongly blue");
    assert.ok(Object.values(whiteFlashByZone).every(Boolean), "every zone should receive strong white star streaks");
    assert.ok(new Set(frames).size > 700, "SCO should keep moving rather than repeat a short loop");
    assert.deepEqual(
        sampleLightingScene("supercruise_overcharge", { elapsedMs: 3_217, seed }).frame,
        sampleLightingScene("supercruise_overcharge", { elapsedMs: 3_217, seed }).frame
    );
    assert.notDeepEqual(
        sampleLightingScene("supercruise_overcharge", { elapsedMs: 3_217, seed }).frame,
        sampleLightingScene("supercruise_overcharge", { elapsedMs: 3_217, seed: seed + 1 }).frame
    );
});

test("cockpit panel focus follows Elite's right and left UI panels", () => {
    const rightPanel = sampleLightingScene("cockpit_panel", { elapsedMs: 1_000, context: { guiFocus: 1 } }).frame;
    const leftPanel = sampleLightingScene("cockpit_panel", { elapsedMs: 1_000, context: { guiFocus: 2 } }).frame;
    assert.ok(rightPanel.rightFront.r > rightPanel.leftFront.r);
    assert.ok(leftPanel.leftFront.r > leftPanel.rightFront.r);
});

test("procedural scenes are deterministic at an absolute timestamp and vary by seed", () => {
    const originalRandom = Math.random;
    Math.random = () => { throw new Error("rendering must not consume Math.random"); };
    const first = sampleLightingScene("witchspace", { elapsedMs: 8_234, seed: 42 }).frame;
    const repeated = sampleLightingScene("witchspace", { elapsedMs: 8_234, seed: 42 }).frame;
    const alternate = sampleLightingScene("witchspace", { elapsedMs: 8_234, seed: 43 }).frame;
    Math.random = originalRandom;
    assert.deepEqual(first, repeated);
    assert.notDeepEqual(first, alternate);
    assert.equal(fractalNoise(deriveSeed("jump", 1), 12_345), fractalNoise(deriveSeed("jump", 1), 12_345));
    assert.equal(randomImpulse(99, 2_222), randomImpulse(99, 2_222));
});

test("combat exchanges choose seeded sides with smooth non-repeating handoffs", () => {
    const first = sampleLightingScene("combat_ambience", { elapsedMs: 7_321, seed: 101 }).frame;
    const repeated = sampleLightingScene("combat_ambience", { elapsedMs: 7_321, seed: 101 }).frame;
    const alternate = sampleLightingScene("combat_ambience", { elapsedMs: 7_321, seed: 202 }).frame;
    assert.deepEqual(first, repeated);
    assert.notDeepEqual(first, alternate);

    const before = sampleLightingScene("combat_ambience", { elapsedMs: 1_299, seed: 101 }).frame;
    const after = sampleLightingScene("combat_ambience", { elapsedMs: 1_301, seed: 101 }).frame;
    const largestStep = Math.max(...LIGHTING_ZONES.flatMap((zone) =>
        ["r", "g", "b"].map((channel) => Math.abs(before[zone][channel] - after[zone][channel]))));
    assert.ok(largestStep < 0.05, `combat handoff jumped by ${largestStep}`);
});

test("linear mixer dims the underlay before screen blending", () => {
    const blue = createFrame(hexColor("#0000ff"));
    const red = createFrame(hexColor("#ff0000"));
    const result = compositeFrame(blue, red, { blend: "screen", opacity: 1, dimUnderlay: 1 });
    for (const zone of LIGHTING_ZONES) {
        assert.equal(result[zone].r, 1);
        assert.equal(result[zone].g, 0);
        assert.equal(result[zone].b, 0);
    }
    assert.deepEqual(frameToPercentages(BLACK_FRAME), Object.fromEntries(LIGHTING_ZONES.map((zone) => [zone, [0, 0, 0]])));
});

test("warning overlays do not restart the ambient scene phase", () => {
    const { engine, nowRef } = createTestEngine();
    engine.beginSession("session-a");
    engine.setBaseScene("supercruise", { transitionMs: 0 });
    nowRef.value = 5_000;
    const before = engine.renderFrameAt();
    engine.triggerOverlay("overheat", { durationMs: 3_000, priority: 800, reason: "HeatWarning" });
    nowRef.value = 5_500;
    const layered = engine.renderFrameAt();
    assert.notDeepEqual(layered, before);
    assert.equal(engine.base.enteredAt, 0);
    nowRef.value = 9_000;
    const resumed = engine.renderFrameAt();
    const directAmbient = sampleLightingScene("supercruise", {
        elapsedMs: 9_000,
        nowMs: 9_000,
        seed: engine.base.seed,
        context: {}
    }).frame;
    assert.deepEqual(resumed, directAmbient);
});

test("output frames are deduplicated only after a successful write and release restores ownership", async () => {
    const { engine, provider, nowRef } = createTestEngine();
    engine.beginSession("session-b");
    engine.setBaseScene("idle", { transitionMs: 0 });
    await engine.tick();
    assert.equal(provider.frames.length, 1);
    nowRef.value = 34;
    await engine.tick();
    assert.equal(provider.frames.length, 1);
    assert.equal(engine.getStatus().framesDeduplicated, 1);
    await engine.destroy("test_exit");
    assert.deepEqual(provider.releases, ["test_exit"]);
});

test("exclusive persistent groups select the highest-priority layer", () => {
    const { engine, nowRef } = createTestEngine();
    engine.beginSession("session-c");
    engine.setBaseScene("normal_flight", { transitionMs: 0 });
    engine.setPersistentLayers([
        { key: "danger", sceneId: "danger", priority: 700, exclusiveGroup: "critical", reason: "In danger" },
        { key: "heat", sceneId: "overheat", priority: 800, exclusiveGroup: "critical", reason: "Overheating" }
    ]);
    nowRef.value = 1_000;
    const layers = engine.activeLayerInstances(nowRef.value);
    assert.deepEqual(layers.map((layer) => layer.sceneId), ["overheat"]);
    assert.equal(engine.getStatus().dominantCue.sceneId, "overheat");
});

test("exclusive groups crossfade through scene envelopes without dropping the underlay", () => {
    const { engine, nowRef } = createTestEngine();
    engine.beginSession("exclusive-crossfade");
    engine.setBaseScene("normal_flight", { transitionMs: 0 });
    engine.setPersistentLayers([
        { key: "danger", sceneId: "danger", priority: 700, exclusiveGroup: "critical" }
    ]);
    nowRef.value = 1_000;
    engine.setPersistentLayers([
        { key: "danger", sceneId: "danger", priority: 700, exclusiveGroup: "critical" },
        { key: "heat", sceneId: "overheat", priority: 800, exclusiveGroup: "critical" }
    ]);

    let composite = engine.compositingLayerInstances(nowRef.value);
    assert.equal(composite.find((layer) => layer.key === "danger").exclusiveWeight, 1);
    nowRef.value = 1_032;
    composite = engine.compositingLayerInstances(nowRef.value);
    const midAttackWeight = composite.find((layer) => layer.key === "danger").exclusiveWeight;
    assert.ok(midAttackWeight > 0 && midAttackWeight < 1);
    nowRef.value = 1_065;
    composite = engine.compositingLayerInstances(nowRef.value);
    assert.equal(composite.find((layer) => layer.key === "danger").exclusiveWeight, 0);

    engine.setPersistentLayers([
        { key: "danger", sceneId: "danger", priority: 700, exclusiveGroup: "critical" }
    ]);
    nowRef.value = 1_515;
    composite = engine.compositingLayerInstances(nowRef.value);
    const midReleaseWeight = composite.find((layer) => layer.key === "danger").exclusiveWeight;
    assert.ok(midReleaseWeight > 0 && midReleaseWeight < 1);
});

test("a persistent semantic slot crossfades when its scene changes", () => {
    const { engine, nowRef } = createTestEngine();
    engine.beginSession("slot-crossfade");
    engine.setBaseScene("normal_flight", { transitionMs: 0 });
    engine.setPersistentLayers([
        { key: "docking", sceneId: "docking_request", priority: 430 }
    ]);
    nowRef.value = 1_000;
    const before = engine.renderFrameAt(nowRef.value);
    engine.setPersistentLayers([
        { key: "docking", sceneId: "docking_clearance", priority: 470 }
    ]);
    const after = engine.renderFrameAt(nowRef.value);
    assert.deepEqual(after, before);
    const transition = engine.compositingLayerInstances(nowRef.value);
    assert.deepEqual(transition.map((layer) => layer.sceneId), ["docking_request", "docking_clearance"]);
    assert.equal(transition[0].exclusiveGroup, "replacement:docking");
    assert.equal(transition[1].exclusiveGroup, "replacement:docking");

    nowRef.value = 2_500;
    assert.deepEqual(engine.compositingLayerInstances(nowRef.value).map((layer) => layer.sceneId), ["docking_clearance"]);
});

test("clearing a cue preserves its current natural-tail brightness", () => {
    const nowRef = { value: 0 };
    const { engine } = createTestEngine({ nowRef });
    engine.beginSession("tail-preservation");
    engine.triggerOverlay("fsd_charge", { key: "charge", durationMs: 1_000 });
    const layer = engine.transientLayers[0];
    nowRef.value = 800;
    const scene = listLightingScenes().find((candidate) => candidate.id === "fsd_charge");
    const before = engine.layerEnvelope(layer, scene, nowRef.value);
    engine.clearTransientLayers({ key: "charge" });
    const after = engine.layerEnvelope(layer, scene, nowRef.value);
    assert.equal(after, before);
    nowRef.value = 900;
    assert.ok(engine.layerEnvelope(layer, scene, nowRef.value) < after);
});

test("a keyed cue retriggered during release starts a fresh active envelope", () => {
    const nowRef = { value: 0 };
    const { engine } = createTestEngine({ nowRef });
    engine.beginSession("release-retrigger");
    const original = engine.triggerOverlay("interdiction", { key: "tug", durationMs: 2_000 });
    nowRef.value = 500;
    engine.clearTransientLayers({ key: "tug" });
    assert.equal(original.exitingAt, 500);
    nowRef.value = 600;
    const retriggered = engine.triggerOverlay("interdiction", { key: "tug", durationMs: 2_000 });
    assert.equal(retriggered, original);
    assert.equal(retriggered.exitingAt, null);
    assert.equal(retriggered.enteredAt, 600);
    assert.ok(engine.activeLayerInstances(nowRef.value).some((layer) => layer.key === "tug"));
});

test("reduced-flashing mode slews abrupt full-frame changes", () => {
    const { engine, nowRef } = createTestEngine();
    engine.setReducedFlashing(true);
    const white = createFrame(hexColor("#ffffff"));
    const first = engine.prepareOutputFrame(white, nowRef.value);
    for (const zone of LIGHTING_ZONES) {
        assert.ok(first[zone].r > 0 && first[zone].r < 0.25);
    }
    nowRef.value = 220;
    const second = engine.prepareOutputFrame(white, nowRef.value);
    assert.ok(second.leftFront.r > first.leftFront.r);
    assert.ok(second.leftFront.r < 1);
});

test("connection retries use bounded backoff only while a session requests light", async () => {
    const provider = new FakeProvider();
    let attempts = 0;
    provider.connect = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("G HUB starting");
        provider.connected = true;
        return true;
    };
    const nowRef = { value: 0 };
    const { engine } = createTestEngine({ provider, nowRef });
    engine.beginSession("retry-session");
    engine.setBaseScene("normal_flight", { transitionMs: 0 });
    await engine.tick();
    assert.equal(attempts, 1);
    nowRef.value = 999;
    await engine.tick();
    assert.equal(attempts, 1);
    nowRef.value = 1_000;
    await engine.tick();
    assert.equal(attempts, 2);
    assert.equal(provider.frames.length, 1);
    engine.stopNow("test_stop");
    nowRef.value = 40_000;
    await engine.tick();
    assert.equal(attempts, 2);
});

test("scene updates cannot start a second render tick while provider connection is pending", async () => {
    let resolveConnection;
    const connectionGate = new Promise((resolve) => { resolveConnection = resolve; });
    const provider = new FakeProvider();
    provider.connect = async () => {
        await connectionGate;
        provider.connected = true;
        return true;
    };
    const timers = [];
    const engine = new LightingEngine({
        provider,
        now: () => 0,
        setTimeoutFn: (callback) => {
            const timer = { callback, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimeoutFn: () => {},
        installSeed: 12345,
        brightness: 1,
        zoneGains: Object.fromEntries(LIGHTING_ZONES.map((zone) => [zone, 1]))
    });

    engine.beginSession("deferred-connection");
    engine.setBaseScene("normal_flight", { transitionMs: 0 });
    assert.equal(timers.length, 1);

    timers.shift().callback();
    await Promise.resolve();
    engine.triggerOverlay("scan", { durationMs: 1_000 });
    assert.equal(timers.length, 0);

    resolveConnection();
    await new Promise(setImmediate);
    assert.equal(provider.frames.length, 1);
    assert.equal(timers.length, 1);
});

test("transient countdowns do not publish tray status at render-frame frequency", async () => {
    const provider = new FakeProvider();
    const nowRef = { value: 0 };
    let statusUpdates = 0;
    const engine = new LightingEngine({
        provider,
        now: () => nowRef.value,
        setTimeoutFn: () => ({ unref() {} }),
        clearTimeoutFn: () => {},
        installSeed: 12345,
        onStatusChange: () => { statusUpdates += 1; }
    });
    engine.beginSession("tray-throttle");
    engine.setBaseScene("normal_flight", { transitionMs: 0 });
    engine.triggerOverlay("overheat", { durationMs: 8_000, reason: "HeatWarning" });
    await engine.tick();
    statusUpdates = 0;
    nowRef.value = 34;
    await engine.tick();
    assert.equal(statusUpdates, 0);
});

test("failed writes release ownership and do not poison the output cache", async () => {
    const provider = new FakeProvider();
    let writes = 0;
    provider.writeFrame = async (frame) => {
        writes += 1;
        if (writes === 1) throw new Error("SDK ownership lost");
        provider.frames.push(structuredClone(frame));
        return true;
    };
    const nowRef = { value: 0 };
    const { engine } = createTestEngine({ provider, nowRef });
    engine.beginSession("write-recovery");
    engine.setBaseScene("idle", { transitionMs: 0 });
    await engine.tick();
    assert.equal(provider.releases[0], "write_failed");
    assert.equal(engine.lastWrittenPercentages, null);
    nowRef.value = 1_000;
    await engine.tick();
    assert.equal(writes, 2);
    assert.equal(provider.frames.length, 1);
});

test("manual preview overlays can be cleared without disturbing live journal cues", () => {
    const nowRef = { value: 0 };
    const { engine } = createTestEngine({ nowRef });
    engine.beginSession("preview-clear");
    engine.setBaseScene("normal_flight", { transitionMs: 0 });
    engine.triggerOverlay("overheat", { source: "manual", durationMs: 10_000 });
    engine.triggerOverlay("fuel_scoop", { source: "journal", durationMs: 10_000 });
    assert.equal(engine.clearTransientLayers({ source: "manual" }), 1);
    assert.equal(engine.transientLayers.find((layer) => layer.source === "manual").exitingAt, 0);
    assert.deepEqual(engine.activeLayerInstances(nowRef.value).map((layer) => layer.sceneId), ["fuel_scoop"]);
    nowRef.value = 1_000;
    engine.compositingLayerInstances(nowRef.value);
    assert.deepEqual(engine.transientLayers.map((layer) => layer.sceneId), ["fuel_scoop"]);
});
