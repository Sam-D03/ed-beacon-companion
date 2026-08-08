const { contextBridge, ipcRenderer } = require("electron");

const SNAPSHOT_CHANNEL = "ed-beacon-companion:developer-monitor:snapshot";
const REQUEST_CHANNEL = "ed-beacon-companion:developer-monitor:request-snapshot";

contextBridge.exposeInMainWorld("edBeaconMonitor", Object.freeze({
    requestSnapshot: () => ipcRenderer.invoke(REQUEST_CHANNEL),
    onSnapshot: (listener) => {
        if (typeof listener !== "function") return () => {};
        const handler = (_event, snapshot) => listener(snapshot);
        ipcRenderer.on(SNAPSHOT_CHANNEL, handler);
        return () => ipcRenderer.removeListener(SNAPSHOT_CHANNEL, handler);
    }
}));
