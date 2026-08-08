export const LIGHTING_ZONES = Object.freeze([
    "leftFront",
    "leftRear",
    "rightFront",
    "rightRear"
]);

const BLACK = Object.freeze({ r: 0, g: 0, b: 0 });

export function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(1, Math.max(0, number));
}

export function srgbByteToLinear(value) {
    const channel = clamp01(Number(value) / 255);
    return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgbByte(value) {
    const channel = clamp01(value);
    const encoded = channel <= 0.0031308
        ? channel * 12.92
        : 1.055 * (channel ** (1 / 2.4)) - 0.055;
    return Math.round(clamp01(encoded) * 255);
}

export function rgb8(red, green, blue) {
    return {
        r: srgbByteToLinear(red),
        g: srgbByteToLinear(green),
        b: srgbByteToLinear(blue)
    };
}

export function hexColor(value) {
    const hex = String(value ?? "").replace(/^#/, "").trim();
    if (!/^[0-9a-f]{6}$/i.test(hex)) {
        throw new Error(`Invalid RGB colour: ${value}`);
    }
    return rgb8(
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16)
    );
}

export function cloneColor(color = BLACK) {
    return {
        r: clamp01(color.r),
        g: clamp01(color.g),
        b: clamp01(color.b)
    };
}

export function scaleColor(color, scale) {
    const amount = Math.max(0, Number(scale) || 0);
    return {
        r: clamp01(color?.r * amount),
        g: clamp01(color?.g * amount),
        b: clamp01(color?.b * amount)
    };
}

export function mixColor(from, to, amount) {
    const alpha = clamp01(amount);
    return {
        r: clamp01((from?.r ?? 0) + ((to?.r ?? 0) - (from?.r ?? 0)) * alpha),
        g: clamp01((from?.g ?? 0) + ((to?.g ?? 0) - (from?.g ?? 0)) * alpha),
        b: clamp01((from?.b ?? 0) + ((to?.b ?? 0) - (from?.b ?? 0)) * alpha)
    };
}

export function addColors(...colors) {
    return colors.reduce((result, color) => ({
        r: clamp01(result.r + (color?.r ?? 0)),
        g: clamp01(result.g + (color?.g ?? 0)),
        b: clamp01(result.b + (color?.b ?? 0))
    }), { r: 0, g: 0, b: 0 });
}

export function createFrame(value = BLACK) {
    const resolve = typeof value === "function" ? value : () => value;
    return Object.fromEntries(LIGHTING_ZONES.map((zone, index) => [
        zone,
        cloneColor(resolve(zone, index) ?? BLACK)
    ]));
}

export function frameFromZones(zones = {}, fallback = BLACK) {
    return Object.fromEntries(LIGHTING_ZONES.map((zone) => [
        zone,
        cloneColor(zones[zone] ?? fallback)
    ]));
}

export function cloneFrame(frame) {
    return frameFromZones(frame);
}

export function scaleFrame(frame, scale) {
    return Object.fromEntries(LIGHTING_ZONES.map((zone) => [zone, scaleColor(frame?.[zone], scale)]));
}

export function mixFrames(from, to, amount) {
    return Object.fromEntries(LIGHTING_ZONES.map((zone) => [
        zone,
        mixColor(from?.[zone] ?? BLACK, to?.[zone] ?? BLACK, amount)
    ]));
}

function blendChannel(base, overlay, amount, mode) {
    switch (mode) {
        case "add": return clamp01(base + overlay * amount);
        case "screen": return clamp01(1 - (1 - base) * (1 - overlay * amount));
        case "multiply": return clamp01(base * (1 - amount + overlay * amount));
        case "max": return Math.max(base, overlay * amount);
        case "replace":
        case "normal":
        default: return clamp01(base + (overlay - base) * amount);
    }
}

export function compositeFrame(baseFrame, layerFrame, {
    opacity = 1,
    blend = "screen",
    dimUnderlay = 0
} = {}) {
    return Object.fromEntries(LIGHTING_ZONES.map((zone) => {
        const zoneOpacity = clamp01(typeof opacity === "object" ? opacity?.[zone] : opacity);
        const dim = clamp01(typeof dimUnderlay === "object" ? dimUnderlay?.[zone] : dimUnderlay);
        const base = scaleColor(baseFrame?.[zone] ?? BLACK, 1 - dim * zoneOpacity);
        const overlay = layerFrame?.[zone] ?? BLACK;
        return [zone, {
            r: blendChannel(base.r, overlay.r, zoneOpacity, blend),
            g: blendChannel(base.g, overlay.g, zoneOpacity, blend),
            b: blendChannel(base.b, overlay.b, zoneOpacity, blend)
        }];
    }));
}

export function frameToPercentages(frame, {
    brightness = 1,
    zoneGains = {}
} = {}) {
    const master = clamp01(brightness);
    return Object.fromEntries(LIGHTING_ZONES.map((zone) => {
        const gain = Math.max(0, Number(zoneGains?.[zone] ?? 1) || 0);
        const color = scaleColor(frame?.[zone] ?? BLACK, master * gain);
        return [zone, [
            Math.round(linearToSrgbByte(color.r) / 255 * 100),
            Math.round(linearToSrgbByte(color.g) / 255 * 100),
            Math.round(linearToSrgbByte(color.b) / 255 * 100)
        ]];
    }));
}

export function percentageFramesEqual(left, right) {
    if (!left || !right) return false;
    return LIGHTING_ZONES.every((zone) =>
        left[zone]?.length === 3 && right[zone]?.length === 3 &&
        left[zone].every((value, index) => value === right[zone][index]));
}

export function colorToHex(color) {
    return `#${[color?.r, color?.g, color?.b]
        .map((channel) => linearToSrgbByte(channel).toString(16).padStart(2, "0"))
        .join("")}`;
}

export function frameToHex(frame) {
    return Object.fromEntries(LIGHTING_ZONES.map((zone) => [zone, colorToHex(frame?.[zone] ?? BLACK)]));
}

export const BLACK_FRAME = Object.freeze(createFrame(BLACK));
