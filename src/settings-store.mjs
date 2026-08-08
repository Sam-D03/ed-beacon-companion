import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    launchAtLogin: false,
    g560Enabled: true,
    g560Brightness: 0.75,
    reducedFlashing: false
});

function randomInstallationSeed() {
    return randomBytes(4).readUInt32LE(0) || 1;
}

export function normalizeSettings(value = {}, { seedFallback = randomInstallationSeed } = {}) {
    const requestedBrightness = Number(value?.g560Brightness);
    const installationSeed = Number(value?.installationSeed);
    return {
        enabled: value?.enabled !== false,
        launchAtLogin: value?.launchAtLogin === true,
        g560Enabled: value?.g560Enabled !== false,
        g560Brightness: Number.isFinite(requestedBrightness)
            ? Math.min(1, Math.max(0.2, requestedBrightness))
            : DEFAULT_SETTINGS.g560Brightness,
        reducedFlashing: value?.reducedFlashing === true,
        installationSeed: Number.isInteger(installationSeed) && installationSeed > 0 && installationSeed <= 0xffffffff
            ? installationSeed
            : seedFallback()
    };
}

export class SettingsStore {
    constructor(filePath) {
        this.filePath = filePath;
    }

    async load() {
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
            const normalized = normalizeSettings(parsed);
            if (parsed.installationSeed !== normalized.installationSeed ||
                parsed.g560Enabled !== normalized.g560Enabled ||
                parsed.g560Brightness !== normalized.g560Brightness ||
                parsed.reducedFlashing !== normalized.reducedFlashing) {
                await this.save(normalized);
            }
            return normalized;
        } catch {
            const settings = normalizeSettings(DEFAULT_SETTINGS);
            await this.save(settings);
            return settings;
        }
    }

    async save(settings) {
        const normalized = normalizeSettings(settings);
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        try {
            await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
            await fs.rename(temporaryPath, this.filePath).catch(async (error) => {
                if (!["EEXIST", "EPERM"].includes(error?.code)) {
                    throw error;
                }
                await fs.rm(this.filePath, { force: true });
                await fs.rename(temporaryPath, this.filePath);
            });
        } finally {
            await fs.rm(temporaryPath, { force: true }).catch(() => {});
        }
        return normalized;
    }
}
