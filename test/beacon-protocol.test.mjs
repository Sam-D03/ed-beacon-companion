import assert from "node:assert/strict";
import test from "node:test";

import {
    BEACON_EFFECTS,
    FS22_BEACON_PRODUCT_ID,
    FS22_BEACON_REPORTS,
    FS22_BEACON_VENDOR_ID,
    getBeaconReport
} from "../src/beacon-protocol.mjs";

test("uses the Farming Simulator beacon USB identifiers", () => {
    assert.equal(FS22_BEACON_VENDOR_ID, 0x340d);
    assert.equal(FS22_BEACON_PRODUCT_ID, 0x1710);
});

test("matches the upstream HID reports exactly", () => {
    assert.deepEqual(FS22_BEACON_REPORTS[BEACON_EFFECTS.STROBE], [0x00, 0xff, 0x07, 0xff, 0x50, 0xff, 0x1c, 0x8e, 0xb0, 0xb8]);
    assert.deepEqual(FS22_BEACON_REPORTS[BEACON_EFFECTS.SPIN], [0x00, 0xff, 0x01, 0x66, 0xc8, 0xff, 0xad, 0x52, 0x81, 0xd6]);
    assert.deepEqual(FS22_BEACON_REPORTS[BEACON_EFFECTS.OFF], [0x00, 0xff, 0x00, 0x00, 0x64, 0x00, 0x32, 0x9e, 0xd7, 0x0d]);
    assert.notEqual(getBeaconReport(BEACON_EFFECTS.SPIN), FS22_BEACON_REPORTS[BEACON_EFFECTS.SPIN]);
});
