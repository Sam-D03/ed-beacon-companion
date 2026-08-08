import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRecentPlanetClassScans } from "../src/lighting/planet-colour-journal-cache.mjs";

test("recent journal preload extracts only valid supported PlanetClass metadata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ed-beacon-planet-cache-"));
    try {
        await writeFile(path.join(directory, "Journal.2026-08-05T100000.01.log"), [
            JSON.stringify({ event: "Scan", StarSystem: "A", SystemAddress: 1, BodyName: "A 1", BodyID: 3, PlanetClass: "Rocky body" }),
            JSON.stringify({ event: "DockingGranted", BodyName: "A 1" })
        ].join("\n"));
        await writeFile(path.join(directory, "Journal.2026-08-06T100000.01.log"), [
            "{ malformed",
            JSON.stringify({ event: "Scan", StarSystem: "B", SystemAddress: 2, BodyName: "B 2", BodyID: 7, PlanetClass: "Water world" }),
            JSON.stringify({ event: "Scan", StarSystem: "B", SystemAddress: 2, BodyName: "B Belt", BodyID: 8 })
        ].join("\n"));
        await writeFile(path.join(directory, "Status.json"), JSON.stringify({ Flags: 0 }));

        assert.deepEqual(await loadRecentPlanetClassScans(directory), [
            { event: "Scan", StarSystem: "A", SystemAddress: 1, BodyName: "A 1", BodyID: 3, PlanetClass: "Rocky body" },
            { event: "Scan", StarSystem: "B", SystemAddress: 2, BodyName: "B 2", BodyID: 7, PlanetClass: "Water world" }
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("journal preload is bounded to the requested recent file count", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ed-beacon-planet-cache-"));
    try {
        for (const [stamp, body] of [["01", "Old 1"], ["02", "New 1"]]) {
            await writeFile(
                path.join(directory, `Journal.2026-08-06T1000${stamp}.01.log`),
                JSON.stringify({ event: "Scan", StarSystem: "Test", SystemAddress: 3, BodyName: body, BodyID: Number(stamp), PlanetClass: "Icy body" })
            );
        }
        const scans = await loadRecentPlanetClassScans(directory, { maxFiles: 1 });
        assert.deepEqual(scans.map((event) => event.BodyName), ["New 1"]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
