import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    launchAtLogin: false
});

export function normalizeSettings(value = {}) {
    return {
        enabled: value?.enabled !== false,
        launchAtLogin: value?.launchAtLogin === true
    };
}

export class SettingsStore {
    constructor(filePath) {
        this.filePath = filePath;
    }

    async load() {
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
            return normalizeSettings(parsed);
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    async save(settings) {
        const normalized = normalizeSettings(settings);
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
        await fs.rename(temporaryPath, this.filePath).catch(async (error) => {
            if (!["EEXIST", "EPERM"].includes(error?.code)) {
                throw error;
            }
            await fs.rm(this.filePath, { force: true });
            await fs.rename(temporaryPath, this.filePath);
        });
        return normalized;
    }
}
