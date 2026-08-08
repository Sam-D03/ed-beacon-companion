import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getPlanetColourSeed } from "./planet-colour-seeds.mjs";

const JOURNAL_FILE = /^Journal\..+\.log$/iu;

export async function loadRecentPlanetClassScans(directory, {
    maxFiles = 8,
    maxBytes = 32 * 1024 * 1024
} = {}) {
    const root = String(directory ?? "").trim();
    if (!root) return [];
    const names = (await readdir(root))
        .filter((name) => JOURNAL_FILE.test(name))
        .sort((left, right) => right.localeCompare(left));
    const selected = [];
    let selectedBytes = 0;

    for (const name of names) {
        if (selected.length >= Math.max(1, maxFiles)) break;
        const filePath = path.join(root, name);
        const details = await stat(filePath);
        if (!details.isFile()) continue;
        if (selected.length > 0 && selectedBytes + details.size > Math.max(1, maxBytes)) break;
        selected.push(filePath);
        selectedBytes += details.size;
    }

    const scans = [];
    // Apply older files first so a later scan is authoritative if Elite ever
    // corrects metadata for the same body.
    for (const filePath of selected.reverse()) {
        const content = await readFile(filePath, "utf8");
        for (const line of content.split(/\r?\n/u)) {
            if (!line.includes('"event":"Scan"') || !line.includes('"PlanetClass"')) continue;
            try {
                const event = JSON.parse(line);
                const seed = event.event === "Scan" ? getPlanetColourSeed(event.PlanetClass) : null;
                if (!seed) continue;
                scans.push({
                    event: "Scan",
                    StarSystem: event.StarSystem,
                    SystemAddress: event.SystemAddress,
                    BodyName: event.BodyName,
                    BodyID: event.BodyID,
                    PlanetClass: seed.planetClass
                });
            } catch {
                // A partially written or malformed historical line is metadata
                // loss only; the live journal watcher remains authoritative.
            }
        }
    }
    return scans;
}
