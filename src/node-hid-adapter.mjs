import { createRequire } from "node:module";

import {
    FS22_BEACON_PRODUCT_ID,
    FS22_BEACON_VENDOR_ID
} from "./beacon-protocol.mjs";

const require = createRequire(import.meta.url);

export function createNodeHidAdapter() {
    const HID = require("node-hid");
    return {
        list() {
            return HID.devices(FS22_BEACON_VENDOR_ID, FS22_BEACON_PRODUCT_ID);
        },
        open(deviceInfo = {}) {
            if (deviceInfo.path) {
                return new HID.HID(deviceInfo.path);
            }
            return new HID.HID(FS22_BEACON_VENDOR_ID, FS22_BEACON_PRODUCT_ID);
        }
    };
}
