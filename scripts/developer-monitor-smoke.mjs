import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, ipcMain } from "electron";

import { buildDeveloperMonitorSnapshot } from "../src/developer-monitor-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const snapshotChannel = "ed-beacon-companion:developer-monitor:snapshot";
const requestChannel = "ed-beacon-companion:developer-monitor:request-snapshot";
const screenshotPath = path.join(os.tmpdir(), "ed-beacon-developer-monitor-smoke.png");

function monitorSnapshot() {
    return buildDeveloperMonitorSnapshot({
        version: "0.2.0-dev",
        settings: {
            enabled: true,
            g560Enabled: true,
            g560Brightness: 0.75,
            reducedFlashing: false
        },
        runtime: {
            eliteProcessStatus: { state: "watching", running: true },
            journalStatus: {
                state: "watching",
                directory: "C:\\Saved Games\\Frontier Developments\\Elite Dangerous",
                lastEvent: "DockingGranted",
                lastEventAt: new Date().toISOString()
            },
            beaconStatus: {
                available: true,
                detected: true,
                connected: true,
                effect: "spin",
                baseEffect: "spin",
                triggerReason: "DockingGranted"
            }
        },
        lightingStatus: {
            enabled: true,
            sessionActive: true,
            baseScene: "docked",
            baseLabel: "Docked ambience",
            baseReason: "Docked at Jameson Memorial",
            dominantCue: {
                key: "docking-guidance",
                sceneId: "docking_clearance",
                label: "Docking clearance",
                reason: "DockingGranted",
                source: "journal",
                remainingMs: 18_400
            },
            activeLayers: [{
                key: "docking-guidance",
                sceneId: "docking_clearance",
                label: "Docking clearance",
                reason: "DockingGranted",
                source: "journal",
                remainingMs: 18_400
            }],
            zoneColours: {
                leftRear: "#ff7100",
                leftFront: "#ff160d",
                rightFront: "#39b810",
                rightRear: "#ff7100"
            },
            framesRendered: 18_942,
            framesWritten: 11_306,
            framesDeduplicated: 7_636,
            targetFps: 29,
            provider: {
                available: true,
                detected: true,
                connected: true,
                state: "acquired",
                sdkVersion: "9"
            }
        }
    });
}

app.whenReady().then(async () => {
    let window = null;
    try {
        ipcMain.handle(requestChannel, () => monitorSnapshot());
        window = new BrowserWindow({
            width: 1180,
            height: 820,
            show: true,
            backgroundColor: "#05070b",
            webPreferences: {
                preload: path.join(root, "src", "developer-monitor", "preload.cjs"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });
        await window.loadFile(path.join(root, "src", "developer-monitor", "index.html"));
        window.webContents.send(snapshotChannel, monitorSnapshot());
        await new Promise((resolve) => setTimeout(resolve, 350));

        const inspection = await window.webContents.executeJavaScript(`(() => {
            const required = ["current-scene", "feedback-line", "zone-leftRear", "zone-rightRear", "zone-leftFront", "zone-rightFront", "layers", "game-status", "journal-status", "g560-status", "beacon-status"];
            const missing = required.filter((id) => !document.getElementById(id));
            const bounds = Object.fromEntries(required.map((id) => {
                const rect = document.getElementById(id)?.getBoundingClientRect();
                return [id, rect ? { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left } : null];
            }));
            return {
                title: document.title,
                currentScene: document.getElementById("current-scene")?.textContent,
                feedback: document.getElementById("feedback-line")?.textContent,
                layerCount: document.getElementById("layer-count")?.textContent,
                missing,
                viewport: { width: innerWidth, height: innerHeight },
                document: {
                    width: document.documentElement.scrollWidth,
                    height: document.documentElement.scrollHeight
                },
                bounds
            };
        })()`);
        console.log(`Developer monitor inspection: ${JSON.stringify(inspection)}`);
        if (inspection.missing.length > 0) throw new Error(`Monitor elements missing: ${inspection.missing.join(", ")}`);
        if (inspection.currentScene !== "Docking clearance") throw new Error(`Live snapshot did not render: ${inspection.currentScene}`);
        if (inspection.layerCount !== "2") throw new Error(`Expected base plus active cue, got ${inspection.layerCount}`);
        if (inspection.document.width > inspection.viewport.width) throw new Error("Developer monitor has horizontal overflow.");
        if (inspection.document.height > inspection.viewport.height) throw new Error("Developer monitor has vertical overflow.");
        for (const [id, bounds] of Object.entries(inspection.bounds)) {
            if (!bounds || bounds.left < 0 || bounds.right > inspection.viewport.width || bounds.top < 0 || bounds.bottom > inspection.viewport.height) {
                throw new Error(`Developer monitor element is clipped at launch: ${id}`);
            }
        }

        await fs.writeFile(screenshotPath, (await window.capturePage()).toPNG());
        console.log(`Developer monitor smoke passed: ${JSON.stringify(inspection)}`);
        console.log(`Developer monitor screenshot: ${screenshotPath}`);
        window.destroy();
        app.exit(0);
    } catch (error) {
        window?.destroy();
        console.error(error?.stack ?? error?.message ?? String(error));
        app.exit(1);
    }
});
