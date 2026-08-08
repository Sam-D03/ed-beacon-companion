import { BEACON_EFFECTS } from "./beacon-protocol.mjs";

const STROBE_DURATIONS_MS = Object.freeze({
    Interdicted: 6_000,
    UnderAttack: 6_000,
    HeatWarning: 8_000,
    HeatDamage: 8_000,
    CockpitBreached: 10_000,
    HullDamage: 8_000
});

function normalizeText(value) {
    return String(value ?? "").trim().toLowerCase();
}

function isMainShipUnderAttack(event = {}) {
    const target = normalizeText(event.Target);
    return !target || target === "you" || target === "mothership";
}

function isCriticalMainShipHullDamage(event = {}) {
    if (event.Fighter === true || event.PlayerPilot === false) {
        return false;
    }
    const health = Number(event.Health);
    return Number.isFinite(health) && health <= 0.5;
}

function hasStatusBit(value, bit) {
    try {
        const flags = typeof value === "bigint" ? value : BigInt(Math.max(0, Math.trunc(Number(value) || 0)));
        return (flags & (1n << BigInt(bit))) !== 0n;
    } catch {
        return false;
    }
}

export class BeaconFsdSequence {
    constructor() {
        this.reset();
    }

    reset() {
        this.charging = false;
        this.countdownType = null;
        this.overcharge = false;
    }

    handleStatus(status = {}, { initial = false, allowInitial = false } = {}) {
        if (initial && !allowInitial) return [];

        const fsdCharging = hasStatusBit(status.Flags, 17);
        const hyperdriveCharging = hasStatusBit(status.Flags2, 19);
        const charging = fsdCharging || hyperdriveCharging;
        const overcharge = hasStatusBit(status.Flags2, 20);
        const inHyperspace = hasStatusBit(status.Flags, 30);
        const inSupercruise = hasStatusBit(status.Flags, 4);

        if (this.countdownType) {
            const destinationReached = this.countdownType === "Hyperspace"
                ? inHyperspace
                : inSupercruise;
            this.charging = charging;
            this.overcharge = overcharge;
            if (!destinationReached) return [];
            const reason = this.countdownType === "Hyperspace" ? "Witchspace" : "SupercruiseEntry";
            this.countdownType = null;
            return [{
                kind: "base",
                effect: overcharge ? BEACON_EFFECTS.SPIN : BEACON_EFFECTS.OFF,
                reason: overcharge ? "Supercruise overcharge" : reason
            }];
        }

        const chargingChanged = charging !== this.charging;
        const overchargeChanged = overcharge !== this.overcharge;
        if (!chargingChanged && !overchargeChanged) return [];
        this.charging = charging;
        this.overcharge = overcharge;
        const active = charging || overcharge;
        return [{
            kind: "base",
            effect: active ? BEACON_EFFECTS.SPIN : BEACON_EFFECTS.OFF,
            reason: overcharge
                ? "Supercruise overcharge"
                : charging
                    ? (hyperdriveCharging ? "Hyperdrive charging" : "FSD charging")
                    : overchargeChanged
                        ? "Supercruise overcharge ended"
                        : "FSD charge cancelled"
        }];
    }

    handleJournalEvent(event = {}) {
        const eventName = String(event?.event ?? "").trim();
        if (eventName === "StartJump" && ["Hyperspace", "Supercruise"].includes(event?.JumpType) && event?.Taxi !== true) {
            this.charging = false;
            this.countdownType = event.JumpType;
            return [{
                kind: "base",
                effect: BEACON_EFFECTS.SPIN,
                reason: `FSD ${event.JumpType} countdown`
            }];
        }

        if (["LoadGame", "Died", "Shutdown"].includes(eventName)) {
            this.reset();
            return [];
        }

        if (["FSDJump", "SupercruiseEntry", "Location"].includes(eventName)) {
            const wasActive = this.charging || this.overcharge || this.countdownType !== null;
            this.reset();
            return wasActive
                ? [{ kind: "base", effect: BEACON_EFFECTS.OFF, reason: eventName }]
                : [];
        }

        return [];
    }
}

export function resolveBeaconDirectives(event = {}) {
    const eventName = String(event?.event ?? "").trim();
    if (!eventName) {
        return [];
    }

    if (["LoadGame", "Died", "Shutdown"].includes(eventName)) {
        return [{ kind: "stop_all", reason: eventName }];
    }

    if (eventName === "DockingGranted" && event.Taxi !== true) {
        return [{ kind: "base", effect: BEACON_EFFECTS.SPIN, reason: eventName }];
    }

    if (
        ["Docked", "DockingDenied", "DockingCancelled", "DockingTimeout"].includes(eventName) ||
        (eventName === "Location" && event.Docked === true)
    ) {
        return [{ kind: "base", effect: BEACON_EFFECTS.OFF, reason: eventName }];
    }

    if (eventName === "Undocked") {
        // Surface settlements do not always emit the same preceding docking
        // lifecycle as stations. Clear any stale clearance base before the
        // finite launch cue so rotation can never become permanent.
        return [
            { kind: "base", effect: BEACON_EFFECTS.OFF, reason: eventName },
            { kind: "pulse", effect: BEACON_EFFECTS.SPIN, durationMs: 5_000, reason: eventName }
        ];
    }

    if (eventName === "LaunchFighter" && event.PlayerControlled === true) {
        return [{
            kind: "pulse",
            effect: BEACON_EFFECTS.SPIN,
            durationMs: 5_000,
            reason: eventName
        }];
    }

    if (eventName === "UnderAttack" && !isMainShipUnderAttack(event)) {
        return [];
    }

    if (eventName === "HullDamage" && !isCriticalMainShipHullDamage(event)) {
        return [];
    }

    const durationMs = STROBE_DURATIONS_MS[eventName];
    if (durationMs) {
        return [{ kind: "pulse", effect: BEACON_EFFECTS.STROBE, durationMs, reason: eventName }];
    }

    return [];
}

export function applyBeaconDirectives(controller, directives = []) {
    for (const directive of directives) {
        if (directive.kind === "stop_all") {
            controller.stopAll(directive.reason);
        } else if (directive.kind === "base") {
            controller.setBaseEffect(directive.effect, directive.reason);
        } else if (directive.kind === "pulse") {
            controller.pulse(directive.effect, directive.durationMs, directive.reason);
        }
    }
}
