import path from "node:path";

import {
    app,
    dialog,
    Menu,
    nativeImage,
    shell,
    Tray
} from "electron";

import { BeaconController } from "./beacon-controller.mjs";
import { applyBeaconDirectives, resolveBeaconDirectives } from "./beacon-event-resolver.mjs";
import { BEACON_EFFECTS } from "./beacon-protocol.mjs";
import { JournalRuntime } from "./journal-runtime.mjs";
import { RotatingLogger } from "./logger.mjs";
import { createNodeHidAdapter } from "./node-hid-adapter.mjs";
import { SettingsStore } from "./settings-store.mjs";
import { buildTrayIconDataUrl, resolveTrayIconState } from "./tray-icon.mjs";
import { buildTrayMenuTemplate } from "./tray-menu.mjs";

const APP_NAME = "ED Beacon Companion";

let tray = null;
let controller = null;
let journalRuntime = null;
let settingsStore = null;
let logger = null;
let settings = { enabled: true, launchAtLogin: false };
let quitting = false;
let menuRefreshTimer = null;
let runtime = {
    beaconStatus: {},
    journalStatus: { state: "stopped" }
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
}

function buildUnavailableAdapter(loadError) {
    return {
        list() {
            throw loadError;
        },
        open() {
            throw loadError;
        }
    };
}

function scheduleTrayRefresh() {
    if (!tray || menuRefreshTimer) return;
    menuRefreshTimer = setTimeout(() => {
        menuRefreshTimer = null;
        refreshTray();
    }, 25);
}

function updateRuntime(patch = {}) {
    runtime = { ...runtime, ...patch };
    scheduleTrayRefresh();
}

function refreshTray() {
    if (!tray) return;
    const iconState = resolveTrayIconState({
        enabled: settings.enabled,
        beaconStatus: runtime.beaconStatus,
        journalStatus: runtime.journalStatus
    });
    const image = nativeImage.createFromDataURL(buildTrayIconDataUrl(iconState)).resize({ width: 16, height: 16 });
    tray.setImage(image);
    tray.setToolTip(`${APP_NAME} — ${runtime.beaconStatus?.effect ?? "off"}`);
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
        settings,
        runtime,
        actions: {
            setEnabled,
            setLaunchAtLogin,
            rescan: () => controller.scan({ force: true }),
            testSpin: () => controller.pulse(BEACON_EFFECTS.SPIN, 3_000, "tray_test"),
            testStrobe: () => controller.pulse(BEACON_EFFECTS.STROBE, 3_000, "tray_test"),
            stopNow: () => controller.stopAll("tray_stop"),
            openLogs: () => shell.openPath(logger.directory),
            showAbout,
            quit: () => {
                quitting = true;
                app.quit();
            }
        }
    })));
}

async function setEnabled(enabled) {
    settings = await settingsStore.save({ ...settings, enabled: enabled === true });
    if (settings.enabled) {
        controller.scan({ force: true });
        journalRuntime.start();
        logger.info("Companion enabled");
    } else {
        await journalRuntime.stop();
        controller.disconnect("disabled");
        logger.info("Companion disabled");
    }
    refreshTray();
}

async function setLaunchAtLogin(enabled) {
    settings = await settingsStore.save({ ...settings, launchAtLogin: enabled === true });
    if (app.isPackaged) {
        app.setLoginItemSettings({
            openAtLogin: settings.launchAtLogin,
            path: process.execPath
        });
    }
    logger.info("Launch at login changed", { enabled: settings.launchAtLogin });
    refreshTray();
}

function showAbout() {
    void dialog.showMessageBox({
        type: "info",
        title: APP_NAME,
        message: `${APP_NAME} ${app.getVersion()}`,
        detail: "A standalone Elite Dangerous flight-deck and danger light for the Farming Simulator 22 Collector's Edition USB beacon.\n\nNo journal data leaves this computer.",
        buttons: ["OK"]
    });
}

async function initialize() {
    app.setName(APP_NAME);
    app.setAppUserModelId("com.samd03.edbeaconcompanion");

    const userData = app.getPath("userData");
    logger = new RotatingLogger({ directory: path.join(userData, "logs") });
    settingsStore = new SettingsStore(path.join(userData, "settings.json"));
    settings = await settingsStore.load();

    let adapter;
    try {
        adapter = createNodeHidAdapter();
    } catch (error) {
        logger.error("Unable to load node-hid", error?.message ?? String(error));
        adapter = buildUnavailableAdapter(error);
    }

    controller = new BeaconController({
        adapter,
        logger,
        onStatusChange: (beaconStatus) => updateRuntime({ beaconStatus })
    });

    journalRuntime = new JournalRuntime({
        logger,
        onEvent: async (event) => {
            const directives = resolveBeaconDirectives(event);
            if (directives.length) {
                logger.info("Elite event cue", { event: event.event, directives });
                applyBeaconDirectives(controller, directives);
            }
        },
        onStatusChange: (journalStatus) => updateRuntime({ journalStatus })
    });

    tray = new Tray(nativeImage.createFromDataURL(buildTrayIconDataUrl("disconnected")).resize({ width: 16, height: 16 }));
    tray.on("click", () => tray.popUpContextMenu());
    refreshTray();

    controller.scan();
    if (settings.enabled) {
        journalRuntime.start();
    }
    if (app.isPackaged && settings.launchAtLogin) {
        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    }
    logger.info("Companion started", { version: app.getVersion(), enabled: settings.enabled });
}

if (hasSingleInstanceLock) {
    app.on("second-instance", () => tray?.popUpContextMenu());
    app.whenReady().then(initialize).catch((error) => {
        void dialog.showErrorBox(APP_NAME, error?.stack ?? error?.message ?? String(error));
        app.quit();
    });
}

app.on("before-quit", () => {
    if (quitting || controller || journalRuntime) {
        quitting = true;
        controller?.destroy("application_exit");
        void journalRuntime?.stop();
        logger?.info?.("Companion stopped");
    }
});
