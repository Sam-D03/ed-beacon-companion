// Protocol documented by https://github.com/duckfullstop/blinkybeacon
// and used under its MIT license. See THIRD_PARTY_NOTICES.md.

export const FS22_BEACON_VENDOR_ID = 0x340d;
export const FS22_BEACON_PRODUCT_ID = 0x1710;

export const BEACON_EFFECTS = Object.freeze({
    OFF: "off",
    SPIN: "spin",
    STROBE: "strobe"
});

export const FS22_BEACON_REPORTS = Object.freeze({
    [BEACON_EFFECTS.OFF]: Object.freeze([0x00, 0xff, 0x00, 0x00, 0x64, 0x00, 0x32, 0x9e, 0xd7, 0x0d]),
    [BEACON_EFFECTS.SPIN]: Object.freeze([0x00, 0xff, 0x01, 0x66, 0xc8, 0xff, 0xad, 0x52, 0x81, 0xd6]),
    [BEACON_EFFECTS.STROBE]: Object.freeze([0x00, 0xff, 0x07, 0xff, 0x50, 0xff, 0x1c, 0x8e, 0xb0, 0xb8])
});

export function getBeaconReport(effect) {
    const report = FS22_BEACON_REPORTS[effect];
    if (!report) {
        throw new Error(`Unsupported beacon effect: ${effect}`);
    }
    return [...report];
}
