import fs from "node:fs";
import path from "node:path";

import { EliteLightingDirector } from "../src/lighting/elite-lighting-director.mjs";
import { getLightingScene } from "../src/lighting/lighting-scene-catalog.mjs";

class ValidationEngine {
    beginSession() {}
    setSessionActive() {}
    setBaseScene(sceneId) { getLightingScene(sceneId); }
    setPersistentLayers(layers) {
        for (const layer of layers) getLightingScene(layer.sceneId);
    }
    triggerOverlay(sceneId) { getLightingScene(sceneId); }
    clearTransientLayers() {}
    stopNow() {}
}

const journalDirectory = path.join(
    process.env.USERPROFILE ?? "",
    "Saved Games",
    "Frontier Developments",
    "Elite Dangerous"
);

const files = fs.readdirSync(journalDirectory)
    .filter((name) => /^Journal\..*\.log$/i.test(name))
    .sort();
const eventTypes = new Set();
let eventCount = 0;
let failureCount = 0;

for (const name of files) {
    const director = new EliteLightingDirector({
        engine: new ValidationEngine(),
        setTimeoutFn: () => ({ unref() {} }),
        clearTimeoutFn: () => {}
    });
    const lines = fs.readFileSync(path.join(journalDirectory, name), "utf8").split(/\r?\n/);
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line);
            eventTypes.add(event.event);
            director.handleJournalEvent(event);
            eventCount += 1;
        } catch (error) {
            failureCount += 1;
            console.error(`${name}: ${error?.message ?? String(error)}`);
        }
    }
    director.destroy();
}

console.log(JSON.stringify({
    files: files.length,
    events: eventCount,
    eventTypes: eventTypes.size,
    failures: failureCount
}));
if (failureCount > 0) process.exitCode = 1;
