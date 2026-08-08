import assert from "node:assert/strict";
import test from "node:test";

import { colorToHex } from "../src/lighting/lighting-color.mjs";
import {
    PLANET_COLOUR_POLICY,
    PLANET_COLOUR_SEED_COUNT,
    getPlanetColourSeed,
    listPlanetColourSeeds,
    planetClassColour
} from "../src/lighting/planet-colour-seeds.mjs";

const EXPECTED_CLASSES = [
    "Metal rich body",
    "High metal content body",
    "Rocky body",
    "Icy body",
    "Rocky ice body",
    "Earthlike body",
    "Water world",
    "Ammonia world",
    "Water giant",
    "Water giant with life",
    "Gas giant with water based life",
    "Gas giant with ammonia based life",
    "Sudarsky class I gas giant",
    "Sudarsky class II gas giant",
    "Sudarsky class III gas giant",
    "Sudarsky class IV gas giant",
    "Sudarsky class V gas giant",
    "Helium rich gas giant",
    "Helium gas giant"
];

test("planet colour database preserves the approved fixed 19-class policy", () => {
    assert.equal(PLANET_COLOUR_SEED_COUNT, 19);
    assert.deepEqual(listPlanetColourSeeds().map((seed) => seed.planetClass), EXPECTED_CLASSES);
    assert.deepEqual(PLANET_COLOUR_POLICY, {
        oneFixedColourPerClass: true,
        parentStarTint: false,
        atmosphereModifiers: false,
        perBodyVariation: false,
        specialVariantOverrides: false
    });
});

test("planet class lookup is journal-case tolerant and returns the approved RGB value", () => {
    assert.equal(getPlanetColourSeed("  rocky BODY ")?.planetClass, "Rocky body");
    assert.equal(colorToHex(planetClassColour("Water world")), "#2c86ae");
    assert.equal(colorToHex(planetClassColour("Sudarsky class V gas giant")), "#8e4938");
    assert.equal(getPlanetColourSeed("Not a real planet class"), null);
    assert.equal(planetClassColour(null), null);
});
