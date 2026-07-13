import { app } from "electron";

import { BeaconController } from "../src/beacon-controller.mjs";
import { createNodeHidAdapter } from "../src/node-hid-adapter.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

app.whenReady().then(async () => {
    const controller = new BeaconController({ adapter: createNodeHidAdapter() });
    try {
        controller.scan();
        if (!controller.getStatus().connected) {
            throw new Error(controller.getStatus().lastError ?? "Beacon not found.");
        }
        console.log("Hardware smoke: spin");
        controller.pulse("spin", 1_500, "hardware_smoke");
        await wait(1_750);
        console.log("Hardware smoke: strobe");
        controller.pulse("strobe", 1_500, "hardware_smoke");
        await wait(1_750);
        controller.stopAll("hardware_smoke_complete");
        console.log("Hardware smoke passed: spin, strobe, stop");
        controller.destroy("hardware_smoke_exit");
        app.exit(0);
    } catch (error) {
        console.error(error);
        controller.destroy("hardware_smoke_error");
        app.exit(1);
    }
});
