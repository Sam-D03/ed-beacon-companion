import { deflateSync } from "node:zlib";

const COLORS = Object.freeze({
    ready: [[255, 176, 0, 255], [255, 223, 122, 255]],
    active: [[255, 138, 0, 255], [255, 240, 168, 255]],
    error: [[239, 68, 68, 255], [254, 202, 202, 255]],
    disconnected: [[100, 116, 139, 255], [203, 213, 225, 255]]
});

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    return crc >>> 0;
});

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
    return Buffer.concat([length, typeBuffer, data, checksum]);
}

function setPixel(pixels, width, height, x, y, color) {
    const px = Math.trunc(x);
    const py = Math.trunc(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 4;
    pixels.set(color, offset);
}

function drawLine(pixels, width, height, x0, y0, x1, y1, color, thickness = 1) {
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    let x = x0;
    let y = y0;
    while (true) {
        for (let ox = -Math.floor(thickness / 2); ox <= Math.floor(thickness / 2); ox += 1) {
            for (let oy = -Math.floor(thickness / 2); oy <= Math.floor(thickness / 2); oy += 1) {
                setPixel(pixels, width, height, x + ox, y + oy, color);
            }
        }
        if (x === x1 && y === y1) break;
        const twiceError = 2 * error;
        if (twiceError >= dy) { error += dy; x += sx; }
        if (twiceError <= dx) { error += dx; y += sy; }
    }
}

export function buildTrayIconPng(state = "ready", size = 32) {
    const width = 32;
    const height = 32;
    const [primary, highlight] = COLORS[state] ?? COLORS.ready;
    const pixels = Buffer.alloc(width * height * 4);
    const dark = [31, 41, 55, 255];

    for (const [x0, y0, x1, y1] of [
        [16, 2, 16, 5], [5, 6, 8, 9], [27, 6, 24, 9], [2, 16, 6, 16], [26, 16, 30, 16]
    ]) {
        drawLine(pixels, width, height, x0, y0, x1, y1, primary, 2);
    }

    for (let y = 8; y <= 24; y += 1) {
        const progress = (y - 8) / 16;
        const halfWidth = Math.round(4 + progress * 3);
        for (let x = 16 - halfWidth; x <= 16 + halfWidth; x += 1) {
            const border = x === 16 - halfWidth || x === 16 + halfWidth || y === 8 || y === 24;
            setPixel(pixels, width, height, x, y, border ? dark : primary);
        }
    }
    drawLine(pixels, width, height, 13, 11, 13, 16, highlight, 2);
    for (let y = 25; y <= 28; y += 1) {
        for (let x = 5; x <= 27; x += 1) {
            setPixel(pixels, width, height, x, y, dark);
        }
    }

    const outputSize = Math.max(16, Math.trunc(Number(size) || 32));
    const outputPixels = outputSize === 32
        ? pixels
        : Buffer.alloc(outputSize * outputSize * 4);
    if (outputSize !== 32) {
        for (let y = 0; y < outputSize; y += 1) {
            for (let x = 0; x < outputSize; x += 1) {
                const sourceX = Math.min(31, Math.floor(x * 32 / outputSize));
                const sourceY = Math.min(31, Math.floor(y * 32 / outputSize));
                const sourceOffset = (sourceY * 32 + sourceX) * 4;
                pixels.copy(outputPixels, (y * outputSize + x) * 4, sourceOffset, sourceOffset + 4);
            }
        }
    }

    const scanlines = Buffer.alloc((outputSize * 4 + 1) * outputSize);
    for (let y = 0; y < outputSize; y += 1) {
        const rowOffset = y * (outputSize * 4 + 1);
        scanlines[rowOffset] = 0;
        outputPixels.copy(scanlines, rowOffset + 1, y * outputSize * 4, (y + 1) * outputSize * 4);
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(outputSize, 0);
    header.writeUInt32BE(outputSize, 4);
    header.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(scanlines)),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
}

export function resolveTrayIconState({ enabled, beaconStatus = {}, journalStatus = {} } = {}) {
    if (beaconStatus.lastError && enabled) return "error";
    if (!enabled || !beaconStatus.connected || journalStatus.state !== "watching") return "disconnected";
    if (beaconStatus.effect && beaconStatus.effect !== "off") return "active";
    return "ready";
}

export function buildTrayIconDataUrl(state = "ready") {
    return `data:image/png;base64,${buildTrayIconPng(state).toString("base64")}`;
}
