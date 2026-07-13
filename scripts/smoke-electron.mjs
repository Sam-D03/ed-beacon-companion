import { app, nativeImage } from "electron";

import { createNodeHidAdapter } from "../src/node-hid-adapter.mjs";
import { buildTrayIconDataUrl } from "../src/tray-icon.mjs";

app.whenReady().then(() => {
    try {
        const image = nativeImage.createFromDataURL(buildTrayIconDataUrl("ready"));
        if (image.isEmpty()) {
            throw new Error("Tray icon data did not produce a native image.");
        }
        const devices = createNodeHidAdapter().list();
        console.log(`Electron native smoke passed; matching HID devices: ${devices.length}`);
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
