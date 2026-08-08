import { app, nativeImage } from "electron";

import { createNodeHidAdapter } from "../src/node-hid-adapter.mjs";
import { G560BridgeProvider } from "../src/providers/g560-bridge-provider.mjs";
import { buildTrayIconDataUrl } from "../src/tray-icon.mjs";

app.whenReady().then(async () => {
    let g560Provider = null;
    try {
        const image = nativeImage.createFromDataURL(buildTrayIconDataUrl("ready"));
        if (image.isEmpty()) {
            throw new Error("Tray icon data did not produce a native image.");
        }
        const adapter = createNodeHidAdapter();
        const devices = adapter.list();
        g560Provider = new G560BridgeProvider({ listDevicesFn: (vendorId, productId) => adapter.list(vendorId, productId) });
        const g560Detected = await g560Provider.rescan();
        await g560Provider.ensureBridge();
        await g560Provider.destroy("electron_smoke");
        console.log(`Electron native smoke passed; beacon devices: ${devices.length}; G560 detected: ${g560Detected === true}`);
        app.exit(0);
    } catch (error) {
        await g560Provider?.destroy("electron_smoke_error").catch(() => {});
        console.error(error);
        app.exit(1);
    }
});
