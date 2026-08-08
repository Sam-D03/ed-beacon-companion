import fs from "node:fs/promises";
import path from "node:path";

const packageJson = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
const actualTag = String(process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "").trim();
const expectedTag = `v${packageJson.version}`;

if (actualTag !== expectedTag) {
    throw new Error(`Release tag ${actualTag || "<missing>"} does not match package version ${expectedTag}.`);
}

console.log(`Release tag matches package version: ${expectedTag}`);
