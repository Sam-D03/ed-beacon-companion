function fnv1a(value) {
    let hash = 0x811c9dc5;
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function seedFrom(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value >>> 0;
    return fnv1a(value);
}

export function deriveSeed(...parts) {
    let seed = 0x9e3779b9;
    for (const part of parts) {
        seed ^= seedFrom(part) + 0x9e3779b9 + ((seed << 6) >>> 0) + (seed >>> 2);
        seed >>>= 0;
    }
    return seed || 1;
}

export function hashUnit(seed, index = 0, channel = 0) {
    let value = deriveSeed(seed, index, channel);
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return (value >>> 0) / 0x100000000;
}

export function smoothstep(value) {
    const amount = Math.min(1, Math.max(0, Number(value) || 0));
    return amount * amount * (3 - 2 * amount);
}

export function smootherstep(value) {
    const amount = Math.min(1, Math.max(0, Number(value) || 0));
    return amount * amount * amount * (amount * (amount * 6 - 15) + 10);
}

export function smoothNoise(seed, timeMs, periodMs = 1_000, channel = 0) {
    const period = Math.max(1, Number(periodMs) || 1);
    const position = Math.max(0, Number(timeMs) || 0) / period;
    const cell = Math.floor(position);
    const fraction = smootherstep(position - cell);
    const left = hashUnit(seed, cell, channel);
    const right = hashUnit(seed, cell + 1, channel);
    return left + (right - left) * fraction;
}

export function fractalNoise(seed, timeMs, {
    periodMs = 1_000,
    octaves = 3,
    persistence = 0.5,
    channel = 0
} = {}) {
    let amplitude = 1;
    let total = 0;
    let weight = 0;
    for (let octave = 0; octave < Math.max(1, octaves); octave += 1) {
        total += smoothNoise(
            deriveSeed(seed, octave),
            timeMs,
            periodMs / (2 ** octave),
            channel + octave * 17
        ) * amplitude;
        weight += amplitude;
        amplitude *= persistence;
    }
    return weight > 0 ? total / weight : 0;
}

export function randomImpulse(seed, timeMs, {
    bucketMs = 1_000,
    chance = 0.25,
    durationMs = 180,
    channel = 0
} = {}) {
    const bucket = Math.floor(Math.max(0, Number(timeMs) || 0) / bucketMs);
    const bucketStart = bucket * bucketMs;
    const offset = hashUnit(seed, bucket, channel + 1) * Math.max(0, bucketMs - durationMs);
    const elapsed = timeMs - bucketStart - offset;
    const active = hashUnit(seed, bucket, channel) < chance && elapsed >= 0 && elapsed < durationMs;
    if (!active) return 0;
    const phase = elapsed / Math.max(1, durationMs);
    return Math.sin(Math.PI * phase) ** 2 * (0.45 + hashUnit(seed, bucket, channel + 2) * 0.55);
}

export function randomChoice(values, seed, index = 0, channel = 0) {
    if (!Array.isArray(values) || values.length === 0) return undefined;
    return values[Math.min(values.length - 1, Math.floor(hashUnit(seed, index, channel) * values.length))];
}
