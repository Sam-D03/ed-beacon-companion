import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const installer = `ED-Beacon-Companion-Setup-${packageJson.version}.exe`;

let installerStats;
try {
    installerStats = await fs.stat(path.join(dist, installer));
} catch {
    throw new Error(`Expected ED Beacon Companion installer was not found: ${installer}`);
}
if (installerStats.size < 1_000_000) {
    throw new Error(`Installer is unexpectedly small: ${installerStats.size} bytes.`);
}

const unpackedRoot = path.join(dist, "win-unpacked", "resources");
await fs.access(path.join(unpackedRoot, "app.asar"));
await fs.access(path.join(unpackedRoot, "app.asar.unpacked", "node_modules", "node-hid"));

console.log(`Package verified: ${installer} (${installerStats.size} bytes)`);
console.log("node-hid is present outside app.asar for native loading.");
