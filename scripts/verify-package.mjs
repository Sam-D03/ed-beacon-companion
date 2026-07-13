import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const files = await fs.readdir(dist);
const installer = files.find((name) => /^ED-Beacon-Companion-Setup-.*\.exe$/u.test(name));
if (!installer) {
    throw new Error("ED Beacon Companion installer was not found in dist.");
}

const installerStats = await fs.stat(path.join(dist, installer));
if (installerStats.size < 1_000_000) {
    throw new Error(`Installer is unexpectedly small: ${installerStats.size} bytes.`);
}

const unpackedRoot = path.join(dist, "win-unpacked", "resources");
await fs.access(path.join(unpackedRoot, "app.asar"));
await fs.access(path.join(unpackedRoot, "app.asar.unpacked", "node_modules", "node-hid"));

console.log(`Package verified: ${installer} (${installerStats.size} bytes)`);
console.log("node-hid is present outside app.asar for native loading.");
