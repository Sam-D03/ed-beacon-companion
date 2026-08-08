import { readFileSync } from "node:fs";

import { hexColor } from "./lighting-color.mjs";

const database = JSON.parse(readFileSync(new URL("./planet-colour-seeds.json", import.meta.url), "utf8"));
const seeds = database.seeds.map((seed) => Object.freeze({
    ...seed,
    colour: Object.freeze(hexColor(seed.dominantHex))
}));
const seedsByClass = new Map(seeds.map((seed) => [seed.planetClass.trim().toLowerCase(), seed]));

export const PLANET_COLOUR_SEED_COUNT = seeds.length;
export const PLANET_COLOUR_POLICY = Object.freeze({ ...database.policy });

export function getPlanetColourSeed(planetClass) {
    return seedsByClass.get(String(planetClass ?? "").trim().toLowerCase()) ?? null;
}

export function planetClassColour(planetClass) {
    return getPlanetColourSeed(planetClass)?.colour ?? null;
}

export function listPlanetColourSeeds() {
    return seeds.slice();
}
