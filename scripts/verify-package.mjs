import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listPackage } from "@electron/asar";

const execFileAsync = promisify(execFile);

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
const asarPath = path.join(unpackedRoot, "app.asar");
await fs.access(asarPath);
const expectedNodeHidEntries = new Set([
    "\\node_modules\\node-hid",
    "\\node_modules\\node-hid\\LICENSE-bsd.txt",
    "\\node_modules\\node-hid\\binding-options.js",
    "\\node_modules\\node-hid\\nodehid.js",
    "\\node_modules\\node-hid\\package.json",
    "\\node_modules\\node-hid\\build",
    "\\node_modules\\node-hid\\build\\Release",
    "\\node_modules\\node-hid\\build\\Release\\HID.node"
]);
const nodeHidEntries = listPackage(asarPath).filter((entry) => entry.startsWith("\\node_modules\\node-hid"));
const unexpectedNodeHidEntries = nodeHidEntries.filter((entry) => !expectedNodeHidEntries.has(entry));
if (unexpectedNodeHidEntries.length > 0 || nodeHidEntries.length !== expectedNodeHidEntries.size) {
    throw new Error(`Packaged node-hid runtime is not minimal: ${unexpectedNodeHidEntries.join(", ") || "expected files missing"}`);
}
const unpackedNodeHid = path.join(unpackedRoot, "app.asar.unpacked", "node_modules", "node-hid");
const unpackedBinding = path.join(unpackedNodeHid, "build", "Release", "HID.node");
await fs.access(unpackedBinding);
const unpackedFiles = [];
async function collectFiles(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await collectFiles(entryPath);
        else unpackedFiles.push(path.relative(unpackedNodeHid, entryPath).replaceAll("\\", "/"));
    }
}
await collectFiles(unpackedNodeHid);
if (unpackedFiles.length !== 1 || unpackedFiles[0] !== "build/Release/HID.node") {
    throw new Error(`Unexpected files were unpacked for node-hid: ${unpackedFiles.join(", ")}`);
}
const packagedEntries = new Set(listPackage(asarPath));
for (const monitorEntry of [
    "\\src\\developer-monitor-state.mjs",
    "\\src\\developer-monitor\\index.html",
    "\\src\\developer-monitor\\preload.cjs",
    "\\src\\developer-monitor\\renderer.js",
    "\\src\\developer-monitor\\styles.css"
]) {
    if (!packagedEntries.has(monitorEntry)) {
        throw new Error(`Packaged developer monitor asset is missing: ${monitorEntry}`);
    }
}
const bridgePath = path.join(unpackedRoot, "native", "g560-bridge.exe");
const bridgeStats = await fs.stat(bridgePath);
if (bridgeStats.size < 50_000) {
    throw new Error(`Packaged G560 bridge is unexpectedly small: ${bridgeStats.size} bytes.`);
}
const bridgeSelfTest = await execFileAsync(bridgePath, ["--self-test"], { windowsHide: true });
if (!bridgeSelfTest.stdout.includes("SELF_TEST_OK protocol=1")) {
    throw new Error(`Packaged G560 bridge self-test did not pass: ${bridgeSelfTest.stdout}`);
}

console.log(`Package verified: ${installer} (${installerStats.size} bytes)`);
console.log("node-hid is present outside app.asar for native loading.");
console.log(`node-hid runtime is pruned to ${unpackedFiles.length} files.`);
console.log("Developer monitor HTML, preload, renderer, styles and state model are packaged.");
console.log(`G560 bridge is packaged and self-tested (${bridgeStats.size} bytes).`);
