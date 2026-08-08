import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(repositoryRoot, "dist", "win-unpacked", "ED Beacon Companion.exe");

if (!existsSync(executable)) {
    throw new Error(`Packaged application was not found: ${executable}`);
}

await new Promise((resolve, reject) => {
    execFile(executable, ["--package-smoke"], {
        cwd: path.dirname(executable),
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (error) reject(error);
        else resolve();
    });
});

console.log("Packaged application smoke test passed without acquiring lighting ownership.");
