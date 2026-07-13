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
        return [{ kind: "pulse", effect: BEACON_EFFECTS.SPIN, durationMs: 5_000, reason: eventName }];
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
