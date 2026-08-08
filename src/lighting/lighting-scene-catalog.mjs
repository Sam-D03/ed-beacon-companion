import {
    addColors,
    createFrame,
    frameFromZones,
    hexColor,
    mixColor,
    scaleColor
} from "./lighting-color.mjs";
import {
    deriveSeed,
    fractalNoise,
    hashUnit,
    randomImpulse,
    smoothNoise,
    smoothstep
} from "./lighting-random.mjs";
import { planetClassColour } from "./planet-colour-seeds.mjs";

const C = Object.freeze({
    black: hexColor("#000000"),
    eliteAmber: hexColor("#ff7100"),
    amber: hexColor("#ff9d18"),
    gold: hexColor("#ffd35a"),
    warmWhite: hexColor("#fff0ce"),
    white: hexColor("#ffffff"),
    ice: hexColor("#dffaff"),
    cyan: hexColor("#20d8ff"),
    electricBlue: hexColor("#187cff"),
    deepBlue: hexColor("#071c68"),
    navy: hexColor("#010519"),
    indigo: hexColor("#251273"),
    violet: hexColor("#8f43ff"),
    magenta: hexColor("#ff197f"),
    red: hexColor("#ff160d"),
    deepRed: hexColor("#5e0503"),
    orangeRed: hexColor("#ff3d08"),
    green: hexColor("#35ff8a"),
    dockingGreen: hexColor("#39b810"),
    acidGreen: hexColor("#9cff26"),
    teal: hexColor("#00bfae"),
    thargoid: hexColor("#b8ff20"),
    dust: hexColor("#b95418"),
    brown: hexColor("#35130a")
});

const ZONE_ORDER = Object.freeze(["leftRear", "leftFront", "rightFront", "rightRear"]);

const WHITE_DWARF_CLASS = /^D(?:A(?:B|O|Z|V)?|B(?:Z|V)?|O(?:V)?|Q|C(?:V)?|X)?$/u;

export function isWhiteDwarfClass(starClass = "") {
    return WHITE_DWARF_CLASS.test(String(starClass).trim().toUpperCase());
}

export function starClassColor(starClass = "") {
    const type = String(starClass).trim().toUpperCase();
    if (/^(O|B)/u.test(type)) return C.electricBlue;
    if (/^(A|F|AEBE)$/u.test(type)) return C.ice;
    if (isWhiteDwarfClass(type)) return C.ice;
    if (/^(G)/u.test(type)) return C.gold;
    if (/^(K)/u.test(type)) return C.amber;
    if (/^TTS$/u.test(type)) return C.amber;
    if (/^N$/u.test(type) || /^W(?:N|NC|C|O)?$/u.test(type)) return C.violet;
    if (/^(H|SUPERMASSIVEBLACKHOLE)$/u.test(type)) return C.white;
    if (/^(M|C|S)/u.test(type)) return C.orangeRed;
    if (/^(L|T|Y)/u.test(type)) return C.magenta;
    return C.cyan;
}

function starClassAccentColor(starClass = "") {
    const type = String(starClass).trim().toUpperCase();
    if (isWhiteDwarfClass(type)) return C.electricBlue;
    if (/^(O|B|A|F|AEBE)/u.test(type)) return C.ice;
    if (/^(G|K|TTS)/u.test(type)) return C.warmWhite;
    if (/^(M|C|S)/u.test(type)) return C.amber;
    if (/^(L|T|Y)/u.test(type)) return C.violet;
    if (/^(N|W)/u.test(type)) return C.ice;
    return C.electricBlue;
}

function bodyColour(context = {}, fallback = C.dust) {
    return planetClassColour(context.planetClass) ?? fallback;
}

function wave(timeMs, periodMs, offset = 0) {
    return (Math.sin((timeMs / periodMs + offset) * Math.PI * 2) + 1) / 2;
}

function shapedPulse(timeMs, periodMs, duty = 0.5, offset = 0) {
    const phase = ((timeMs / periodMs + offset) % 1 + 1) % 1;
    if (phase >= duty) return 0;
    return Math.sin(Math.PI * phase / duty) ** 2;
}

function progress({ elapsedMs, durationMs }, fallbackMs = 2_000) {
    return Math.min(1, Math.max(0, elapsedMs / Math.max(1, durationMs ?? fallbackMs)));
}

function frameAll(color, intensity = 1) {
    return createFrame(scaleColor(color, intensity));
}

function fourZoneGradient(leftRear, leftFront, rightFront, rightRear) {
    return frameFromZones({ leftRear, leftFront, rightFront, rightRear });
}

function chaseFrame(timeMs, colors, {
    periodMs = 1_200,
    width = 0.7,
    reverse = false,
    repeat = true,
    progressValue = null
} = {}) {
    const head = progressValue == null
        ? ((timeMs % periodMs) / periodMs) * (repeat ? 1.7 : 1)
        : progressValue;
    return frameFromZones(Object.fromEntries(ZONE_ORDER.map((zone, index) => {
        const position = reverse ? 1 - index / 3 : index / 3;
        const distance = Math.abs(position - head);
        const intensity = Math.max(0, 1 - distance / width) ** 2;
        const color = colors[index % colors.length];
        return [zone, scaleColor(color, intensity)];
    })));
}

function proceduralTwinkleFrame(seed, timeMs, baseColor, sparkColors, {
    baseIntensity = 0.08,
    noisePeriodMs = 2_500,
    sparkBucketMs = 900,
    sparkChance = 0.32
} = {}) {
    return createFrame((zone, index) => {
        const zoneSeed = deriveSeed(seed, zone);
        const drift = fractalNoise(zoneSeed, timeMs, {
            periodMs: noisePeriodMs + index * 173,
            octaves: 3,
            channel: index * 13
        });
        const spark = randomImpulse(zoneSeed, timeMs, {
            bucketMs: sparkBucketMs + index * 71,
            chance: sparkChance,
            durationMs: 110 + hashUnit(zoneSeed, 4, index) * 240,
            channel: 50 + index
        });
        const sparkColor = sparkColors[index % sparkColors.length];
        return addColors(
            scaleColor(baseColor, baseIntensity + drift * baseIntensity * 1.4),
            scaleColor(sparkColor, spark)
        );
    });
}

const DOCKED_ACTIVITY_COLORS = Object.freeze([
    C.white,
    C.warmWhite,
    C.warmWhite,
    C.eliteAmber,
    C.amber,
    C.gold,
    C.gold,
    C.electricBlue
]);

function dockedStationFrame(seed, timeMs) {
    const ambient = createFrame((zone, index) => {
        const zoneSeed = deriveSeed(seed, "docked-ambient", zone);
        const temperature = 0.34 + smoothNoise(
            zoneSeed,
            timeMs,
            67_000 + index * 9_700,
            11 + index
        ) * 0.38;
        const roomDrift = smoothNoise(
            deriveSeed(zoneSeed, "room-drift"),
            timeMs,
            43_000 + index * 13_100,
            31 + index
        );
        const localShimmer = smoothNoise(
            deriveSeed(zoneSeed, "local-shimmer"),
            timeMs,
            11_000 + index * 1_700,
            51 + index
        );
        const intensity = 0.17 + roomDrift * 0.105 + localShimmer * 0.025;
        return scaleColor(mixColor(C.eliteAmber, C.warmWhite, temperature), intensity);
    });

    // Station activity is selected in long buckets, but each successful bucket
    // derives its own cluster shape. Empty buckets create long quiet stretches;
    // active ones may be a single local glint or a short moving set of flashes.
    const bucketMs = 17_000;
    const bucket = Math.floor(timeMs / bucketMs);
    const bucketElapsed = timeMs - bucket * bucketMs;
    const activitySeed = deriveSeed(seed, "docked-activity", bucket);
    if (hashUnit(activitySeed, 0, 1) >= 0.38) return ambient;

    const pulseCount = 1 + Math.floor(hashUnit(activitySeed, 1, 2) * 4);
    const pulseSpacingMs = 135 + hashUnit(activitySeed, 2, 3) * 330;
    const pulseDurationMs = 75 + hashUnit(activitySeed, 3, 4) * 170;
    const clusterSpanMs = (pulseCount - 1) * pulseSpacingMs + pulseDurationMs;
    const clusterStartMs = 1_500 + hashUnit(activitySeed, 4, 5) * Math.max(0, bucketMs - clusterSpanMs - 3_000);
    const origin = Math.floor(hashUnit(activitySeed, 5, 6) * ZONE_ORDER.length);
    const motion = Math.floor(hashUnit(activitySeed, 6, 7) * 4);
    const accents = Object.fromEntries(ZONE_ORDER.map((zone) => [zone, C.black]));

    for (let pulseIndex = 0; pulseIndex < pulseCount; pulseIndex += 1) {
        const pulseElapsed = bucketElapsed - clusterStartMs - pulseIndex * pulseSpacingMs;
        if (pulseElapsed < 0 || pulseElapsed >= pulseDurationMs) continue;

        const phase = pulseElapsed / pulseDurationMs;
        const shape = Math.sin(Math.PI * phase) ** 4;
        const strength = (0.28 + hashUnit(activitySeed, pulseIndex, 20) * 0.58) * shape;
        const colorIndex = Math.floor(
            hashUnit(activitySeed, pulseIndex, 21) * DOCKED_ACTIVITY_COLORS.length
        );
        const color = DOCKED_ACTIVITY_COLORS[colorIndex];
        let targetIndex = origin;
        if (motion === 1) targetIndex = (origin + pulseIndex % 2) % ZONE_ORDER.length;
        if (motion === 2) targetIndex = (origin + pulseIndex) % ZONE_ORDER.length;
        if (motion === 3) targetIndex = (origin - pulseIndex + ZONE_ORDER.length * 2) % ZONE_ORDER.length;

        const target = ZONE_ORDER[targetIndex];
        const companion = ZONE_ORDER[targetIndex ^ 1];
        accents[target] = addColors(accents[target], scaleColor(color, strength));
        accents[companion] = addColors(accents[companion], scaleColor(color, strength * 0.14));
    }

    return frameFromZones(Object.fromEntries(ZONE_ORDER.map((zone) => [
        zone,
        addColors(ambient[zone], accents[zone])
    ])));
}

const scenes = new Map();

function register(definition) {
    if (scenes.has(definition.id)) {
        throw new Error(`Duplicate lighting scene id: ${definition.id}`);
    }
    scenes.set(definition.id, Object.freeze({
        kind: "base",
        blend: "normal",
        opacity: 1,
        dimUnderlay: 0,
        enterMs: 900,
        exitMs: 900,
        ...definition
    }));
}

register({
    id: "idle",
    label: "Lighting idle",
    enterMs: 250,
    exitMs: 250,
    render: () => frameAll(C.black)
});

register({
    id: "main_menu",
    label: "Main menu",
    render: ({ elapsedMs, seed }) => {
        const breathe = 0.08 + wave(elapsedMs, 7_600) * 0.08;
        const shimmer = 0.025 * smoothNoise(seed, elapsedMs, 3_900, 1);
        return fourZoneGradient(
            scaleColor(C.deepBlue, breathe),
            scaleColor(C.eliteAmber, breathe + shimmer),
            scaleColor(C.eliteAmber, breathe + shimmer),
            scaleColor(C.deepBlue, breathe)
        );
    }
});

register({
    id: "docked",
    label: "Docked ambience",
    enterMs: 1_600,
    exitMs: 1_200,
    render: ({ elapsedMs, seed }) => dockedStationFrame(seed, elapsedMs)
});

register({
    id: "station_services",
    label: "Station services",
    render: ({ elapsedMs, seed }) => {
        const activity = 0.14 + fractalNoise(seed, elapsedMs, { periodMs: 3_400, octaves: 2 }) * 0.12;
        const tick = shapedPulse(elapsedMs, 1_650, 0.12);
        return fourZoneGradient(
            scaleColor(C.deepBlue, 0.12 + activity * 0.3),
            addColors(scaleColor(C.eliteAmber, activity), scaleColor(C.gold, tick * 0.12)),
            addColors(scaleColor(C.eliteAmber, activity * 0.88), scaleColor(C.gold, tick * 0.09)),
            scaleColor(C.deepBlue, 0.1 + activity * 0.25)
        );
    }
});

register({
    id: "normal_flight",
    label: "Deep-space flight",
    enterMs: 1_200,
    exitMs: 1_100,
    render: ({ elapsedMs, seed, context = {} }) => {
        const stars = proceduralTwinkleFrame(
            seed,
            elapsedMs,
            C.navy,
            [starClassColor(context.starClass), C.ice, C.violet, C.electricBlue],
            { baseIntensity: 0.115, noisePeriodMs: 4_800, sparkBucketMs: 1_500, sparkChance: 0.22 }
        );
        const heading = Number(context.heading);
        const bearing = Number.isFinite(heading) ? Math.sin(heading * Math.PI / 180) : 0;
        const left = 0.94 + Math.max(0, -bearing) * 0.12;
        const right = 0.94 + Math.max(0, bearing) * 0.12;
        return frameFromZones({
            leftRear: scaleColor(stars.leftRear, left),
            leftFront: scaleColor(stars.leftFront, 0.98 + (left - 0.94) * 0.35),
            rightFront: scaleColor(stars.rightFront, 0.98 + (right - 0.94) * 0.35),
            rightRear: scaleColor(stars.rightRear, right)
        });
    }
});

register({
    id: "supercruise",
    label: "Supercruise flow",
    enterMs: 850,
    exitMs: 750,
    render: ({ elapsedMs, seed }) => {
        const stream = wave(elapsedMs, 2_350);
        const turbulence = fractalNoise(seed, elapsedMs, { periodMs: 1_450, octaves: 4 });
        const rear = mixColor(C.deepBlue, C.violet, 0.12 + turbulence * 0.14);
        const front = mixColor(C.electricBlue, C.cyan, 0.25 + stream * 0.38);
        return fourZoneGradient(
            scaleColor(rear, 0.22 + turbulence * 0.12),
            scaleColor(front, 0.28 + stream * 0.24),
            scaleColor(mixColor(front, C.ice, 0.08), 0.26 + wave(elapsedMs, 2_350, 0.18) * 0.24),
            scaleColor(mixColor(rear, C.indigo, 0.25), 0.2 + turbulence * 0.1)
        );
    }
});

register({
    id: "system_flight",
    label: "In-system starlight",
    enterMs: 500,
    exitMs: 900,
    render: ({ elapsedMs, wallNowMs, seed, context = {} }) => {
        const primary = starClassColor(context.starClass);
        const accent = starClassAccentColor(context.starClass);
        const arrivalAt = Number(context.systemArrivalAtMs);
        const clock = Number(wallNowMs);
        const ageMs = Number.isFinite(arrivalAt) && Number.isFinite(clock)
            ? Math.max(0, clock - arrivalAt)
            : 120_000;
        const proximity = 1 - smoothstep((ageMs - 8_000) / 82_000);
        const whiteDwarf = isWhiteDwarfClass(context.starClass);
        const generic = proceduralTwinkleFrame(
            deriveSeed(seed, "in-system"),
            elapsedMs,
            C.navy,
            [primary, accent, C.ice, C.violet],
            { baseIntensity: 0.1, noisePeriodMs: 4_600, sparkBucketMs: 1_250, sparkChance: 0.28 }
        );

        return createFrame((zone, index) => {
            const zoneSeed = deriveSeed(seed, zone, "primary-star");
            const shimmer = fractalNoise(zoneSeed, elapsedMs, {
                periodMs: whiteDwarf ? 310 + index * 37 : 1_850 + index * 173,
                octaves: whiteDwarf ? 4 : 3,
                channel: 200 + index
            });
            const flare = whiteDwarf
                ? randomImpulse(zoneSeed, elapsedMs, {
                    bucketMs: 360 + index * 47,
                    chance: 0.68,
                    durationMs: 70 + index * 19,
                    channel: 240 + index
                })
                : 0;
            const washColor = whiteDwarf
                ? mixColor(C.ice, C.electricBlue, 0.18 + shimmer * 0.68)
                : mixColor(primary, accent, 0.025 + shimmer * 0.075);
            const washIntensity = ageMs <= 8_000
                ? 1
                : 0.82 + shimmer * 0.18;
            let starWash = scaleColor(washColor, washIntensity);
            if (whiteDwarf) starWash = addColors(starWash, scaleColor(C.white, flare * 0.7));

            let result = mixColor(generic[zone], starWash, proximity);
            if (context.supercruise === true) {
                const flow = wave(elapsedMs, 2_700, index * 0.13) * (1 - proximity) * 0.08;
                result = addColors(result, scaleColor(index % 2 ? C.cyan : C.deepBlue, flow));
            }
            return result;
        });
    }
});

register({
    id: "witchspace",
    label: "Witchspace",
    enterMs: 340,
    exitMs: 900,
    render: ({ elapsedMs, seed }) => createFrame((zone, index) => {
        const localSeed = deriveSeed(seed, zone, "witchspace");
        const slow = fractalNoise(localSeed, elapsedMs, {
            periodMs: 2_730 + index * 211,
            octaves: 4,
            persistence: 0.58,
            channel: index * 31
        });
        const fast = smoothNoise(localSeed, elapsedMs, 173 + index * 23, 90 + index);
        const lightning = randomImpulse(localSeed, elapsedMs, {
            bucketMs: 760 + index * 97,
            chance: 0.44,
            durationMs: 80 + hashUnit(localSeed, 7, index) * 180,
            channel: 140 + index
        });
        const base = mixColor(C.deepBlue, C.violet, 0.2 + slow * 0.52);
        const ion = mixColor(C.electricBlue, C.cyan, fast * 0.72);
        return addColors(
            scaleColor(base, 0.22 + slow * 0.24),
            scaleColor(ion, 0.12 + fast * 0.24),
            scaleColor(index % 2 ? C.ice : C.white, lightning * 0.86)
        );
    })
});

register({
    id: "planetary_flight",
    label: "Planetary flight",
    render: ({ elapsedMs, seed, context = {} }) => {
        const gravity = Math.min(1, Math.max(0, Number(context.gravity) || 0));
        const surface = bodyColour(context);
        const horizon = 0.32 + smoothNoise(seed, elapsedMs, 4_200, 2) * 0.16 + gravity * 0.05;
        const thrusters = 0.4 + wave(elapsedMs, 2_900) * 0.15 + gravity * 0.06;
        return fourZoneGradient(
            scaleColor(mixColor(C.navy, surface, 0.82), horizon),
            addColors(scaleColor(surface, thrusters), scaleColor(C.warmWhite, 0.025 + gravity * 0.02)),
            addColors(scaleColor(surface, thrusters * 0.94), scaleColor(C.warmWhite, 0.022 + gravity * 0.018)),
            scaleColor(mixColor(C.navy, surface, 0.8), horizon * 0.92)
        );
    }
});

register({
    id: "glide",
    label: "Orbital glide",
    enterMs: 250,
    exitMs: 800,
    render: ({ elapsedMs, seed, context = {} }) => {
        const surface = bodyColour(context, C.amber);
        const streak = 0.25 + fractalNoise(seed, elapsedMs, { periodMs: 520, octaves: 3 }) * 0.52;
        const bank = wave(elapsedMs, 1_700);
        return fourZoneGradient(
            addColors(scaleColor(surface, streak * 0.58), scaleColor(C.ice, (1 - bank) * streak * 0.12)),
            addColors(scaleColor(surface, streak), scaleColor(C.white, bank * streak * 0.24)),
            addColors(scaleColor(surface, streak * 0.94), scaleColor(C.white, (1 - bank) * streak * 0.24)),
            addColors(scaleColor(surface, streak * 0.55), scaleColor(C.ice, bank * streak * 0.12))
        );
    }
});

register({
    id: "landed",
    label: "Surface standby",
    render: ({ elapsedMs, seed, context = {} }) => {
        const surface = bodyColour(context, C.brown);
        const wind = fractalNoise(seed, elapsedMs, { periodMs: 6_100, octaves: 3 });
        const beacon = shapedPulse(elapsedMs, 4_800, 0.2);
        return fourZoneGradient(
            scaleColor(mixColor(C.navy, surface, 0.78), 0.22 + wind * 0.08),
            addColors(scaleColor(surface, 0.27 + wind * 0.11), scaleColor(C.warmWhite, beacon * 0.045)),
            addColors(scaleColor(surface, 0.25 + wind * 0.105), scaleColor(C.warmWhite, beacon * 0.04)),
            scaleColor(mixColor(C.navy, surface, 0.76), 0.21 + wind * 0.08)
        );
    }
});

register({
    id: "srv",
    label: "SRV traversal",
    enterMs: 600,
    render: ({ elapsedMs, seed, context = {} }) => {
        const surface = bodyColour(context);
        const terrainLeft = fractalNoise(deriveSeed(seed, "left"), elapsedMs, { periodMs: 780, octaves: 3 });
        const terrainRight = fractalNoise(deriveSeed(seed, "right"), elapsedMs, { periodMs: 860, octaves: 3 });
        const scanner = shapedPulse(elapsedMs, 2_650, 0.42);
        return fourZoneGradient(
            scaleColor(surface, 0.2 + terrainLeft * 0.18),
            addColors(scaleColor(surface, 0.3 + terrainLeft * 0.2), scaleColor(C.teal, scanner * 0.07)),
            addColors(scaleColor(surface, 0.29 + terrainRight * 0.2), scaleColor(C.teal, scanner * 0.07)),
            scaleColor(surface, 0.19 + terrainRight * 0.18)
        );
    }
});

register({
    id: "fighter",
    label: "Ship-launched fighter",
    enterMs: 430,
    render: ({ elapsedMs, seed }) => {
        const engine = 0.22 + fractalNoise(seed, elapsedMs, { periodMs: 1_250, octaves: 3 }) * 0.24;
        const targeting = shapedPulse(elapsedMs, 1_900, 0.3);
        return fourZoneGradient(
            scaleColor(C.electricBlue, engine),
            addColors(scaleColor(C.cyan, engine * 0.74), scaleColor(C.red, targeting * 0.1)),
            addColors(scaleColor(C.cyan, engine * 0.7), scaleColor(C.red, targeting * 0.1)),
            scaleColor(C.electricBlue, engine * 0.94)
        );
    }
});

register({
    id: "taxi",
    label: "Apex shuttle",
    render: ({ elapsedMs, seed }) => {
        const cabin = 0.1 + smoothNoise(seed, elapsedMs, 5_200, 8) * 0.07;
        return fourZoneGradient(
            scaleColor(C.deepBlue, cabin),
            scaleColor(C.warmWhite, cabin * 0.82),
            scaleColor(C.warmWhite, cabin * 0.82),
            scaleColor(C.deepBlue, cabin)
        );
    }
});

register({
    id: "on_foot_station",
    label: "Station concourse",
    render: ({ elapsedMs, seed }) => {
        const signage = 0.11 + smoothNoise(seed, elapsedMs, 3_700, 3) * 0.09;
        const footfall = shapedPulse(elapsedMs, 1_250, 0.17);
        return fourZoneGradient(
            scaleColor(C.deepBlue, signage),
            addColors(scaleColor(C.warmWhite, 0.14), scaleColor(C.teal, footfall * 0.06)),
            addColors(scaleColor(C.warmWhite, 0.14), scaleColor(C.teal, footfall * 0.06)),
            scaleColor(C.deepBlue, signage * 0.9)
        );
    }
});

register({
    id: "on_foot_surface",
    label: "On-foot expedition",
    render: ({ elapsedMs, seed, context = {} }) => {
        const environment = bodyColour(context, mixColor(C.ice, C.dust, 0.42));
        const breathing = 0.2 + wave(elapsedMs, 4_200) * 0.1;
        const terrain = smoothNoise(seed, elapsedMs, 5_700, 11) * 0.09;
        return fourZoneGradient(
            scaleColor(mixColor(C.navy, environment, 0.8), breathing),
            scaleColor(environment, breathing + terrain),
            scaleColor(environment, breathing + terrain * 0.9),
            scaleColor(mixColor(C.navy, environment, 0.8), breathing)
        );
    }
});

register({
    id: "galaxy_map",
    label: "Galaxy map",
    enterMs: 500,
    render: ({ elapsedMs, seed }) => proceduralTwinkleFrame(
        seed,
        elapsedMs,
        C.indigo,
        [C.violet, C.cyan, C.white, C.magenta],
        { baseIntensity: 0.1, noisePeriodMs: 5_300, sparkBucketMs: 1_050, sparkChance: 0.42 }
    )
});

register({
    id: "system_map",
    label: "System map",
    enterMs: 500,
    render: ({ elapsedMs }) => {
        const orbit = wave(elapsedMs, 5_100);
        return fourZoneGradient(
            scaleColor(mixColor(C.deepBlue, C.cyan, orbit), 0.18),
            scaleColor(mixColor(C.eliteAmber, C.gold, orbit), 0.18 + orbit * 0.09),
            scaleColor(mixColor(C.gold, C.eliteAmber, orbit), 0.17 + (1 - orbit) * 0.09),
            scaleColor(mixColor(C.cyan, C.deepBlue, orbit), 0.18)
        );
    }
});

register({
    id: "fss",
    label: "Full Spectrum Scanner",
    enterMs: 350,
    render: ({ elapsedMs }) => {
        const sweep = (elapsedMs % 2_800) / 2_800;
        return frameFromZones(Object.fromEntries(ZONE_ORDER.map((zone, index) => {
            const position = index / 3;
            const distance = Math.min(Math.abs(position - sweep), 1 - Math.abs(position - sweep));
            const beam = Math.max(0, 1 - distance / 0.32) ** 3;
            return [zone, addColors(scaleColor(C.deepBlue, 0.16), scaleColor(C.cyan, beam * 0.55))];
        })));
    }
});

register({
    id: "saa",
    label: "Surface scanner",
    enterMs: 350,
    render: ({ elapsedMs }) => {
        const expansion = (elapsedMs % 3_300) / 3_300;
        const rear = Math.sin(Math.PI * Math.min(1, expansion * 2)) ** 2;
        const front = Math.sin(Math.PI * Math.max(0, (expansion - 0.35) / 0.65)) ** 2;
        return fourZoneGradient(
            scaleColor(C.teal, rear * 0.42 + 0.08),
            scaleColor(C.cyan, front * 0.46 + 0.1),
            scaleColor(C.cyan, front * 0.46 + 0.1),
            scaleColor(C.teal, rear * 0.42 + 0.08)
        );
    }
});

register({
    id: "codex",
    label: "Codex",
    render: ({ elapsedMs, seed }) => {
        const knowledge = 0.12 + wave(elapsedMs, 6_300) * 0.11;
        const glint = randomImpulse(seed, elapsedMs, { bucketMs: 1_500, chance: 0.3, durationMs: 220 });
        return fourZoneGradient(
            scaleColor(C.indigo, knowledge),
            addColors(scaleColor(C.violet, knowledge), scaleColor(C.gold, glint * 0.2)),
            addColors(scaleColor(C.violet, knowledge * 0.92), scaleColor(C.gold, glint * 0.16)),
            scaleColor(C.indigo, knowledge)
        );
    }
});

register({
    id: "exploration",
    label: "Exploration ambience",
    enterMs: 1_500,
    render: ({ elapsedMs, seed, context = {} }) => proceduralTwinkleFrame(
        seed,
        elapsedMs,
        mixColor(C.navy, starClassColor(context.starClass), 0.03),
        [starClassColor(context.starClass), C.cyan, C.ice, C.gold],
        { baseIntensity: 0.075, noisePeriodMs: 6_400, sparkBucketMs: 1_800, sparkChance: 0.3 }
    )
});

register({
    id: "mining_ambience",
    label: "Asteroid mining",
    render: ({ elapsedMs, seed }) => {
        const rock = fractalNoise(seed, elapsedMs, { periodMs: 5_900, octaves: 3 });
        const laser = randomImpulse(seed, elapsedMs, { bucketMs: 780, chance: 0.38, durationMs: 320, channel: 41 });
        return fourZoneGradient(
            scaleColor(mixColor(C.navy, C.violet, 0.34), 0.11 + rock * 0.09),
            addColors(scaleColor(C.indigo, 0.16 + rock * 0.08), scaleColor(C.orangeRed, laser * 0.42)),
            addColors(scaleColor(C.indigo, 0.15 + rock * 0.08), scaleColor(C.gold, laser * 0.38)),
            scaleColor(mixColor(C.navy, C.violet, 0.3), 0.1 + rock * 0.085)
        );
    }
});

register({
    id: "combat_ambience",
    label: "Combat stance",
    enterMs: 180,
    exitMs: 1_000,
    render: ({ elapsedMs, seed }) => {
        const tension = 0.16 + fractalNoise(seed, elapsedMs, { periodMs: 1_180, octaves: 3 }) * 0.18;
        const exchange = randomImpulse(seed, elapsedMs, { bucketMs: 560, chance: 0.42, durationMs: 120, channel: 71 });
        const side = smoothNoise(deriveSeed(seed, "combat-side"), elapsedMs, 1_650, 72);
        return fourZoneGradient(
            scaleColor(mixColor(C.deepBlue, C.deepRed, side), tension),
            addColors(scaleColor(C.red, tension), scaleColor(C.white, (1 - side) * exchange * 0.34)),
            addColors(scaleColor(C.red, tension * 0.9), scaleColor(C.white, side * exchange * 0.34)),
            scaleColor(mixColor(C.deepRed, C.deepBlue, side), tension)
        );
    }
});

register({
    id: "damaged_station",
    label: "Damaged starport",
    render: ({ elapsedMs, seed }) => {
        const smoke = fractalNoise(seed, elapsedMs, { periodMs: 3_800, octaves: 4 });
        const fault = randomImpulse(seed, elapsedMs, { bucketMs: 1_100, chance: 0.56, durationMs: 170, channel: 21 });
        return fourZoneGradient(
            scaleColor(C.deepRed, 0.13 + smoke * 0.14),
            addColors(scaleColor(C.orangeRed, 0.11 + smoke * 0.11), scaleColor(C.white, fault * 0.35)),
            scaleColor(C.eliteAmber, 0.1 + smoke * 0.1),
            scaleColor(C.deepRed, 0.12 + smoke * 0.13)
        );
    }
});

register({
    id: "guardian_site",
    label: "Guardian site",
    render: ({ elapsedMs, seed }) => {
        const glyph = shapedPulse(elapsedMs, 2_900, 0.38);
        const spark = randomImpulse(seed, elapsedMs, { bucketMs: 1_250, chance: 0.34, durationMs: 180, channel: 55 });
        return fourZoneGradient(
            scaleColor(C.deepBlue, 0.2 + glyph * 0.2),
            addColors(scaleColor(C.electricBlue, 0.22 + glyph * 0.34), scaleColor(C.white, spark * 0.4)),
            addColors(scaleColor(C.cyan, 0.2 + (1 - glyph) * 0.3), scaleColor(C.gold, spark * 0.18)),
            scaleColor(C.deepBlue, 0.18 + (1 - glyph) * 0.2)
        );
    }
});

register({
    id: "thargoid_encounter",
    label: "Thargoid encounter",
    enterMs: 250,
    render: ({ elapsedMs, seed }) => createFrame((zone, index) => {
        const fog = fractalNoise(deriveSeed(seed, zone), elapsedMs, { periodMs: 2_100 + index * 150, octaves: 4 });
        const probe = randomImpulse(seed, elapsedMs, { bucketMs: 1_300, chance: 0.28, durationMs: 260, channel: 90 + index });
        return addColors(scaleColor(C.thargoid, 0.09 + fog * 0.28), scaleColor(C.ice, probe * 0.45));
    })
});

register({
    id: "supercruise_overcharge",
    label: "Supercruise overcharge",
    enterMs: 70,
    exitMs: 420,
    render: ({ elapsedMs, seed }) => createFrame((zone, index) => {
        const zoneSeed = deriveSeed(seed, "sco", zone);
        const engineNoise = fractalNoise(zoneSeed, elapsedMs, {
            periodMs: 260 + index * 29,
            octaves: 4,
            persistence: 0.64,
            channel: 510 + index
        });
        const powerPulse = 0.48 + wave(elapsedMs, 690, index * 0.035) * 0.32 + engineNoise * 0.18;
        const blue = mixColor(C.electricBlue, C.cyan, 0.08 + engineNoise * 0.24);

        // Each side shares an impulse seed. Delaying its front zone turns a
        // random flash into a rear-to-front star streak instead of four noise
        // sources blinking independently.
        const rearZone = index === 0 || index === 3;
        const side = index < 2 ? "left" : "right";
        const travelDelayMs = rearZone ? 0 : 68;
        const streakSeed = deriveSeed(seed, "sco-star-streak", side);
        const primaryStreak = randomImpulse(streakSeed, elapsedMs - travelDelayMs, {
            bucketMs: side === "left" ? 238 : 281,
            chance: 0.78,
            durationMs: 82,
            channel: side === "left" ? 540 : 541
        });
        const secondaryStreak = randomImpulse(streakSeed, elapsedMs - travelDelayMs - 31, {
            bucketMs: side === "left" ? 367 : 329,
            chance: 0.54,
            durationMs: 54,
            channel: side === "left" ? 550 : 551
        });
        const stellarFlash = Math.min(1, primaryStreak + secondaryStreak * 0.82);

        return addColors(
            scaleColor(blue, powerPulse),
            scaleColor(C.white, stellarFlash)
        );
    })
});

register({
    id: "supercruise_assist",
    label: "Supercruise assist",
    render: ({ elapsedMs }) => {
        const flow = 0.18 + wave(elapsedMs, 4_600) * 0.16;
        return fourZoneGradient(
            scaleColor(C.deepBlue, flow),
            scaleColor(C.cyan, flow * 1.55),
            scaleColor(C.cyan, flow * 1.55),
            scaleColor(C.deepBlue, flow)
        );
    }
});

register({
    id: "cqc",
    label: "CQC arena",
    enterMs: 250,
    render: ({ elapsedMs }) => {
        const side = wave(elapsedMs, 1_300);
        return fourZoneGradient(
            scaleColor(mixColor(C.magenta, C.cyan, side), 0.32),
            scaleColor(mixColor(C.red, C.cyan, side), 0.38),
            scaleColor(mixColor(C.cyan, C.red, side), 0.38),
            scaleColor(mixColor(C.cyan, C.magenta, side), 0.32)
        );
    }
});

register({
    id: "capital_ship",
    label: "Capital ship encounter",
    render: ({ elapsedMs, seed }) => {
        const power = 0.13 + wave(elapsedMs, 7_800) * 0.18;
        const surge = randomImpulse(seed, elapsedMs, { bucketMs: 2_400, chance: 0.35, durationMs: 520, channel: 73 });
        return fourZoneGradient(
            scaleColor(C.navy, power),
            addColors(scaleColor(C.indigo, power * 1.3), scaleColor(C.white, surge * 0.32)),
            addColors(scaleColor(C.violet, power * 1.2), scaleColor(C.white, surge * 0.28)),
            scaleColor(C.navy, power)
        );
    }
});

function overlay(definition) {
    register({
        kind: "overlay",
        blend: "screen",
        enterMs: 120,
        exitMs: 500,
        ...definition
    });
}

function hardBeatFrame(elapsedMs, beats) {
    let cursorMs = 0;
    for (const [durationMs, color] of beats) {
        cursorMs += Math.max(0, Number(durationMs) || 0);
        if (elapsedMs < cursorMs) return frameAll(color);
    }
    return frameAll(C.black);
}

// Discrete journal outcomes are punctuation, not ambience. Every accent uses
// hard full-room cuts and black gaps, with no attack/release envelope and no
// underlying scene visible through the flash.
function hardAccent({ beats, render, ...definition }) {
    overlay({
        ...definition,
        blend: "replace",
        enterMs: 0,
        exitMs: 0,
        render: (sample) => ({
            frame: render
                ? render(sample)
                : hardBeatFrame(sample.elapsedMs, typeof beats === "function" ? beats(sample) : beats),
            blend: "replace",
            opacity: 1,
            dimUnderlay: 1
        })
    });
}

overlay({
    id: "docking_request",
    label: "Docking request pending",
    render: ({ elapsedMs }) => ({ frame: frameAll(C.amber, 0.32 + shapedPulse(elapsedMs, 1_400, 0.45) * 0.28), opacity: 0.48 })
});

overlay({
    id: "docking_clearance",
    label: "Docking clearance",
    blend: "replace",
    render: ({ elapsedMs }) => {
        const phase = ((elapsedMs % 1_000) + 1_000) % 1_000;
        const rearBeaconOn = phase < 110 || (phase >= 210 && phase < 320);
        const rearBeacon = rearBeaconOn ? C.eliteAmber : C.black;
        return {
            frame: fourZoneGradient(rearBeacon, C.red, C.dockingGreen, rearBeacon),
            opacity: 1
        };
    }
});

overlay({
    id: "settlement_approach",
    label: "Settlement perimeter",
    enterMs: 180,
    exitMs: 750,
    render: ({ elapsedMs, seed }) => {
        const beacon = shapedPulse(elapsedMs, 1_260, 0.2);
        const dust = fractalNoise(seed, elapsedMs, { periodMs: 1_900, octaves: 3 });
        return {
            frame: fourZoneGradient(
                scaleColor(C.dust, 0.12 + dust * 0.24),
                addColors(scaleColor(C.amber, 0.3 + dust * 0.2), scaleColor(C.white, beacon * 0.35)),
                addColors(scaleColor(C.amber, 0.28 + dust * 0.18), scaleColor(C.white, beacon * 0.35)),
                scaleColor(C.dust, 0.12 + dust * 0.24)
            ),
            opacity: 0.68
        };
    }
});

overlay({
    id: "airlock",
    label: "Airlock transition",
    enterMs: 30,
    exitMs: 700,
    render: (sample) => {
        const p = progress(sample, 2_000);
        const inward = sample.context?.direction === "in";
        const pressure = Math.sin(Math.PI * p) ** 2;
        const sweep = chaseFrame(sample.elapsedMs, [C.cyan, C.ice, C.eliteAmber, C.deepBlue], {
            reverse: inward,
            width: 0.48,
            progressValue: p * 1.45
        });
        return { frame: sweep, opacity: 0.62 + pressure * 0.28, dimUnderlay: pressure * 0.24 };
    }
});

overlay({
    id: "conflict_insertion",
    label: "Conflict-zone insertion",
    enterMs: 15,
    exitMs: 1_000,
    render: ({ elapsedMs, seed }) => {
        const descent = Math.max(0, 1 - elapsedMs / 3_500);
        const turbulence = fractalNoise(seed, elapsedMs, { periodMs: 310, octaves: 4 });
        const impact = shapedPulse(elapsedMs, 780, 0.12);
        return {
            frame: fourZoneGradient(
                scaleColor(C.deepRed, 0.3 + turbulence * 0.5),
                addColors(scaleColor(C.orangeRed, 0.35 + descent * 0.45), scaleColor(C.white, impact * 0.7)),
                addColors(scaleColor(C.orangeRed, 0.32 + descent * 0.42), scaleColor(C.white, impact * 0.7)),
                scaleColor(C.deepRed, 0.3 + turbulence * 0.5)
            ),
            opacity: 0.94,
            dimUnderlay: 0.42 + impact * 0.35
        };
    }
});

overlay({
    id: "launch",
    label: "Launch sequence",
    enterMs: 40,
    exitMs: 600,
    render: (sample) => ({
        frame: chaseFrame(sample.elapsedMs, [C.electricBlue, C.ice, C.white, C.cyan], {
            reverse: true,
            width: 0.5,
            progressValue: progress(sample, 3_500) * 1.35
        }),
        opacity: 0.95,
        dimUnderlay: 0.28
    })
});

overlay({
    id: "fighter_launch",
    label: "Fighter hangar launch",
    blend: "screen",
    enterMs: 20,
    exitMs: 320,
    render: ({ elapsedMs }) => {
        const periodMs = 920;
        const head = ((elapsedMs % periodMs) / periodMs) * ZONE_ORDER.length;
        return {
            frame: createFrame((zone) => {
                const index = ZONE_ORDER.indexOf(zone);
                const rawDistance = Math.abs(index - head);
                const distance = Math.min(rawDistance, ZONE_ORDER.length - rawDistance);
                const beam = Math.max(0, 1 - distance / 1.12) ** 4;
                const trailDistance = (head - index + ZONE_ORDER.length) % ZONE_ORDER.length;
                const trail = trailDistance > 0 && trailDistance < 1.65
                    ? (1 - trailDistance / 1.65) * 0.28
                    : 0;
                return addColors(
                    scaleColor(C.deepRed, 0.055),
                    scaleColor(C.eliteAmber, 0.08 + beam * 0.92 + trail),
                    scaleColor(C.gold, beam * 0.34)
                );
            }),
            opacity: 0.98,
            dimUnderlay: 0.68
        };
    }
});

overlay({
    id: "fsd_charge",
    label: "Frame Shift Drive charging",
    blend: "replace",
    enterMs: 60,
    exitMs: 180,
    render: ({ elapsedMs }) => {
        const phase = ((elapsedMs % 840) + 840) % 840;
        const charge = phase < 200
            ? 1 / 3
            : phase < 400
                ? 2 / 3
                : phase < 660
                    ? 1
                    : phase < 720
                        ? 160 / 255
                        : phase < 780
                            ? 64 / 255
                            : 0;
        return {
            frame: frameAll(C.electricBlue, charge),
            opacity: 1
        };
    }
});

overlay({
    id: "fsd_countdown",
    label: "Frame Shift Drive countdown",
    blend: "replace",
    enterMs: 0,
    exitMs: 0,
    render: ({ elapsedMs }) => {
        const time = Math.max(0, elapsedMs);
        let intensity = 0;
        if (time < 4_000) {
            intensity = time % 1_000 < 450 ? 1 : 0;
        } else if (time < 4_120) {
            intensity = 1 / 3;
        } else if (time < 4_240) {
            intensity = 2 / 3;
        } else if (time < 5_000) {
            intensity = 1;
        }
        return { frame: frameAll(C.red, intensity), opacity: 1 };
    }
});

overlay({
    id: "arrival",
    label: "Hyperspace arrival",
    enterMs: 25,
    exitMs: 900,
    render: (sample) => {
        const p = progress(sample, 1_900);
        const flare = (1 - p) ** 2;
        const primary = starClassColor(sample.context?.starClass);
        const whiteDwarf = isWhiteDwarfClass(sample.context?.starClass);
        const flicker = whiteDwarf
            ? fractalNoise(deriveSeed(sample.seed, "white-dwarf-arrival"), sample.elapsedMs, { periodMs: 230, octaves: 4 })
            : 0;
        const hot = whiteDwarf
            ? mixColor(C.ice, C.electricBlue, 0.18 + flicker * 0.62)
            : mixColor(primary, starClassAccentColor(sample.context?.starClass), 0.08);
        return {
            frame: fourZoneGradient(
                scaleColor(primary, flare),
                scaleColor(hot, flare),
                scaleColor(hot, flare),
                scaleColor(primary, flare)
            ),
            opacity: 1,
            dimUnderlay: flare * 0.7
        };
    }
});

overlay({
    id: "supercruise_drop",
    label: "Supercruise drop",
    enterMs: 20,
    exitMs: 650,
    render: (sample) => {
        const p = progress(sample, 1_250);
        const shock = Math.sin(Math.PI * Math.min(1, p * 1.8)) ** 2 * (1 - p * 0.45);
        return { frame: frameAll(mixColor(C.ice, C.eliteAmber, p), shock), opacity: 0.95, dimUnderlay: shock * 0.65 };
    }
});

overlay({
    id: "signal_drop",
    label: "Signal-source drop",
    enterMs: 20,
    exitMs: 900,
    render: ({ elapsedMs, seed, context = {} }) => {
        const threat = Math.min(1, Math.max(0, Number(context.threatLevel) || 0) / 8);
        const p = Math.min(1, elapsedMs / 2_200);
        const shock = Math.sin(Math.PI * Math.min(1, p * 1.35)) ** 2;
        const unstable = fractalNoise(seed, elapsedMs, { periodMs: 370 + (1 - threat) * 650, octaves: 3 });
        const signal = mixColor(C.cyan, C.red, threat);
        return {
            frame: fourZoneGradient(
                scaleColor(mixColor(C.deepBlue, C.deepRed, threat), 0.18 + unstable * 0.35),
                scaleColor(signal, shock * (0.62 + threat * 0.35)),
                scaleColor(signal, shock * (0.58 + threat * 0.38)),
                scaleColor(mixColor(C.deepBlue, C.deepRed, threat), 0.18 + unstable * 0.35)
            ),
            opacity: 0.88,
            dimUnderlay: shock * (0.28 + threat * 0.42)
        };
    }
});

overlay({
    id: "supercruise_entry",
    label: "Entering supercruise",
    enterMs: 20,
    exitMs: 700,
    render: (sample) => {
        const p = progress(sample, 1_650);
        const expansion = Math.sin(Math.PI * Math.min(1, p * 1.25)) ** 2;
        return {
            frame: chaseFrame(sample.elapsedMs, [C.white, C.cyan, C.electricBlue, C.deepBlue], {
                reverse: true,
                width: 0.7,
                progressValue: p * 1.4
            }),
            opacity: 0.75 + expansion * 0.2,
            dimUnderlay: expansion * 0.35
        };
    }
});

overlay({
    id: "fsd_cooldown",
    label: "Frame Shift Drive cooling",
    render: ({ elapsedMs }) => {
        const dissipate = 0.18 + wave(elapsedMs, 2_800) * 0.14;
        return {
            frame: fourZoneGradient(
                scaleColor(C.cyan, dissipate),
                scaleColor(C.deepBlue, dissipate * 0.62),
                scaleColor(C.deepBlue, dissipate * 0.62),
                scaleColor(C.cyan, dissipate)
            ),
            opacity: 0.5
        };
    }
});

overlay({
    id: "fuel_scoop",
    label: "Fuel scooping",
    render: ({ elapsedMs, seed, context = {} }) => {
        const fuel = Math.max(0, Number(context.fuelMain) || 0);
        const fillGlow = Math.min(0.12, Math.log2(1 + fuel) * 0.018);
        const solar = 0.28 + fillGlow + fractalNoise(seed, elapsedMs, { periodMs: 820, octaves: 4 }) * 0.5;
        const flare = randomImpulse(seed, elapsedMs, { bucketMs: 920, chance: 0.38, durationMs: 280, channel: 18 });
        return {
            frame: fourZoneGradient(
                scaleColor(C.orangeRed, solar * 0.75),
                addColors(scaleColor(C.amber, solar), scaleColor(C.white, flare * 0.34)),
                addColors(scaleColor(C.gold, solar * 0.94), scaleColor(C.white, flare * 0.31)),
                scaleColor(C.orangeRed, solar * 0.7)
            ),
            opacity: 0.74,
            dimUnderlay: 0.12
        };
    }
});

hardAccent({
    id: "fuel_scoop_complete",
    label: "Fuel scoop complete",
    beats: [[100, C.white], [90, C.black], [210, C.gold], [100, C.black], [300, C.green]]
});

overlay({
    id: "mass_lock",
    label: "Mass locked",
    render: ({ elapsedMs }) => ({
        frame: frameAll(C.amber, shapedPulse(elapsedMs, 1_700, 0.12) + shapedPulse(elapsedMs + 260, 1_700, 0.12)),
        opacity: 0.58
    })
});

overlay({
    id: "danger",
    label: "Danger",
    enterMs: 90,
    exitMs: 700,
    render: ({ elapsedMs }) => {
        const heart = shapedPulse(elapsedMs, 1_150, 0.16) + shapedPulse(elapsedMs + 185, 1_150, 0.13) * 0.72;
        return { frame: frameAll(C.red, heart), opacity: 0.78, dimUnderlay: heart * 0.42 };
    }
});

overlay({
    id: "interdiction",
    label: "Interdiction",
    enterMs: 25,
    exitMs: 850,
    render: ({ elapsedMs, seed }) => createFrame((zone, index) => {
        const local = deriveSeed(seed, zone);
        const chaos = fractalNoise(local, elapsedMs, { periodMs: 260 + index * 23, octaves: 3 });
        const snap = randomImpulse(local, elapsedMs, {
            bucketMs: 360 + index * 37,
            chance: 0.74,
            durationMs: 70 + index * 13,
            channel: 32 + index
        });
        const color = (Math.floor(elapsedMs / 210) + index) % 2 ? C.red : C.cyan;
        return addColors(scaleColor(color, 0.18 + chaos * 0.52), scaleColor(C.white, snap * 0.7));
    })
});

overlay({
    id: "under_attack",
    label: "Under attack",
    enterMs: 20,
    exitMs: 750,
    render: ({ elapsedMs, seed }) => {
        const irregular = 0.18 + fractalNoise(seed, elapsedMs, { periodMs: 340, octaves: 3 }) * 0.82;
        const side = Math.floor(elapsedMs / 240) % 2;
        return {
            frame: fourZoneGradient(
                scaleColor(side ? C.deepRed : C.red, irregular),
                scaleColor(side ? C.red : C.white, irregular),
                scaleColor(side ? C.white : C.red, irregular),
                scaleColor(side ? C.red : C.deepRed, irregular)
            ),
            opacity: 0.98,
            dimUnderlay: 0.62
        };
    }
});

overlay({
    id: "overheat",
    label: "Overheating",
    enterMs: 65,
    exitMs: 900,
    render: ({ elapsedMs, seed }) => {
        const rolling = 0.35 + wave(elapsedMs, 760) * 0.45;
        const flicker = fractalNoise(seed, elapsedMs, { periodMs: 240, octaves: 3 }) * 0.3;
        return {
            frame: fourZoneGradient(
                scaleColor(C.red, rolling + flicker),
                scaleColor(C.orangeRed, rolling * 0.94 + flicker),
                scaleColor(C.orangeRed, rolling * 0.9 + flicker),
                scaleColor(C.red, rolling + flicker)
            ),
            opacity: 0.92,
            dimUnderlay: 0.55
        };
    }
});

overlay({
    id: "heat_damage",
    label: "Heat damage",
    enterMs: 15,
    exitMs: 850,
    render: (sample) => {
        const p = progress(sample, 2_100);
        const flash = Math.max(0, 1 - p) * (0.55 + shapedPulse(sample.elapsedMs, 330, 0.28) * 0.45);
        return { frame: frameAll(mixColor(C.orangeRed, C.white, flash * 0.55), flash), opacity: 1, dimUnderlay: flash * 0.8 };
    }
});

overlay({
    id: "low_fuel",
    label: "Low fuel",
    render: ({ elapsedMs }) => {
        const blink = shapedPulse(elapsedMs, 2_250, 0.09) + shapedPulse(elapsedMs + 260, 2_250, 0.09) * 0.9;
        return { frame: fourZoneGradient(C.black, scaleColor(C.amber, blink), scaleColor(C.amber, blink), C.black), opacity: 0.86 };
    }
});

overlay({
    id: "silent_running",
    label: "Silent running",
    blend: "normal",
    render: ({ elapsedMs }) => {
        const heartbeat = 0.12 + shapedPulse(elapsedMs, 1_850, 0.22) * 0.26;
        return { frame: frameAll(C.deepRed, heartbeat), opacity: 0.72, dimUnderlay: 0.62 };
    }
});

overlay({
    id: "shields_down",
    label: "Shields offline",
    render: ({ elapsedMs }) => ({
        frame: fourZoneGradient(
            scaleColor(C.red, 0.15 + wave(elapsedMs, 2_200) * 0.16),
            scaleColor(C.electricBlue, shapedPulse(elapsedMs, 2_200, 0.18) * 0.2),
            scaleColor(C.electricBlue, shapedPulse(elapsedMs, 2_200, 0.18) * 0.2),
            scaleColor(C.red, 0.15 + wave(elapsedMs, 2_200, 0.5) * 0.16)
        ),
        opacity: 0.72
    })
});

hardAccent({
    id: "shields_restored",
    label: "Shields restored",
    beats: [[170, C.electricBlue], [90, C.black], [300, C.cyan]]
});

overlay({
    id: "shield_impact",
    label: "Shield impact",
    enterMs: 8,
    exitMs: 420,
    render: ({ elapsedMs, seed }) => {
        const decay = Math.max(0, 1 - elapsedMs / 850) ** 2;
        return {
            frame: createFrame((zone, index) => scaleColor(
                mixColor(C.electricBlue, C.white, hashUnit(seed, index, 61) * 0.48),
                decay * (0.58 + hashUnit(seed, index, 62) * 0.42)
            )),
            opacity: 0.92,
            dimUnderlay: decay * 0.28
        };
    }
});

overlay({
    id: "hull_impact",
    label: "Hull impact",
    enterMs: 10,
    render: ({ elapsedMs, seed }) => {
        const decay = Math.max(0, 1 - elapsedMs / 2_400);
        return {
            frame: createFrame((zone, index) => {
                const impact = 0.35 + hashUnit(seed, index, 8) * 0.65;
                return scaleColor(index % 2 ? C.white : C.red, impact * decay);
            }),
            opacity: 1,
            dimUnderlay: decay * 0.7
        };
    }
});

overlay({
    id: "critical_hull",
    label: "Critical hull",
    render: ({ elapsedMs }) => {
        const alarm = shapedPulse(elapsedMs, 880, 0.23);
        return { frame: frameAll(C.red, 0.18 + alarm * 0.78), opacity: 0.9, dimUnderlay: alarm * 0.6 };
    }
});

overlay({
    id: "cockpit_breach",
    label: "Canopy breached",
    render: ({ elapsedMs }) => {
        const alarm = Math.floor(elapsedMs / 220) % 2 ? 0.14 : 1;
        return { frame: fourZoneGradient(C.red, scaleColor(C.white, alarm), scaleColor(C.white, alarm), C.red), opacity: 0.96, dimUnderlay: 0.72 };
    }
});

overlay({
    id: "night_vision",
    label: "Night vision",
    blend: "screen",
    render: ({ elapsedMs }) => ({ frame: frameAll(C.green, 0.08 + wave(elapsedMs, 5_800) * 0.05), opacity: 0.55 })
});

overlay({
    id: "flight_assist_off",
    label: "Flight assist off",
    render: ({ elapsedMs }) => {
        const drift = wave(elapsedMs, 2_800);
        return {
            frame: fourZoneGradient(
                scaleColor(C.amber, drift * 0.32),
                scaleColor(C.eliteAmber, drift * 0.16),
                scaleColor(C.eliteAmber, (1 - drift) * 0.16),
                scaleColor(C.amber, (1 - drift) * 0.32)
            ),
            opacity: 0.62
        };
    }
});

overlay({
    id: "cockpit_panel",
    label: "Cockpit panel focus",
    render: ({ elapsedMs, context = {} }) => {
        const focus = Math.max(1, Math.min(4, Number(context.guiFocus) || 1));
        const breathe = 0.16 + wave(elapsedMs, 3_400) * 0.08;
        if (focus === 1) return { frame: fourZoneGradient(C.black, C.black, scaleColor(C.eliteAmber, breathe), C.black), opacity: 0.54 };
        if (focus === 2) return { frame: fourZoneGradient(C.black, scaleColor(C.eliteAmber, breathe), C.black, C.black), opacity: 0.54 };
        if (focus === 3) return { frame: fourZoneGradient(scaleColor(C.teal, breathe * 0.5), scaleColor(C.cyan, breathe), scaleColor(C.cyan, breathe), scaleColor(C.teal, breathe * 0.5)), opacity: 0.5 };
        return { frame: fourZoneGradient(scaleColor(C.violet, breathe), scaleColor(C.cyan, breathe * 0.6), scaleColor(C.cyan, breathe * 0.6), scaleColor(C.violet, breathe)), opacity: 0.48 };
    }
});

overlay({
    id: "cargo_scoop",
    label: "Cargo scoop deployed",
    render: ({ elapsedMs, context = {} }) => {
        const load = Math.min(1, Math.max(0, Number(context.cargo) || 0) / 64);
        const color = mixColor(C.teal, C.gold, load * 0.3);
        return {
            frame: fourZoneGradient(C.black, scaleColor(color, 0.18 + wave(elapsedMs, 2_500) * 0.16), scaleColor(color, 0.18 + wave(elapsedMs, 2_500, 0.2) * 0.16), C.black),
            opacity: 0.58
        };
    }
});

overlay({
    id: "landing_gear",
    label: "Landing gear down",
    render: ({ elapsedMs }) => ({
        frame: fourZoneGradient(C.black, scaleColor(C.green, 0.1 + wave(elapsedMs, 3_600) * 0.1), scaleColor(C.green, 0.1 + wave(elapsedMs, 3_600) * 0.1), C.black),
        opacity: 0.5
    })
});

overlay({
    id: "srv_handbrake",
    label: "SRV handbrake",
    render: ({ elapsedMs }) => ({
        frame: fourZoneGradient(
            scaleColor(C.red, 0.2 + wave(elapsedMs, 2_800) * 0.08),
            C.black,
            C.black,
            scaleColor(C.red, 0.2 + wave(elapsedMs, 2_800, 0.1) * 0.08)
        ),
        opacity: 0.56
    })
});

overlay({
    id: "srv_drive_assist",
    label: "SRV drive assist",
    render: ({ elapsedMs }) => ({
        frame: chaseFrame(elapsedMs, [C.deepBlue, C.cyan, C.deepBlue, C.cyan], { periodMs: 4_800, width: 0.32 }),
        opacity: 0.28
    })
});

overlay({
    id: "power_distribution",
    label: "Power distribution",
    render: ({ elapsedMs, context = {} }) => {
        const pips = Array.isArray(context.pips) ? context.pips : [4, 4, 4];
        const system = Math.min(1, Math.max(0, Number(pips[0]) / 8 || 0));
        const engines = Math.min(1, Math.max(0, Number(pips[1]) / 8 || 0));
        const weapons = Math.min(1, Math.max(0, Number(pips[2]) / 8 || 0));
        const breathe = 0.82 + wave(elapsedMs, 5_600) * 0.18;
        return {
            frame: fourZoneGradient(
                scaleColor(C.cyan, engines * 0.2 * breathe),
                scaleColor(C.electricBlue, system * 0.2 * breathe),
                scaleColor(C.orangeRed, weapons * 0.2 * breathe),
                scaleColor(C.cyan, engines * 0.2 * breathe)
            ),
            opacity: 0.38
        };
    }
});

overlay({
    id: "exterior_lights",
    label: "Exterior lights",
    render: ({ elapsedMs, context = {} }) => {
        const highBeam = context.highBeam === true ? 0.46 : 0.2;
        const hum = highBeam + wave(elapsedMs, 7_200) * 0.04;
        return { frame: fourZoneGradient(C.black, scaleColor(C.warmWhite, hum), scaleColor(C.warmWhite, hum), C.black), opacity: 0.52 };
    }
});

overlay({
    id: "wing_link",
    label: "Wing link",
    render: ({ elapsedMs }) => {
        const pair = shapedPulse(elapsedMs, 3_800, 0.16);
        return { frame: fourZoneGradient(scaleColor(C.teal, pair * 0.28), C.black, C.black, scaleColor(C.teal, pair * 0.28)), opacity: 0.45 };
    }
});

overlay({
    id: "targeting",
    label: "Aiming",
    render: ({ elapsedMs, context = {} }) => {
        const group = Math.max(0, Number(context.fireGroup) || 0);
        const weaponSeed = deriveSeed(context.selectedWeapon ?? "unarmed", group);
        const tint = hashUnit(weaponSeed, 0x51) * 0.32;
        const lock = 0.13 + wave(elapsedMs, 1_900, (group % 4) * 0.07) * 0.09;
        const color = mixColor(C.red, C.magenta, tint);
        return { frame: fourZoneGradient(C.black, scaleColor(color, lock), scaleColor(color, lock), C.black), opacity: 0.55 };
    }
});

overlay({
    id: "wanted",
    label: "Wanted or hostile",
    render: ({ elapsedMs }) => ({
        frame: fourZoneGradient(scaleColor(C.magenta, 0.18 + wave(elapsedMs, 2_900) * 0.18), C.black, C.black, scaleColor(C.red, 0.18 + wave(elapsedMs, 2_900, 0.5) * 0.18)),
        opacity: 0.7
    })
});

for (const [id, label, color] of [
    ["cold", "Extreme cold", C.ice],
    ["hot", "Extreme heat", C.orangeRed],
    ["low_oxygen", "Low oxygen", C.cyan],
    ["low_health", "Low health", C.red]
]) {
    overlay({
        id,
        label,
        render: ({ elapsedMs, seed }) => {
            const tremor = 0.25 + fractalNoise(seed, elapsedMs, { periodMs: id === "low_health" ? 520 : 890, octaves: 3 }) * 0.45;
            const alarm = shapedPulse(elapsedMs, id === "low_oxygen" ? 1_450 : 1_050, 0.18);
            return { frame: frameAll(color, tremor + alarm * 0.35), opacity: 0.82, dimUnderlay: alarm * 0.4 };
        }
    });
}

overlay({
    id: "scan",
    label: "Discovery scan",
    render: (sample) => ({
        frame: chaseFrame(sample.elapsedMs, [C.deepBlue, C.cyan, C.ice, C.cyan], {
            periodMs: 1_700,
            width: 0.52,
            progressValue: progress(sample, 1_700) * 1.35
        }),
        opacity: 0.82
    })
});

hardAccent({
    id: "scan_complete",
    label: "Scan complete",
    beats: [[170, C.cyan], [90, C.black], [280, C.gold]]
});

hardAccent({
    id: "body_scan_complete",
    label: "FSS body scan complete",
    beats: ({ context = {} }) => {
        const color = bodyColour(context, C.cyan);
        return [[170, color], [90, C.black], [280, color]];
    }
});

hardAccent({
    id: "dss_scan_complete",
    label: "DSS scan complete",
    beats: [[320, scaleColor(C.electricBlue, 0.32)]]
});

hardAccent({
    id: "organic_scan",
    label: "Bio sample collected",
    beats: ({ context = {} }) => {
        const completed = context.completed === true || String(context.scanType ?? "").toLowerCase() === "analyse";
        const sample = [[120, C.white], [90, C.black], [260, C.acidGreen], [110, C.black], [300, C.cyan]];
        return completed
            ? [...sample, [120, C.black], [320, C.gold], [100, C.black], [170, C.white]]
            : sample;
    }
});

overlay({
    id: "mining",
    label: "Mining yield",
    render: ({ elapsedMs, seed }) => {
        const spark = Math.max(0, 1 - elapsedMs / 2_800);
        return { frame: createFrame((zone, index) => scaleColor(index % 2 ? C.gold : C.violet, spark * (0.42 + hashUnit(seed, index, 2) * 0.58))), opacity: 0.88 };
    }
});

hardAccent({
    id: "asteroid_cracked",
    label: "Asteroid core detonation",
    beats: [[130, C.white], [80, C.black], [220, C.orangeRed], [100, C.black], [360, C.gold]]
});

hardAccent({
    id: "kill_confirmed",
    label: "Kill confirmed",
    beats: [[110, C.white], [80, C.black], [240, C.red], [100, C.black], [320, C.gold]]
});

hardAccent({
    id: "reward",
    label: "Reward received",
    beats: [[210, C.gold], [100, C.black], [300, C.green]]
});

hardAccent({
    id: "crime",
    label: "Crime committed",
    beats: [[220, C.red], [90, C.black], [220, C.magenta], [90, C.black], [260, C.red]]
});

overlay({
    id: "service",
    label: "Ship serviced",
    render: (sample) => {
        const p = progress(sample, 1_900);
        const glow = Math.sin(Math.PI * p) ** 2;
        return { frame: fourZoneGradient(scaleColor(C.teal, glow * 0.55), scaleColor(C.green, glow * 0.72), scaleColor(C.green, glow * 0.72), scaleColor(C.teal, glow * 0.55)), opacity: 0.72 };
    }
});

hardAccent({
    id: "mission_failed",
    label: "Mission failed",
    beats: [[260, C.red], [120, C.black], [260, C.red], [120, C.black], [320, C.deepRed]]
});

overlay({
    id: "systems_shutdown",
    label: "Systems shutdown",
    blend: "replace",
    enterMs: 10,
    exitMs: 900,
    render: (sample) => {
        const p = progress(sample, 2_200);
        const collapse = Math.max(0, 1 - p);
        const cut = Math.floor(sample.elapsedMs / 105) % 2 ? 0.18 : 1;
        return { frame: frameAll(C.ice, collapse * cut), opacity: 1, dimUnderlay: 1 - p * 0.2 };
    }
});

overlay({
    id: "self_destruct",
    label: "Self-destruct countdown",
    blend: "replace",
    enterMs: 10,
    exitMs: 250,
    render: (sample) => {
        const p = progress(sample, 10_000);
        const cadence = Math.max(180, 900 - p * 720);
        const alarm = shapedPulse(sample.elapsedMs, cadence, 0.34);
        const finalWhite = p > 0.9 ? (p - 0.9) * 10 : 0;
        return {
            frame: frameAll(mixColor(C.red, C.white, finalWhite), 0.2 + alarm * 0.8),
            opacity: 1,
            dimUnderlay: 0.72 + p * 0.28
        };
    }
});

overlay({
    id: "systems_reboot",
    label: "Systems reboot",
    enterMs: 30,
    render: (sample) => {
        const p = progress(sample, 4_000);
        const steps = Math.floor(p * 8) / 8;
        return {
            frame: fourZoneGradient(
                scaleColor(C.deepBlue, steps * 0.5),
                scaleColor(C.cyan, steps),
                scaleColor(C.cyan, steps * 0.94),
                scaleColor(C.deepBlue, steps * 0.5)
            ),
            opacity: 0.86
        };
    }
});

overlay({
    id: "fighter_rebuilt",
    label: "Fighter rebuilt",
    render: ({ elapsedMs, seed }) => {
        const build = Math.min(1, elapsedMs / 3_000);
        const weld = randomImpulse(seed, elapsedMs, { bucketMs: 360, chance: 0.72, durationMs: 90, channel: 201 });
        return {
            frame: fourZoneGradient(
                scaleColor(C.deepBlue, build * 0.36),
                addColors(scaleColor(C.cyan, build * 0.7), scaleColor(C.white, weld)),
                addColors(scaleColor(C.cyan, build * 0.7), scaleColor(C.white, weld * 0.84)),
                scaleColor(C.deepBlue, build * 0.36)
            ),
            opacity: 0.84
        };
    }
});

hardAccent({
    id: "engineer_craft",
    label: "Engineering modification",
    beats: [[100, C.white], [80, C.black], [240, C.violet], [100, C.black], [300, C.cyan]]
});

overlay({
    id: "comms_ping",
    label: "Incoming message",
    render: (sample) => {
        const ping = Math.sin(Math.PI * progress(sample, 780)) ** 2;
        return { frame: fourZoneGradient(C.black, scaleColor(C.cyan, ping * 0.58), scaleColor(C.cyan, ping * 0.58), C.black), opacity: 0.55 };
    }
});

overlay({
    id: "carrier_jump",
    label: "Fleet carrier jump",
    render: ({ elapsedMs, seed }) => {
        const charge = Math.min(1, elapsedMs / 8_000);
        const current = fractalNoise(seed, elapsedMs, { periodMs: 900, octaves: 3 });
        return {
            frame: fourZoneGradient(
                scaleColor(C.indigo, 0.12 + charge * 0.5),
                scaleColor(mixColor(C.violet, C.white, charge), 0.14 + charge * 0.7 + current * 0.12),
                scaleColor(mixColor(C.violet, C.white, charge), 0.14 + charge * 0.66 + current * 0.12),
                scaleColor(C.indigo, 0.12 + charge * 0.5)
            ),
            opacity: 0.9,
            dimUnderlay: charge * 0.42
        };
    }
});

overlay({
    id: "touchdown",
    label: "Touchdown",
    render: ({ elapsedMs, seed }) => {
        const decay = Math.max(0, 1 - elapsedMs / 2_400);
        const dust = fractalNoise(seed, elapsedMs, { periodMs: 420, octaves: 3 });
        return { frame: fourZoneGradient(scaleColor(C.dust, dust * decay), scaleColor(C.amber, decay), scaleColor(C.amber, decay * 0.92), scaleColor(C.dust, dust * decay)), opacity: 0.78 };
    }
});

overlay({
    id: "jet_cone",
    label: "Neutron jet boost",
    render: ({ elapsedMs, seed }) => createFrame((zone, index) => {
        const plasma = fractalNoise(deriveSeed(seed, zone), elapsedMs, { periodMs: 270 + index * 37, octaves: 4 });
        const arc = randomImpulse(seed, elapsedMs, { bucketMs: 410, chance: 0.68, durationMs: 100, channel: index + 80 });
        return addColors(scaleColor(index % 2 ? C.violet : C.electricBlue, 0.3 + plasma * 0.57), scaleColor(C.white, arc * 0.72));
    })
});

hardAccent({
    id: "escape",
    label: "Interdiction escaped",
    beats: [[170, C.white], [90, C.black], [320, C.green]]
});

hardAccent({
    id: "interdiction_success",
    label: "Interdiction successful",
    beats: [[220, C.red], [90, C.black], [300, C.amber]]
});

hardAccent({
    id: "interdiction_failed",
    label: "Interdiction failed",
    beats: [[220, C.red], [100, C.black], [260, C.magenta], [100, C.black], [300, C.deepRed]]
});

hardAccent({
    id: "docking_denied",
    label: "Docking denied",
    beats: [[240, C.red], [100, C.black], [300, C.red]]
});

overlay({
    id: "material_collected",
    label: "Material collected",
    render: (sample) => {
        const decay = Math.max(0, 1 - progress(sample, 900));
        return { frame: fourZoneGradient(C.black, scaleColor(C.teal, decay * 0.7), scaleColor(C.cyan, decay * 0.7), C.black), opacity: 0.7 };
    }
});

overlay({
    id: "cargo_transfer",
    label: "Cargo transfer",
    enterMs: 20,
    exitMs: 420,
    render: (sample) => {
        const loading = sample.context?.direction !== "out";
        const p = progress(sample, 1_200);
        return {
            frame: chaseFrame(sample.elapsedMs, [C.teal, C.green, C.gold, C.teal], {
                reverse: !loading,
                repeat: false,
                width: 0.48,
                progressValue: p * 1.35 - 0.15
            }),
            opacity: 0.78
        };
    }
});

hardAccent({
    id: "mission_accepted",
    label: "Mission accepted",
    beats: [[240, C.eliteAmber], [100, C.black], [300, C.green]]
});

hardAccent({
    id: "rescue_complete",
    label: "Search and rescue",
    beats: [[150, C.white], [90, C.black], [240, C.cyan], [100, C.black], [300, C.green]]
});

hardAccent({
    id: "camera_flash",
    label: "Screenshot captured",
    beats: [[150, C.white]]
});

overlay({
    id: "destruction",
    label: "Ship destroyed",
    blend: "replace",
    enterMs: 10,
    exitMs: 1_200,
    render: ({ elapsedMs, seed }) => {
        const decay = Math.max(0, 1 - elapsedMs / 5_500);
        const blast = elapsedMs < 300 ? 1 : decay * fractalNoise(seed, elapsedMs, { periodMs: 290, octaves: 4 });
        return { frame: frameAll(mixColor(C.red, C.white, Math.max(0, 1 - elapsedMs / 500)), blast), opacity: 1, dimUnderlay: 1 };
    }
});

export function getLightingScene(sceneId) {
    return scenes.get(sceneId) ?? scenes.get("idle");
}

export function listLightingScenes({ kind = null } = {}) {
    return [...scenes.values()]
        .filter((scene) => !kind || scene.kind === kind)
        .map(({ render, ...metadata }) => ({ ...metadata }));
}

export function sampleLightingScene(sceneId, sample = {}) {
    const scene = getLightingScene(sceneId);
    const result = scene.render({
        elapsedMs: Math.max(0, Number(sample.elapsedMs) || 0),
        nowMs: Number(sample.nowMs) || 0,
        wallNowMs: Number(sample.wallNowMs) || 0,
        durationMs: Number.isFinite(Number(sample.durationMs)) ? Number(sample.durationMs) : null,
        seed: Number(sample.seed) >>> 0,
        context: sample.context ?? {}
    });
    if (result?.frame) {
        return {
            frame: result.frame,
            blend: result.blend ?? scene.blend,
            opacity: result.opacity ?? scene.opacity,
            dimUnderlay: result.dimUnderlay ?? scene.dimUnderlay
        };
    }
    return {
        frame: result,
        blend: scene.blend,
        opacity: scene.opacity,
        dimUnderlay: scene.dimUnderlay
    };
}

export { C as LIGHTING_PALETTE };
