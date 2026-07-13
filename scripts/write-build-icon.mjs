import fs from "node:fs/promises";
import path from "node:path";

import { buildTrayIconPng } from "../src/tray-icon.mjs";

const buildDirectory = path.resolve(import.meta.dirname, "..", "build");
await fs.mkdir(buildDirectory, { recursive: true });
await fs.writeFile(path.join(buildDirectory, "icon.png"), buildTrayIconPng("ready", 256));
console.log("Generated build/icon.png");
