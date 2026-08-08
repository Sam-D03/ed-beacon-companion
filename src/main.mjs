import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    screen,
    shell,
    Tray
} from "electron";

import { BeaconController } from "./beacon-controller.mjs";
import { BeaconFsdSequence, applyBeaconDirectives, resolveBeaconDirectives } from "./beacon-event-resolver.mjs";
import { BEACON_EFFECTS } from "./beacon-protocol.mjs";
import { buildDeveloperMonitorSnapshot } from "./developer-monitor-state.mjs";
import { EliteProcessMonitor } from "./elite-process-monitor.mjs";
import { JournalRuntime } from "./journal-runtime.mjs";
import { EliteLightingDirector } from "./lighting/elite-lighting-director.mjs";
import { LightingEngine } from "./lighting/lighting-engine.mjs";
import { loadRecentPlanetClassScans } from "./lighting/planet-colour-journal-cache.mjs";
import { RotatingLogger } from "./logger.mjs";
import { createNodeHidAdapter } from "./node-hid-adapter.mjs";
import { G560BridgeProvider } from "./providers/g560-bridge-provider.mjs";
import { SettingsStore } from "./settings-store.mjs";
import { buildTrayIconDataUrl, resolveTrayIconState } from "./tray-icon.mjs";
import { buildTrayMenuTemplate } from "./tray-menu.mjs";

const APP_NAME = "ED Beacon Companion";
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_SNAPSHOT_CHANNEL = "ed-beacon-companion:developer-monitor:snapshot";
const MONITOR_REQUEST_CHANNEL = "ed-beacon-companion:developer-monitor:request-snapshot";

let tray = null;
let developerMonitorWindow = null;
let developerMonitorTimer = null;
let controller = null;
let beaconFsdSequence = null;
let journalRuntime = null;
let eliteProcessMonitor = null;
let lightingProvider = null;
let lightingEngine = null;
let lightingDirector = null;
let settingsStore = null;
let logger = null;
let settings = {
    enabled: true,
    launchAtLogin: false,
    g560Enabled: true,
    g560Brightness: 0.75,
    reducedFlashing: false
};
let shutdownComplete = false;
let shutdownPromise = null;
let shuttingDown = false;
let menuRefreshTimer = null;
let lightingInputQueue = Promise.resolve();
let lifecycleMutationQueue = Promise.resolve();
let runtime = {
    beaconStatus: {},
    eliteProcessStatus: { state: "stopped", running: null },
    journalStatus: { state: "stopped" },
    lightingStatus: {
        sessionActive: false,
        provider: { connected: false, detected: null, state: "idle" }
    }
};

const packageSmokeMode = process.argv.includes("--package-smoke");
const hasSingleInstanceLock = packageSmokeMode || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function buildUnavailableAdapter(loadError) {
    return {
        list() { throw loadError; },
        open() { throw loadError; }
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

function developerMonitorSnapshot() {
    return buildDeveloperMonitorSnapshot({
        version: app.getVersion(),
        settings,
        runtime,
        lightingStatus: lightingEngine?.getStatus?.() ?? runtime.lightingStatus
    });
}

function sendDeveloperMonitorSnapshot() {
    if (!developerMonitorWindow || developerMonitorWindow.isDestroyed()) return;
    try {
        developerMonitorWindow.webContents.send(MONITOR_SNAPSHOT_CHANNEL, developerMonitorSnapshot());
    } catch (error) {
        logger?.warn?.("Developer monitor update failed", error?.message ?? String(error));
    }
}

function stopDeveloperMonitorUpdates() {
    if (developerMonitorTimer) clearInterval(developerMonitorTimer);
    developerMonitorTimer = null;
}

function developerMonitorBounds() {
    const primary = screen.getPrimaryDisplay();
    const target = screen.getAllDisplays().find((display) => display.id !== primary.id) ?? primary;
    const width = Math.max(760, Math.min(1180, target.workArea.width - 40));
    const height = Math.max(600, Math.min(820, target.workArea.height - 40));
    return {
        width,
        height,
        x: Math.round(target.workArea.x + (target.workArea.width - width) / 2),
        y: Math.round(target.workArea.y + (target.workArea.height - height) / 2)
    };
}

function showDeveloperMonitor() {
    if (developerMonitorWindow && !developerMonitorWindow.isDestroyed()) {
        if (developerMonitorWindow.isMinimized()) developerMonitorWindow.restore();
        developerMonitorWindow.show();
        developerMonitorWindow.focus();
        return;
    }

    developerMonitorWindow = new BrowserWindow({
        ...developerMonitorBounds(),
        minWidth: 760,
        minHeight: 600,
        title: `${APP_NAME} — Developer Monitor`,
        backgroundColor: "#05070b",
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(MODULE_DIRECTORY, "developer-monitor", "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    developerMonitorWindow.removeMenu();
    developerMonitorWindow.once("ready-to-show", () => developerMonitorWindow?.show());
    developerMonitorWindow.webContents.once("did-finish-load", () => {
        sendDeveloperMonitorSnapshot();
        stopDeveloperMonitorUpdates();
        developerMonitorTimer = setInterval(sendDeveloperMonitorSnapshot, 100);
        developerMonitorTimer.unref?.();
    });
    developerMonitorWindow.on("closed", () => {
        stopDeveloperMonitorUpdates();
        developerMonitorWindow = null;
    });
    void developerMonitorWindow.loadFile(path.join(MODULE_DIRECTORY, "developer-monitor", "index.html"))
        .catch((error) => {
            logger?.error?.("Unable to open developer monitor", error?.message ?? String(error));
            developerMonitorWindow?.close();
        });
}

function observeUiPromise(promise, action) {
    void Promise.resolve(promise).catch((error) => {
        logger?.warn?.(`${action} failed`, error?.message ?? String(error));
    });
}

function enqueueLighting(operation, source) {
    lightingInputQueue = lightingInputQueue
        .then(() => operation())
        .catch((error) => logger?.error?.("Lighting telemetry handler failed", {
            source,
            detail: error?.stack ?? error?.message ?? String(error)
        }));
    return lightingInputQueue;
}

function telemetryIsLive() {
    return settings.enabled === true &&
        !shuttingDown &&
        runtime.eliteProcessStatus?.running !== false;
}

function enqueueLifecycleMutation(operation, source) {
    lifecycleMutationQueue = lifecycleMutationQueue
        .then(() => shuttingDown ? undefined : operation())
        .catch((error) => logger?.error?.("Tray action failed", {
            source,
            detail: error?.stack ?? error?.message ?? String(error)
        }));
    return lifecycleMutationQueue;
}

function refreshTray() {
    if (!tray) return;
    const iconState = resolveTrayIconState({
        enabled: settings.enabled,
        g560Enabled: settings.g560Enabled,
        beaconStatus: runtime.beaconStatus,
        lightingStatus: runtime.lightingStatus,
        journalStatus: runtime.journalStatus
    });
    const image = nativeImage.createFromDataURL(buildTrayIconDataUrl(iconState)).resize({ width: 16, height: 16 });
    tray.setImage(image);
    const lightingCue = runtime.lightingStatus?.dominantCue?.label ?? runtime.lightingStatus?.baseLabel;
    const tooltipState = lightingCue ?? (
        runtime.beaconStatus?.effect && runtime.beaconStatus.effect !== "off"
            ? `Beacon ${runtime.beaconStatus.effect}`
            : "Ready"
    );
    tray.setToolTip(`${APP_NAME} - ${tooltipState}`);
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
        settings,
        runtime,
        actions: {
            setEnabled: (enabled) => enqueueLifecycleMutation(() => setEnabled(enabled), "Enabled"),
            setLaunchAtLogin: (enabled) => enqueueLifecycleMutation(() => setLaunchAtLogin(enabled), "Launch at Login"),
            setG560Enabled: (enabled) => enqueueLifecycleMutation(() => setG560Enabled(enabled), "G560 Lighting"),
            setG560Brightness: (brightness) => enqueueLifecycleMutation(() => setG560Brightness(brightness), "G560 Brightness"),
            setReducedFlashing: (enabled) => enqueueLifecycleMutation(() => setReducedFlashing(enabled), "Reduced Flashing"),
            rescan: () => {
                if (settings.enabled) controller.scan({ force: true });
            },
            testSpin: () => {
                if (settings.enabled) controller.pulse(BEACON_EFFECTS.SPIN, 3_000, "tray_test");
            },
            testStrobe: () => {
                if (settings.enabled) controller.pulse(BEACON_EFFECTS.STROBE, 3_000, "tray_test");
            },
            rescanG560: () => {
                if (settings.enabled && settings.g560Enabled) void lightingEngine.rescanProvider();
            },
            previewG560: (sceneId) => {
                if (settings.enabled && settings.g560Enabled) lightingDirector.previewScene(sceneId);
            },
            restoreG560: () => enqueueLifecycleMutation(() => setG560Enabled(false), "Restore G HUB Lighting"),
            openDynamicLighting: () => observeUiPromise(
                shell.openExternal("ms-settings:personalization-lighting"),
                "Open Windows Dynamic Lighting"
            ),
            stopNow: () => {
                controller.stopAll("tray_stop");
                lightingDirector.stopNow("tray_stop");
            },
            openDeveloperMonitor: showDeveloperMonitor,
            openLogs: () => observeUiPromise(shell.openPath(logger.directory), "Open logs"),
            showAbout,
            quit: () => app.quit()
        }
    })));
}

async function setEnabled(enabled) {
    if (shuttingDown) return;
    const nextEnabled = enabled === true;
    if (!nextEnabled) {
        // Hardware-off is the first operation. Settings I/O and a wedged file
        // watcher must never be able to leave either lighting device active.
        settings = { ...settings, enabled: false };
        const monitorStop = eliteProcessMonitor.stop();
        const journalStop = journalRuntime.stop();
        beaconFsdSequence.reset();
        controller.disconnect("disabled");
        lightingDirector.handleGameProcess(false, "disabled");
        lightingEngine.setEnabled(false);
        await lightingEngine.release("disabled");
        await Promise.allSettled([
            monitorStop,
            journalStop,
            lightingInputQueue
        ]);
        // Reassert OFF after all callbacks that were already queued at the
        // disable boundary have drained.
        controller.disconnect("disabled_confirmed");
        lightingDirector.handleGameProcess(false, "disabled_confirmed");
        lightingEngine.setEnabled(false);
        await lightingEngine.release("disabled_confirmed");
        try {
            settings = await settingsStore.save(settings);
        } catch (error) {
            logger.error("Unable to save disabled state", error?.message ?? String(error));
        }
        logger.info("Companion disabled");
    } else {
        settings = { ...settings, enabled: true };
        try {
            settings = await settingsStore.save(settings);
        } catch (error) {
            logger.error("Unable to save enabled state", error?.message ?? String(error));
        }
        if (shuttingDown) return;
        lightingDirector.allowResume();
        lightingEngine.setEnabled(settings.g560Enabled);
        controller.scan({ force: true });
        await eliteProcessMonitor.start();
        journalRuntime.start();
        if (settings.g560Enabled) await lightingEngine.rescanProvider();
        logger.info("Companion enabled");
    }
    refreshTray();
}

async function setLaunchAtLogin(enabled) {
    if (shuttingDown) return;
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

async function setG560Enabled(enabled) {
    if (shuttingDown) return;
    const nextEnabled = enabled === true;
    settings = { ...settings, g560Enabled: nextEnabled };
    if (!nextEnabled) {
        // Release G HUB ownership before persistence for the same safety reason
        // as the master disable path above.
        lightingEngine.setEnabled(false);
        lightingDirector.stopPreview("g560_disabled");
        await lightingEngine.release("g560_disabled");
    }
    try {
        settings = await settingsStore.save(settings);
    } catch (error) {
        logger.error("Unable to save G560 lighting state", error?.message ?? String(error));
    }
    if (shuttingDown) return;
    lightingEngine.setEnabled(settings.enabled && settings.g560Enabled);
    if (settings.enabled && settings.g560Enabled) {
        lightingDirector.allowResume();
        await lightingEngine.rescanProvider();
        if (lightingDirector.getWorldState().sessionActive) lightingDirector.reconcile("G560 enabled");
    }
    logger.info("G560 lighting changed", { enabled: settings.g560Enabled });
    refreshTray();
}

async function setG560Brightness(brightness) {
    if (shuttingDown) return;
    settings = await settingsStore.save({ ...settings, g560Brightness: brightness });
    lightingEngine.setBrightness(settings.g560Brightness);
    logger.info("G560 brightness changed", { brightness: settings.g560Brightness });
    refreshTray();
}

async function setReducedFlashing(enabled) {
    if (shuttingDown) return;
    settings = await settingsStore.save({ ...settings, reducedFlashing: enabled === true });
    lightingEngine.setReducedFlashing(settings.reducedFlashing);
    logger.info("Reduced flashing changed", { enabled: settings.reducedFlashing });
    refreshTray();
}

function showAbout() {
    observeUiPromise(dialog.showMessageBox({
        type: "info",
        title: APP_NAME,
        message: `${APP_NAME} ${app.getVersion()}`,
        detail: "Immersive Elite Dangerous lighting for Logitech G560 speakers and the Farming Simulator 22 Collector's Edition USB beacon.\n\nAll Journal, Status, USB and G HUB activity remains local to this computer.",
        buttons: ["OK"]
    }), "Show About dialog");
}

async function initialize() {
    app.setName(APP_NAME);
    app.setAppUserModelId("com.samd03.edbeaconcompanion");

    const userData = app.getPath("userData");
    logger = new RotatingLogger({ directory: path.join(userData, "logs") });
    settingsStore = new SettingsStore(path.join(userData, "settings.json"));
    settings = await settingsStore.load();
    ipcMain.removeHandler(MONITOR_REQUEST_CHANNEL);
    ipcMain.handle(MONITOR_REQUEST_CHANNEL, () => developerMonitorSnapshot());

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
    beaconFsdSequence = new BeaconFsdSequence();

    lightingProvider = new G560BridgeProvider({
        logger,
        listDevicesFn: (vendorId, productId) => adapter.list(vendorId, productId),
        onStatusChange: (providerStatus) => updateRuntime({
            lightingStatus: { ...(runtime.lightingStatus ?? {}), provider: providerStatus }
        })
    });
    lightingEngine = new LightingEngine({
        provider: lightingProvider,
        logger,
        brightness: settings.g560Brightness,
        reducedFlashing: settings.reducedFlashing,
        installSeed: settings.installationSeed,
        onStatusChange: (lightingStatus) => updateRuntime({ lightingStatus })
    });
    lightingEngine.setEnabled(settings.enabled && settings.g560Enabled);
    lightingDirector = new EliteLightingDirector({ engine: lightingEngine, logger });

    eliteProcessMonitor = new EliteProcessMonitor({
        logger,
        onChange: (running) => {
            // The beacon has its own controller and must not rely on a Journal
            // Shutdown event, which is absent after a crash or forced exit.
            if (running !== true) {
                beaconFsdSequence.reset();
                controller.stopAll("game_process_exit");
            }
            if (running === true && !telemetryIsLive()) return undefined;
            return enqueueLighting(
                () => {
                    if (running !== true || telemetryIsLive()) lightingDirector.handleGameProcess(running);
                },
                "Elite process"
            );
        },
        onStatusChange: (eliteProcessStatus) => updateRuntime({ eliteProcessStatus })
    });

    journalRuntime = new JournalRuntime({
        logger,
        onJournalReady: async ({ directory }) => {
            const scans = await loadRecentPlanetClassScans(directory);
            lightingDirector.primePlanetClassScans(scans);
        },
        onEvent: async (event) => {
            if (!telemetryIsLive()) return;
            const directives = [
                ...resolveBeaconDirectives(event),
                ...beaconFsdSequence.handleJournalEvent(event)
            ];
            if (directives.length) {
                logger.info("Elite event cue", { event: event.event, directives });
                applyBeaconDirectives(controller, directives);
            }
            await enqueueLighting(
                () => {
                    if (telemetryIsLive()) lightingDirector.handleJournalEvent(event);
                },
                `Journal:${event?.event ?? "Unknown"}`
            );
        },
        onStatus: (status, metadata) => {
            if (!telemetryIsLive()) return undefined;
            const directives = beaconFsdSequence.handleStatus(status, {
                initial: metadata?.initial === true,
                allowInitial: runtime.eliteProcessStatus?.running === true
            });
            if (directives.length) {
                logger.info("Elite status cue", { cue: "fsd_sequence", directives });
                applyBeaconDirectives(controller, directives);
            }
            return enqueueLighting(
                () => {
                    if (telemetryIsLive()) lightingDirector.handleStatus(status, metadata);
                },
                "Status.json"
            );
        },
        onStatusChange: (journalStatus) => updateRuntime({ journalStatus })
    });

    tray = new Tray(nativeImage.createFromDataURL(buildTrayIconDataUrl("disconnected")).resize({ width: 16, height: 16 }));
    tray.on("click", () => tray.popUpContextMenu());
    refreshTray();

    if (settings.enabled) {
        controller.scan();
        if (settings.g560Enabled) await lightingProvider.rescan();
        await eliteProcessMonitor.start();
        journalRuntime.start();
    }
    if (app.isPackaged && settings.launchAtLogin) {
        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    }
    logger.info("Companion started", {
        version: app.getVersion(),
        enabled: settings.enabled,
        g560Enabled: settings.g560Enabled,
        reducedFlashing: settings.reducedFlashing
    });
}

async function runPackageSmoke() {
    let provider = null;
    try {
        const image = nativeImage.createFromDataURL(buildTrayIconDataUrl("ready"));
        if (image.isEmpty()) throw new Error("Packaged tray icon is empty.");
        const adapter = createNodeHidAdapter();
        const devices = adapter.list();
        provider = new G560BridgeProvider({
            listDevicesFn: (vendorId, productId) => adapter.list(vendorId, productId)
        });
        const detected = await provider.rescan();
        await provider.ensureBridge();
        await provider.destroy("package_smoke");
        console.log(`Packaged Electron smoke passed; HID devices: ${devices.length}; G560 detected: ${detected === true}`);
        app.exit(0);
    } catch (error) {
        await provider?.destroy("package_smoke_error").catch(() => {});
        console.error(error?.stack ?? error?.message ?? String(error));
        app.exit(1);
    }
}

if (hasSingleInstanceLock) {
    if (!packageSmokeMode) app.on("second-instance", () => tray?.popUpContextMenu());
    app.whenReady().then(packageSmokeMode ? runPackageSmoke : initialize).catch((error) => {
        if (packageSmokeMode) {
            console.error(error?.stack ?? error?.message ?? String(error));
            app.exit(1);
        } else {
            void dialog.showErrorBox(APP_NAME, error?.stack ?? error?.message ?? String(error));
            app.quit();
        }
    });
}

async function shutDown() {
    shuttingDown = true;
    stopDeveloperMonitorUpdates();
    developerMonitorWindow?.destroy();
    developerMonitorWindow = null;
    ipcMain.removeHandler(MONITOR_REQUEST_CHANNEL);
    beaconFsdSequence?.reset();
    controller?.destroy("application_exit");
    lightingDirector?.destroy();
    lightingEngine?.setEnabled(false);
    await Promise.allSettled([
        eliteProcessMonitor?.stop(),
        journalRuntime?.stop(),
        lightingInputQueue,
        lifecycleMutationQueue,
        lightingEngine?.destroy("application_exit")
    ]);
    logger?.info?.("Companion stopped");
}

app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownPromise) return;
    let timedOut = false;
    shutdownPromise = Promise.race([
        shutDown(),
        new Promise((resolve) => {
            const timer = setTimeout(() => {
                timedOut = true;
                resolve();
            }, 10_000);
            timer.unref?.();
        })
    ]).finally(() => {
        if (timedOut) {
            logger?.warn?.("Shutdown timed out; forcing native bridge termination");
            lightingProvider?.forceTerminate?.("shutdown_timeout");
        }
        shutdownComplete = true;
        app.exit(0);
    });
});
