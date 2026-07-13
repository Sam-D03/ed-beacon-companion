import fs from "node:fs";
import path from "node:path";

function stringifyDetail(detail) {
    if (detail === null || detail === undefined || detail === "") {
        return "";
    }
    if (typeof detail === "string") {
        return ` ${detail}`;
    }
    try {
        return ` ${JSON.stringify(detail)}`;
    } catch {
        return ` ${String(detail)}`;
    }
}

export class RotatingLogger {
    constructor({ directory, maxBytes = 1_000_000 } = {}) {
        this.directory = directory;
        this.maxBytes = maxBytes;
        this.filePath = path.join(directory, "ed-beacon-companion.log");
        this.backupPath = `${this.filePath}.1`;
        fs.mkdirSync(directory, { recursive: true });
    }

    info(message, detail = null) {
        this.write("INFO", message, detail);
    }

    warn(message, detail = null) {
        this.write("WARN", message, detail);
    }

    error(message, detail = null) {
        this.write("ERROR", message, detail);
    }

    write(level, message, detail = null) {
        this.rotateIfNeeded();
        const line = `${new Date().toISOString()} ${level} ${String(message)}${stringifyDetail(detail)}\r\n`;
        fs.appendFileSync(this.filePath, line, "utf8");
    }

    rotateIfNeeded() {
        try {
            if (fs.statSync(this.filePath).size < this.maxBytes) {
                return;
            }
            fs.rmSync(this.backupPath, { force: true });
            fs.renameSync(this.filePath, this.backupPath);
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
}
