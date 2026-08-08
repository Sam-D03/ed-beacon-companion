import { getLightingScene } from "./lighting-scene-catalog.mjs";
import { getPlanetColourSeed } from "./planet-colour-seeds.mjs";

export const STATUS_FLAGS = Object.freeze({
    docked: 0,
    landed: 1,
    landingGear: 2,
    shieldsUp: 3,
    supercruise: 4,
    flightAssistOff: 5,
    hardpoints: 6,
    inWing: 7,
    lightsOn: 8,
    cargoScoop: 9,
    silentRunning: 10,
    fuelScooping: 11,
    srvHandbrake: 12,
    srvTurretView: 13,
    srvTurretRetracted: 14,
    srvDriveAssist: 15,
    massLocked: 16,
    fsdCharging: 17,
    fsdCooldown: 18,
    lowFuel: 19,
    overheating: 20,
    hasLatLong: 21,
    inDanger: 22,
    interdicted: 23,
    inMainShip: 24,
    inFighter: 25,
    inSrv: 26,
    analysisMode: 27,
    nightVision: 28,
    fsdJump: 30,
    srvHighBeam: 31
});

export const STATUS_FLAGS_2 = Object.freeze({
    onFoot: 0,
    inTaxi: 1,
    inMulticrew: 2,
    onFootStation: 3,
    onFootPlanet: 4,
    aimDownSights: 5,
    lowOxygen: 6,
    lowHealth: 7,
    cold: 8,
    hot: 9,
    veryCold: 10,
    veryHot: 11,
    glide: 12,
    onFootHangar: 13,
    onFootSocial: 14,
    onFootExterior: 15,
    breathableAtmosphere: 16,
    telepresenceMulticrew: 17,
    physicalMulticrew: 18,
    hyperdriveCharging: 19,
    supercruiseOvercharge: 20,
    supercruiseAssist: 21
});

const GUI_BASE_SCENES = Object.freeze({
    5: ["station_services", "Station services"],
    6: ["galaxy_map", "Galaxy Map"],
    7: ["system_map", "System Map"],
    8: ["system_map", "Orrery"],
    9: ["fss", "Full Spectrum Scanner"],
    10: ["saa", "Surface Scanner"],
    11: ["codex", "Codex"]
});

const MUSIC_BASE_SCENES = Object.freeze({
    MainMenu: "main_menu",
    GalaxyMap: "galaxy_map",
    SystemMap: "system_map",
    SystemAndSurfaceScanner: "fss",
    Codex: "codex",
    Starport: "docked",
    Damaged_Starport: "damaged_station",
    Exploration: "exploration",
    Unknown_Exploration: "exploration",
    GuardianSites: "guardian_site",
    Combat_Dogfight: "combat_ambience",
    Combat_SRV: "combat_ambience",
    Combat_LargeDogFight: "combat_ambience",
    CombatLargeDogFight: "combat_ambience",
    Interdiction: "combat_ambience",
    CQC: "cqc",
    CQCMenu: "cqc",
    CapitalShip: "capital_ship",
    Supercruise: "supercruise",
    DestinationFromHyperspace: "supercruise",
    DestinationFromSupercruise: "normal_flight",
    OnFoot: "on_foot_surface",
    GalacticPowers: "codex",
    Squadrons: "codex"
});

const SERVICE_EVENTS = new Set([
    "AfmuRepairs", "BuyAmmo", "BuyDrones", "BuyFuel", "BuyRepair", "BuyExplorationData",
    "FetchRemoteModule", "MassModuleStore", "ModuleBuy", "ModuleRetrieve",
    "ModuleSell", "ModuleSellRemote", "ModuleStore", "RefuelAll", "RefuelPartial",
    "Repair", "RepairAll", "RepairDrone", "RestockVehicle", "ShipyardBuy", "ShipyardSwap",
    "Synthesis"
]);

const KILL_EVENTS = new Set([
    "Bounty", "CapShipBond", "FactionKillBond", "PVPKill"
]);

const REWARD_EVENTS = new Set([
    "CommunityGoalReward", "MissionCompleted", "MultiSellExplorationData", "Promotion",
    "SellExplorationData", "SellOrganicData", "RedeemVoucher", "PowerplayMerits", "DatalinkVoucher"
]);

const ENGINEERING_EVENTS = new Set([
    "EngineerCraft", "EngineerLegacyConvert", "EngineerContribution",
    "UpgradeSuit", "UpgradeWeapon", "BuyMicroResources", "TradeMicroResources",
    "MaterialTrade", "TechnologyBroker"
]);

function eventAccent(options = {}) {
    return {
        priority: 975,
        exclusiveGroup: "event-accent",
        retrigger: "restart",
        ...options
    };
}

function toBigInt(value) {
    try {
        if (typeof value === "bigint") return value;
        const number = Number(value);
        return Number.isFinite(number) ? BigInt(Math.max(0, Math.trunc(number))) : 0n;
    } catch {
        return 0n;
    }
}

export function hasStatusBit(value, bit) {
    return (toBigInt(value) & (1n << BigInt(bit))) !== 0n;
}

function finiteNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizedText(value) {
    return String(value ?? "").trim().toLowerCase();
}

const BODY_COLOUR_CATALOGUE_LIMIT = 1_024;

function bodyIdentity(world, event = {}) {
    const systemAddress = event.SystemAddress ?? world.systemAddress ?? null;
    const starSystem = event.StarSystem ?? world.starSystem ?? null;
    const bodyId = event.BodyID ?? null;
    const bodyName = event.Body ?? event.BodyName ?? null;
    return { systemAddress, starSystem, bodyId, bodyName };
}

function bodyIdentityKeys(identity = {}) {
    const address = String(identity.systemAddress ?? "").trim();
    const systemName = normalizedText(identity.starSystem);
    const systemKey = address ? `address:${address}` : systemName ? `system:${systemName}` : null;
    if (!systemKey) return [];
    const keys = [];
    if (identity.bodyId != null && String(identity.bodyId).trim()) keys.push(`${systemKey}|id:${identity.bodyId}`);
    const bodyName = normalizedText(identity.bodyName);
    if (bodyName) keys.push(`${systemKey}|name:${bodyName}`);
    return keys;
}

function findRememberedPlanetClass(world, identity) {
    for (const key of bodyIdentityKeys(identity)) {
        const planetClass = world.bodyColourCatalogue.get(key);
        if (planetClass) return planetClass;
    }
    return null;
}

function rememberPlanetClass(world, event = {}) {
    const seed = getPlanetColourSeed(event.PlanetClass);
    if (!seed) return false;
    const identity = bodyIdentity(world, event);
    const keys = bodyIdentityKeys(identity);
    if (keys.length === 0) return false;
    for (const key of keys) world.bodyColourCatalogue.set(key, seed.planetClass);
    while (world.bodyColourCatalogue.size > BODY_COLOUR_CATALOGUE_LIMIT) {
        world.bodyColourCatalogue.delete(world.bodyColourCatalogue.keys().next().value);
    }

    const currentKeys = new Set(bodyIdentityKeys({
        systemAddress: world.systemAddress,
        starSystem: world.starSystem,
        bodyId: world.bodyId,
        bodyName: world.bodyName
    }));
    if (keys.some((key) => currentKeys.has(key))) world.planetClass = seed.planetClass;
    return true;
}

function bodyScanAccent(world, event = {}) {
    const identity = bodyIdentity(world, event);
    const planetClass = getPlanetColourSeed(event.PlanetClass)?.planetClass ??
        findRememberedPlanetClass(world, identity);
    if (!planetClass) return null;
    const identityKey = bodyIdentityKeys(identity)[0] ?? normalizedText(identity.bodyName) ?? "unknown";
    return {
        key: `body-scan:${identityKey}`,
        planetClass
    };
}

function setCurrentBody(world, event = {}, { active = world.bodyContextActive } = {}) {
    const previousSystemAddress = world.systemAddress;
    const previousStarSystem = world.starSystem;
    const previousBodyName = world.bodyName;
    const nextSystemAddress = event.SystemAddress ?? previousSystemAddress ?? null;
    const nextStarSystem = event.StarSystem ?? previousStarSystem ?? null;
    const nextBodyName = event.Body ?? event.BodyName ?? previousBodyName ?? null;
    const sameBody = normalizedText(nextBodyName) === normalizedText(previousBodyName) &&
        String(nextSystemAddress ?? "") === String(previousSystemAddress ?? "") &&
        normalizedText(nextStarSystem) === normalizedText(previousStarSystem);
    const nextBodyId = event.BodyID ?? (sameBody ? world.bodyId : null);

    world.systemAddress = nextSystemAddress;
    world.starSystem = nextStarSystem;
    world.bodyName = nextBodyName;
    world.bodyId = nextBodyId;
    world.bodyContextActive = active === true;
    world.planetClass = findRememberedPlanetClass(world, {
        systemAddress: nextSystemAddress,
        starSystem: nextStarSystem,
        bodyId: nextBodyId,
        bodyName: nextBodyName
    });
}

function clearCurrentBody(world) {
    world.bodyName = null;
    world.bodyId = null;
    world.bodyContextActive = false;
    world.planetClass = null;
}

function bodySceneReason(world, fallback) {
    return world.planetClass ? `${fallback} · ${world.planetClass}` : fallback;
}

export function decodeEliteStatus(status = {}) {
    const flags = toBigInt(status.Flags);
    const flags2 = toBigInt(status.Flags2);
    const decoded = { raw: status, flags, flags2 };
    for (const [name, bit] of Object.entries(STATUS_FLAGS)) decoded[name] = hasStatusBit(flags, bit);
    for (const [name, bit] of Object.entries(STATUS_FLAGS_2)) decoded[name] = hasStatusBit(flags2, bit);
    decoded.guiFocus = Math.max(0, Math.trunc(finiteNumber(status.GuiFocus, 0)));
    decoded.health = finiteNumber(status.Health);
    decoded.oxygen = finiteNumber(status.Oxygen);
    decoded.temperature = finiteNumber(status.Temperature);
    decoded.altitude = finiteNumber(status.Altitude);
    decoded.legalState = String(status.LegalState ?? "");
    decoded.bodyName = status.BodyName ?? null;
    decoded.destination = status.Destination ?? null;
    decoded.pips = Array.isArray(status.Pips) ? status.Pips.slice(0, 3).map((value) => finiteNumber(value, 0)) : null;
    decoded.fireGroup = Math.max(0, Math.trunc(finiteNumber(status.FireGroup, 0)));
    decoded.selectedWeapon = status.SelectedWeapon ?? null;
    decoded.fuelMain = finiteNumber(status.Fuel?.FuelMain);
    decoded.fuelReservoir = finiteNumber(status.Fuel?.FuelReservoir);
    decoded.cargo = finiteNumber(status.Cargo);
    decoded.heading = finiteNumber(status.Heading);
    decoded.gravity = finiteNumber(status.Gravity);
    return decoded;
}

function createWorld() {
    return {
        sessionActive: false,
        gameProcessActive: null,
        status: decodeEliteStatus(),
        statusSeen: false,
        music: null,
        dockingState: null,
        pendingJumpType: null,
        systemArrivalAtMs: null,
        starClass: null,
        starSystem: null,
        systemAddress: null,
        bodyName: null,
        bodyId: null,
        bodyContextActive: false,
        planetClass: null,
        bodyColourCatalogue: new Map(),
        stationName: null,
        stationState: null,
        hullHealth: null,
        fighterHullHealth: null,
        srvHullHealth: null,
        colonisationDepots: new Map(),
        thargoidEncounter: false,
        activity: null,
        targetScan: null,
        shutdownLatched: false,
        lastJournalEvent: null
    };
}

function mainShipEvent(event, status) {
    if (event?.PlayerPilot === false) return false;
    if (event?.Fighter === true) return status.inFighter === true;
    const target = normalizedText(event?.Target);
    if (!target || target === "you" || target === "mothership") return true;
    if (target === "fighter") return status.inFighter === true;
    if (target === "srv") return status.inSrv === true;
    return false;
}

function isDefinitiveThargoidEvent(event = {}) {
    const name = String(event.event ?? "");
    if (name === "Interdiction") return event.Success === true && event.IsThargoid === true;
    if (["Interdicted", "UnderAttack", "HullDamage", "ShipTargeted"].includes(name)) {
        return event.IsThargoid === true;
    }
    if (!["USSDrop", "SupercruiseDestinationDrop"].includes(name)) return false;
    const type = [event.USSType, event.USSType_Localised, event.Type, event.Type_Localised]
        .filter(Boolean)
        .join(" ");
    return /\$uss_type_nonhuman;|non[ -]?human signal/iu.test(type);
}

function isDamagedStationState(value) {
    return ["damaged", "damagedhuman", "underattack", "under_attack"]
        .includes(normalizedText(value));
}

function shieldedAsset(status = {}) {
    if (status.inMainShip) return "mainShip";
    if (status.inFighter) return "fighter";
    if (status.inSrv) return "srv";
    return null;
}

function contextForWorld(world) {
    const planetColour = getPlanetColourSeed(world.planetClass);
    return {
        starClass: world.starClass,
        starSystem: world.starSystem,
        bodyName: world.bodyName ?? world.status.bodyName,
        planetClass: planetColour?.planetClass ?? null,
        planetColourHex: planetColour?.dominantHex ?? null,
        planetColourName: planetColour?.colourName ?? null,
        stationName: world.stationName,
        stationState: world.stationState,
        temperature: world.status.temperature,
        health: world.status.health,
        oxygen: world.status.oxygen,
        altitude: world.status.altitude,
        legalState: world.status.legalState,
        pips: world.status.pips,
        fuelMain: world.status.fuelMain,
        fuelReservoir: world.status.fuelReservoir,
        cargo: world.status.cargo,
        heading: world.status.heading,
        gravity: world.status.gravity,
        fireGroup: world.status.fireGroup,
        selectedWeapon: world.status.selectedWeapon,
        guiFocus: world.status.guiFocus,
        supercruise: world.status.supercruise,
        systemArrivalAtMs: world.systemArrivalAtMs
    };
}

export function selectEliteBaseScene(world) {
    const status = world.status ?? decodeEliteStatus();
    if (world.gameProcessActive === true && !world.statusSeen && !world.music) {
        return { sceneId: "main_menu", reason: "Elite Dangerous starting" };
    }
    // Status.json can retain its final cockpit snapshot after returning to a
    // menu. These music states are explicit session contexts and therefore
    // outrank stale docked/vehicle flags.
    if (world.music === "MainMenu") return { sceneId: "main_menu", reason: "Main menu" };
    if (world.music === "CQCMenu") return { sceneId: "cqc", reason: "CQC menu" };
    const guiScene = GUI_BASE_SCENES[status.guiFocus];
    if (guiScene) return { sceneId: guiScene[0], reason: guiScene[1] };
    if (world.pendingJumpType === "Hyperspace" || status.fsdJump) return { sceneId: "witchspace", reason: "Hyperspace" };
    if (world.pendingJumpType === "Supercruise") return { sceneId: "supercruise", reason: "Entering supercruise" };
    if (status.glide) return { sceneId: "glide", reason: bodySceneReason(world, "Orbital glide") };
    if (world.thargoidEncounter) return { sceneId: "thargoid_encounter", reason: "Thargoid encounter" };
    if (status.supercruiseOvercharge) return { sceneId: "supercruise_overcharge", reason: "Supercruise overcharge" };
    if (status.supercruiseAssist && status.supercruise) return { sceneId: "supercruise_assist", reason: "Supercruise assist" };
    if (world.music === "GuardianSites") return { sceneId: "guardian_site", reason: "Guardian site" };
    if (world.music === "Damaged_Starport") return { sceneId: "damaged_station", reason: "Damaged starport" };
    if (["Combat_Dogfight", "Combat_SRV", "Combat_LargeDogFight", "CombatLargeDogFight", "Interdiction"].includes(world.music)) {
        return { sceneId: "combat_ambience", reason: `Combat: ${world.music}` };
    }
    if (world.music === "CapitalShip") return { sceneId: "capital_ship", reason: "Capital ship" };
    if (world.music === "CQC") return { sceneId: "cqc", reason: "CQC" };
    if (status.inTaxi) return { sceneId: "taxi", reason: "Apex shuttle" };
    if (status.onFoot) {
        return status.onFootStation || status.onFootHangar || status.onFootSocial
            ? { sceneId: "on_foot_station", reason: "On foot in station" }
            : { sceneId: "on_foot_surface", reason: bodySceneReason(world, "On-foot expedition") };
    }
    if (status.inSrv) return { sceneId: "srv", reason: bodySceneReason(world, "SRV") };
    if (status.inFighter) return { sceneId: "fighter", reason: "Ship-launched fighter" };
    if (status.docked) {
        return isDamagedStationState(world.stationState) || world.music === "Damaged_Starport"
            ? { sceneId: "damaged_station", reason: "Damaged starport" }
            : { sceneId: status.guiFocus === 5 ? "station_services" : "docked", reason: "Docked" };
    }
    if (status.landed) return { sceneId: "landed", reason: bodySceneReason(world, "Landed") };
    if (world.activity?.kind === "mining") return { sceneId: "mining_ambience", reason: "Mining" };
    if (world.bodyContextActive || status.hasLatLong || status.onFootPlanet) {
        return { sceneId: "planetary_flight", reason: bodySceneReason(world, "Planetary flight") };
    }
    const musicScene = MUSIC_BASE_SCENES[world.music];
    if (Number.isFinite(world.systemArrivalAtMs) && (!musicScene || ["supercruise", "normal_flight", "exploration"].includes(musicScene))) {
        return { sceneId: "system_flight", reason: world.starClass ? `${world.starClass} primary star` : "Primary star arrival" };
    }
    if (musicScene && !["docked", "galaxy_map", "system_map", "fss", "codex"].includes(musicScene)) {
        return { sceneId: musicScene, reason: `Music: ${world.music}` };
    }
    if (status.supercruise) return { sceneId: "supercruise", reason: "Supercruise" };
    if (musicScene) return { sceneId: musicScene, reason: `Music: ${world.music}` };
    return { sceneId: "normal_flight", reason: "Normal space" };
}

function persistentLayer(key, sceneId, priority, reason, context = {}, options = {}) {
    return { key, sceneId, priority, reason, context, source: "status", ...options };
}

export function buildElitePersistentLayers(world) {
    const s = world.status;
    const context = contextForWorld(world);
    const layers = [];
    if (s.inMainShip && s.pips) layers.push(persistentLayer("power-distribution", "power_distribution", 150, "Power distribution", { ...context, pips: s.pips }));
    if (s.inWing || s.inMulticrew || s.telepresenceMulticrew || s.physicalMulticrew) {
        const reason = s.physicalMulticrew ? "Physical multicrew" : s.telepresenceMulticrew ? "Telepresence multicrew" : "Wing link";
        layers.push(persistentLayer("wing-link", "wing_link", 165, reason));
    }
    if (s.guiFocus >= 1 && s.guiFocus <= 4) {
        layers.push(persistentLayer("cockpit-panel", "cockpit_panel", 170, `Cockpit panel ${s.guiFocus}`, context));
    }
    if (s.lightsOn || s.srvHighBeam) layers.push(persistentLayer("exterior-lights", "exterior_lights", 180, s.srvHighBeam ? "SRV high beam" : "Exterior lights", { highBeam: s.srvHighBeam }));
    if (world.dockingState === "requested") layers.push(persistentLayer("docking", "docking_request", 430, "DockingRequested"));
    if (world.dockingState === "granted") layers.push(persistentLayer("docking", "docking_clearance", 470, "DockingGranted"));
    if (s.landingGear) layers.push(persistentLayer("gear", "landing_gear", 210, "Landing gear down"));
    if (s.cargoScoop) layers.push(persistentLayer("cargo-scoop", "cargo_scoop", 220, "Cargo scoop deployed", context));
    if (s.nightVision) layers.push(persistentLayer("night-vision", "night_vision", 235, "Night vision"));
    if (s.flightAssistOff) layers.push(persistentLayer("flight-assist", "flight_assist_off", 245, "Flight assist off"));
    if (s.aimDownSights || s.srvTurretView) layers.push(persistentLayer("targeting", "targeting", 290, s.srvTurretView ? "SRV turret view" : "Aim down sights", context));
    if (s.inSrv && s.srvHandbrake) layers.push(persistentLayer("srv-handbrake", "srv_handbrake", 205, "SRV handbrake"));
    if (s.inSrv && s.srvDriveAssist) layers.push(persistentLayer("srv-drive-assist", "srv_drive_assist", 175, "SRV drive assist"));
    if (s.fsdCooldown) layers.push(persistentLayer("fsd-cooldown", "fsd_cooldown", 360, "FSD cooldown"));
    if (s.massLocked) layers.push(persistentLayer("mass-lock", "mass_lock", 410, "FSD mass locked"));
    if (s.fuelScooping) layers.push(persistentLayer("fuel-scoop", "fuel_scoop", 455, "Fuel scooping"));
    if (!world.pendingJumpType && (s.fsdCharging || s.hyperdriveCharging)) layers.push(persistentLayer("fsd-charge", "fsd_charge", 510, s.hyperdriveCharging ? "Hyperdrive charging" : "FSD charging", { ...context, hyperspace: s.hyperdriveCharging }, { exclusiveGroup: "travel" }));
    if (s.silentRunning) layers.push(persistentLayer("silent-running", "silent_running", 610, "Silent running"));
    if (s.lowFuel) layers.push(persistentLayer("low-fuel", "low_fuel", 625, "Low fuel"));
    if (["wanted", "hostile", "warrant", "passengerwanted"].includes(normalizedText(s.legalState))) {
        layers.push(persistentLayer("legal-state", "wanted", 640, s.legalState));
    }
    if (s.inDanger) layers.push(persistentLayer("danger", "danger", 700, "In danger"));
    const activeShieldAsset = shieldedAsset(s);
    if (activeShieldAsset && !s.shieldsUp && s.inDanger) {
        const label = activeShieldAsset === "fighter"
            ? "Fighter shields offline"
            : activeShieldAsset === "srv"
                ? "SRV shields offline"
                : "Shields offline";
        layers.push(persistentLayer("shields", "shields_down", 720, label));
    }
    if (s.overheating) layers.push(persistentLayer("overheat", "overheat", 810, "Overheating", context));
    if (s.interdicted) layers.push(persistentLayer("interdiction", "interdiction", 850, "Being interdicted", context, { exclusiveGroup: "critical-primary" }));
    if (s.cold || s.veryCold) layers.push(persistentLayer("temperature", "cold", s.veryCold ? 875 : 760, s.veryCold ? "Very cold" : "Cold", context));
    if (s.hot || s.veryHot) layers.push(persistentLayer("temperature", "hot", s.veryHot ? 875 : 760, s.veryHot ? "Very hot" : "Hot", context));
    if (s.lowOxygen) layers.push(persistentLayer("oxygen", "low_oxygen", 900, "Low oxygen", context));
    if (s.lowHealth) layers.push(persistentLayer("health", "low_health", 910, "Low health", context));
    const activeHull = s.inFighter
        ? world.fighterHullHealth
        : s.inSrv
            ? world.srvHullHealth
            : s.inMainShip
                ? world.hullHealth
                : null;
    if (Number.isFinite(activeHull) && activeHull <= 0.2) {
        const label = s.inFighter ? "Fighter hull" : s.inSrv ? "SRV hull" : "Hull";
        layers.push(persistentLayer("critical-hull", "critical_hull", 920, `${label} ${Math.round(activeHull * 100)}%`, context));
    }
    return layers;
}

export class EliteLightingDirector {
    constructor({
        engine,
        logger = null,
        wallNow = Date.now,
        maxInitialStatusAgeMs = 30_000,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    } = {}) {
        if (!engine) throw new Error("EliteLightingDirector requires a lighting engine.");
        this.engine = engine;
        this.logger = logger;
        this.wallNow = wallNow;
        this.maxInitialStatusAgeMs = maxInitialStatusAgeMs;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.world = createWorld();
        this.cueTimes = new Map();
        this.activityTimer = null;
        this.stopTimer = null;
        this.previewTimer = null;
        this.previewing = false;
    }

    getWorldState() {
        return { ...this.world, status: { ...this.world.status }, activity: this.world.activity ? { ...this.world.activity } : null };
    }

    primePlanetClassScans(events = []) {
        let accepted = 0;
        for (const event of events) {
            if (rememberPlanetClass(this.world, event)) accepted += 1;
        }
        this.logger?.info?.("Planet colour metadata primed", { scans: accepted });
        return accepted;
    }

    initialStatusIsFresh(status) {
        const timestamp = Date.parse(status?.timestamp ?? "");
        if (!Number.isFinite(timestamp)) return false;
        const age = this.wallNow() - timestamp;
        return age >= -30_000 && age <= this.maxInitialStatusAgeMs;
    }

    startSession(seedHint) {
        if (this.stopTimer) this.clearTimeoutFn(this.stopTimer);
        this.stopTimer = null;
        this.world.sessionActive = true;
        this.world.shutdownLatched = false;
        this.engine.beginSession(seedHint ?? this.wallNow());
    }

    stopSession(reason = "game_inactive") {
        this.world.sessionActive = false;
        this.world.dockingState = null;
        this.world.pendingJumpType = null;
        this.world.activity = null;
        if (this.stopTimer) this.clearTimeoutFn(this.stopTimer);
        this.stopTimer = null;
        if (this.activityTimer) this.clearTimeoutFn(this.activityTimer);
        this.activityTimer = null;
        this.engine.stopNow(reason);
    }

    stopNow(reason = "manual_stop") {
        this.world.shutdownLatched = true;
        this.stopSession(reason);
    }

    allowResume(reason = "Lighting re-enabled") {
        this.world.shutdownLatched = false;
        if (this.world.gameProcessActive === true && !this.world.sessionActive) {
            this.startSession(this.wallNow());
            this.reconcile(reason);
        }
    }

    scheduleStop(delayMs, reason) {
        if (this.stopTimer) this.clearTimeoutFn(this.stopTimer);
        this.stopTimer = this.setTimeoutFn(() => {
            this.stopTimer = null;
            this.stopSession(reason);
        }, delayMs);
        this.stopTimer?.unref?.();
    }

    setActivity(kind, durationMs = 25_000) {
        this.world.activity = { kind, expiresAt: this.wallNow() + durationMs };
        if (this.activityTimer) this.clearTimeoutFn(this.activityTimer);
        this.activityTimer = this.setTimeoutFn(() => {
            this.activityTimer = null;
            if (this.world.activity?.kind === kind) {
                this.world.activity = null;
                this.reconcile(`Activity ended: ${kind}`);
            }
        }, durationMs);
        this.activityTimer?.unref?.();
    }

    allowCue(key, minimumIntervalMs) {
        const now = this.wallNow();
        const previous = this.cueTimes.get(key) ?? -Infinity;
        if (now - previous < minimumIntervalMs) return false;
        this.cueTimes.set(key, now);
        if (this.cueTimes.size > 64) this.cueTimes.delete(this.cueTimes.keys().next().value);
        return true;
    }

    trigger(sceneId, durationMs, reason, options = {}) {
        if (!this.world.sessionActive) return;
        this.engine.triggerOverlay(sceneId, {
            durationMs,
            reason,
            context: { ...contextForWorld(this.world), ...(options.context ?? {}) },
            priority: options.priority ?? 500,
            key: options.key ?? null,
            exclusiveGroup: options.exclusiveGroup ?? null,
            retrigger: options.retrigger ?? "restart",
            source: options.source ?? "journal"
        });
    }

    reconcile(reason = null) {
        if (!this.world.sessionActive || this.previewing) return;
        const base = selectEliteBaseScene(this.world);
        this.engine.setBaseScene(base.sceneId, {
            // The dominant transient already explains the triggering event.
            // Keep the underlying ambience labelled by the world state so an
            // unrelated Journal event cannot permanently mislabel it.
            reason: base.reason ?? reason,
            context: contextForWorld(this.world)
        });
        this.engine.setPersistentLayers(buildElitePersistentLayers(this.world));
    }

    handleStatus(status = {}, { initial = false } = {}) {
        const previous = this.world.statusSeen ? this.world.status : null;
        const next = decodeEliteStatus(status);
        this.world.status = next;
        this.world.statusSeen = true;
        if (next.bodyName) {
            const sameBody = normalizedText(next.bodyName) === normalizedText(this.world.bodyName);
            setCurrentBody(this.world, { Body: next.bodyName }, {
                active: next.hasLatLong || next.onFootPlanet || (sameBody && this.world.bodyContextActive)
            });
        }

        if (!this.world.sessionActive && !this.world.shutdownLatched) {
            const processAllowsInitialState = this.world.gameProcessActive === true;
            const processStateUnknown = this.world.gameProcessActive == null;
            if (processAllowsInitialState || (processStateUnknown && (!initial || this.initialStatusIsFresh(status)))) {
                this.startSession(status.timestamp ?? this.wallNow());
            }
        }
        if (this.world.shutdownLatched) return;
        if (!this.world.sessionActive) return;

        if (!initial && previous) {
            const previousAsset = shieldedAsset(previous);
            const nextAsset = shieldedAsset(next);
            const sameShieldedAsset = previousAsset != null && previousAsset === nextAsset;
            const shieldEdgeIsLive = !previous.docked && !next.docked;
            if (shieldEdgeIsLive && sameShieldedAsset && previous.shieldsUp && !next.shieldsUp) {
                this.trigger("shield_impact", 1_100, "Shields collapsed", { key: "shield-collapse", priority: 760, retrigger: "extend" });
            } else if (shieldEdgeIsLive && sameShieldedAsset && !previous.shieldsUp && next.shieldsUp) {
                this.trigger("shields_restored", 560, "Shields restored", eventAccent({ key: "shields-restored" }));
            }
            if (!previous.fsdJump && next.fsdJump) {
                if (this.world.pendingJumpType === "Hyperspace") this.world.pendingJumpType = null;
                this.engine.setBaseScene("witchspace", { reason: "Hyperspace", context: contextForWorld(this.world), transitionMs: 300 });
            }
            if (!previous.supercruise && next.supercruise && this.world.pendingJumpType === "Supercruise") {
                this.world.pendingJumpType = null;
            }
            if (previous.fsdJump && !next.fsdJump) {
                this.trigger("arrival", 2_400, "Hyperspace arrival", { priority: 620, exclusiveGroup: "travel" });
            }
        }
        if (next.docked || next.landed || next.supercruise || next.fsdJump) {
            this.world.dockingState = null;
        }
        this.reconcile(initial ? "Current game state" : null);
    }

    handleGameProcess(running, stopReason = "Elite Dangerous closed") {
        const active = running === true;
        if (!active) {
            const hadPreview = this.previewing;
            if (this.previewTimer) this.clearTimeoutFn(this.previewTimer);
            if (this.previewing) this.engine.clearTransientLayers?.({ source: "manual" });
            this.previewTimer = null;
            this.previewing = false;
            if (this.world.sessionActive) this.stopSession(stopReason);
            else if (hadPreview) this.engine.stopNow(stopReason);
            const bodyColourCatalogue = this.world.bodyColourCatalogue;
            this.world = { ...createWorld(), gameProcessActive: false, bodyColourCatalogue };
            return;
        }

        this.world.gameProcessActive = true;
        if (!this.world.sessionActive && !this.world.shutdownLatched) {
            this.startSession(this.wallNow());
            this.reconcile("Elite Dangerous running");
        }
    }

    handleMusic(event) {
        const track = String(event?.MusicTrack ?? "").trim();
        if (!track) return;
        if (track === "NoTrack") {
            this.world.music = null;
            this.reconcile("Music: NoTrack");
            return;
        }
        this.world.music = track;
        if (track === "Interdiction") this.trigger("interdiction", 5_000, "Music: Interdiction", { key: "interdiction-active", priority: 840, exclusiveGroup: "critical-primary", retrigger: "extend" });
        this.reconcile(`Music: ${track}`);
    }

    handleJournalEvent(event = {}) {
        const name = String(event?.event ?? "").trim();
        if (!name) return;
        // A watcher callback already queued when the game exits must never
        // resurrect a stopped lighting session. Unknown process state remains
        // supported for library consumers that do not use the process monitor.
        if (this.world.gameProcessActive === false) return;
        this.world.lastJournalEvent = name;

        if (name === "Shutdown") {
            this.world.shutdownLatched = true;
            this.stopSession("Shutdown");
            return;
        }
        if (name === "LoadGame") {
            if (this.previewTimer) this.clearTimeoutFn(this.previewTimer);
            this.previewTimer = null;
            this.previewing = false;
            this.engine.clearTransientLayers?.({ source: "manual" });
            const previousStatus = this.world.status;
            const bodyColourCatalogue = this.world.bodyColourCatalogue;
            const startDead = event.StartDead === true;
            this.world = {
                ...createWorld(),
                gameProcessActive: this.world.gameProcessActive,
                status: previousStatus,
                statusSeen: this.world.statusSeen,
                bodyColourCatalogue,
                sessionActive: !startDead,
                shutdownLatched: startDead,
                lastJournalEvent: name
            };
            if (startDead) {
                this.engine.stopNow("LoadGame: commander dead");
                return;
            }
            this.startSession(event.timestamp ?? this.wallNow());
            this.reconcile("LoadGame");
            return;
        }
        if (name === "Resurrect") {
            this.world.shutdownLatched = false;
            this.world.hullHealth = 1;
            this.startSession(event.timestamp ?? this.wallNow());
            this.trigger("systems_reboot", 4_500, name, { priority: 850 });
            this.reconcile(name);
            return;
        }
        if (this.world.shutdownLatched) return;
        if (!this.world.sessionActive) this.startSession(event.timestamp ?? this.wallNow());

        if (name === "Music") {
            this.handleMusic(event);
            return;
        }

        switch (name) {
            case "Location":
            case "CarrierJump":
                this.world.pendingJumpType = null;
                setCurrentBody(this.world, event, {
                    active: normalizedText(event.BodyType) === "planet" || (event.OnFoot === true && event.Docked !== true)
                });
                this.world.stationName = event.StationName ?? null;
                this.world.stationState = event.StationState ?? null;
                if (event.Docked === true) this.world.dockingState = null;
                if (name === "CarrierJump") this.trigger("carrier_jump", 8_000, name, { priority: 610, exclusiveGroup: "travel" });
                break;
            case "StartJump":
                this.world.starClass = event.StarClass ?? this.world.starClass;
                if (["Hyperspace", "Supercruise"].includes(event.JumpType) && event.Taxi !== true) {
                    this.world.pendingJumpType = event.JumpType;
                    if (event.JumpType === "Hyperspace") this.world.systemArrivalAtMs = null;
                    this.trigger("fsd_countdown", 5_000, `FSD ${event.JumpType} countdown`, { key: "journal-fsd-countdown", priority: 530, exclusiveGroup: "travel", retrigger: "restart" });
                }
                break;
            case "FSDJump":
                this.engine.clearTransientLayers?.({ key: "journal-fsd-countdown" });
                this.world.pendingJumpType = null;
                this.world.starSystem = event.StarSystem ?? this.world.starSystem;
                this.world.starClass = event.StarClass ?? this.world.starClass;
                this.world.systemArrivalAtMs = this.wallNow();
                setCurrentBody(this.world, event, { active: false });
                this.world.thargoidEncounter = false;
                this.trigger("arrival", 2_800, name, { priority: 640, exclusiveGroup: "travel" });
                break;
            case "SupercruiseEntry":
                this.engine.clearTransientLayers?.({ key: "journal-fsd-countdown" });
                this.world.pendingJumpType = null;
                this.world.activity = null;
                this.world.thargoidEncounter = false;
                this.trigger("supercruise_entry", 2_000, name, { priority: 590, exclusiveGroup: "travel" });
                break;
            case "SupercruiseExit":
                if (event.Body || event.BodyName) {
                    const bodyType = normalizedText(event.BodyType);
                    setCurrentBody(this.world, event, {
                        active: bodyType === "planet" || (!bodyType && this.world.bodyContextActive)
                    });
                }
                this.trigger("supercruise_drop", 1_800, name, { priority: 600, exclusiveGroup: "travel" });
                break;
            case "SupercruiseDestinationDrop":
            case "USSDrop": {
                const threatLevel = Math.max(0, finiteNumber(event.Threat ?? event.ThreatLevel, 0));
                this.trigger("signal_drop", threatLevel >= 4 ? 3_400 : 2_200, `${name}: ${event.Type_Localised ?? event.USSType_Localised ?? event.Type ?? event.USSType ?? "signal"}`, {
                    priority: threatLevel >= 4 ? 780 : 610,
                    exclusiveGroup: "travel",
                    context: { threatLevel }
                });
                break;
            }
            case "ApproachBody":
                setCurrentBody(this.world, event, { active: true });
                break;
            case "ApproachSettlement":
                setCurrentBody(this.world, event, { active: true });
                this.trigger("settlement_approach", 2_800, `${name}: ${event.Name ?? event.Name_Localised ?? "settlement"}`, { priority: 500 });
                break;
            case "LeaveBody":
                clearCurrentBody(this.world);
                break;
            case "DockingRequested":
                this.world.dockingState = "requested";
                break;
            case "DockingGranted":
                if (event.Taxi !== true) this.world.dockingState = "granted";
                break;
            case "DockingDenied":
                this.world.dockingState = null;
                this.trigger("docking_denied", 640, name, eventAccent());
                break;
            case "DockingCancelled":
            case "DockingTimeout":
                this.world.dockingState = null;
                break;
            case "Docked":
                this.world.dockingState = null;
                this.world.thargoidEncounter = false;
                this.world.stationName = event.StationName ?? null;
                this.world.stationState = event.StationState ?? null;
                this.trigger("touchdown", 2_200, name, { priority: 540 });
                break;
            case "Undocked":
                this.world.dockingState = null;
                this.trigger("launch", 4_000, name, { key: "undocked-launch", priority: 560, exclusiveGroup: "travel" });
                break;
            case "Liftoff":
                if (event.PlayerControlled !== false) this.trigger("launch", 3_500, name, { key: "liftoff-launch", priority: 560, exclusiveGroup: "travel" });
                break;
            case "LaunchFighter":
                if (event.PlayerControlled === true) {
                    this.world.fighterHullHealth = 1;
                    this.trigger("fighter_launch", 5_000, name, {
                        key: "fighter-launch",
                        priority: 640,
                        exclusiveGroup: "travel",
                        retrigger: "restart",
                        context: { loadout: event.Loadout, fighterId: event.ID }
                    });
                }
                break;
            case "LaunchSRV":
                if (event.PlayerControlled !== false) this.trigger("launch", 2_800, name, { priority: 540 });
                break;
            case "DropshipDeploy":
                this.trigger("conflict_insertion", 3_600, name, { priority: 760, exclusiveGroup: "travel" });
                break;
            case "Embark":
            case "Disembark":
                if (event.OnPlanet === true || event.Body || event.BodyName) {
                    setCurrentBody(this.world, event, {
                        active: event.OnPlanet === true || (event.OnStation !== true && this.world.bodyContextActive)
                    });
                }
                this.trigger("airlock", 2_200, name, {
                    priority: 520,
                    context: {
                        direction: name === "Embark" ? "in" : "out",
                        srv: event.SRV === true,
                        taxi: event.Taxi === true,
                        onStation: event.OnStation === true
                    }
                });
                break;
            case "DockFighter":
            case "DockSRV":
                this.trigger("touchdown", 1_800, name, { priority: 500 });
                break;
            case "Touchdown":
                if (event.OnPlanet !== false) setCurrentBody(this.world, event, { active: true });
                if (event.PlayerControlled !== false) this.trigger("touchdown", 2_600, name, { priority: 550 });
                break;
            case "Interdicted":
                this.trigger("interdiction", 6_000, name, { key: "interdiction-active", priority: 860, exclusiveGroup: "critical-primary", retrigger: "extend" });
                break;
            case "EscapeInterdiction":
                this.world.thargoidEncounter = false;
                this.engine.clearTransientLayers?.({ key: "interdiction-active" });
                this.trigger("escape", 580, name, eventAccent());
                break;
            case "Interdiction":
                this.engine.clearTransientLayers?.({ key: "interdiction-active" });
                this.trigger(
                    event.Success === true ? "interdiction_success" : "interdiction_failed",
                    event.Success === true ? 610 : 980,
                    `${name}: ${event.Success === true ? "success" : "failed"}`,
                    eventAccent()
                );
                break;
            case "UnderAttack":
                if (mainShipEvent(event, this.world.status)) this.trigger("under_attack", 6_000, name, { key: "under-attack", priority: 870, exclusiveGroup: "critical-primary", retrigger: "extend" });
                break;
            case "ShieldState":
                if (!this.world.status.docked && mainShipEvent(event, this.world.status)) {
                    const shieldsUp = event.ShieldsUp !== false;
                    this.trigger(shieldsUp ? "shields_restored" : "shield_impact", shieldsUp ? 560 : 1_200, name, shieldsUp
                        ? eventAccent({ key: "shields-restored" })
                        : { key: "shield-collapse", priority: 750, retrigger: "extend" });
                }
                break;
            case "HullDamage":
                if (mainShipEvent(event, this.world.status)) {
                    const fighterDamage = event.Fighter === true || this.world.status.inFighter;
                    const srvDamage = !fighterDamage && (normalizedText(event.Target) === "srv" || this.world.status.inSrv);
                    const previousHealth = fighterDamage
                        ? this.world.fighterHullHealth
                        : srvDamage
                            ? this.world.srvHullHealth
                            : this.world.hullHealth;
                    const health = finiteNumber(event.Health, previousHealth);
                    if (fighterDamage) this.world.fighterHullHealth = health;
                    else if (srvDamage) this.world.srvHullHealth = health;
                    else this.world.hullHealth = health;
                    const asset = fighterDamage ? "Fighter" : srvDamage ? "SRV" : "Ship";
                    const percent = Number.isFinite(health) ? ` ${Math.round(health * 100)}%` : "";
                    this.trigger("hull_impact", 2_500, `${asset} hull damage${percent}`, { priority: health <= 0.2 ? 930 : 790 });
                }
                break;
            case "Loadout":
                this.world.hullHealth = finiteNumber(event.HullHealth, this.world.hullHealth);
                break;
            case "RepairAll":
                this.world.hullHealth = 1;
                this.trigger("service", 2_200, name, { priority: 480 });
                break;
            case "Repair":
                if (Array.isArray(event.Items) && event.Items.some((item) => normalizedText(item) === "hull")) {
                    this.world.hullHealth = 1;
                }
                this.trigger("service", 2_200, name, { priority: 480 });
                break;
            case "RepairDrone": {
                const repairedPercent = finiteNumber(event.HullRepaired, 0);
                if (Number.isFinite(this.world.hullHealth) && repairedPercent > 0) {
                    this.world.hullHealth = Math.min(1, this.world.hullHealth + repairedPercent / 100);
                }
                this.trigger("service", 2_200, name, { priority: 480 });
                break;
            }
            case "HeatWarning":
                this.trigger("overheat", 8_000, name, { key: "heat-warning", priority: 820, retrigger: "extend" });
                break;
            case "HeatDamage":
                this.trigger("heat_damage", 8_000, name, { key: "heat-damage", priority: 900, retrigger: "restart" });
                break;
            case "CockpitBreached":
                this.trigger("cockpit_breach", 10_000, name, { key: "cockpit-breach", priority: 940, retrigger: "extend" });
                break;
            case "JetConeBoost":
                this.trigger("jet_cone", 4_000, name, { priority: 650 });
                break;
            case "JetConeDamage":
                this.trigger("heat_damage", 4_000, name, { priority: 890 });
                break;
            case "FSSDiscoveryScan":
            case "DiscoveryScan":
                this.trigger("scan", 2_400, name, { priority: 520 });
                break;
            case "FSSSignalDiscovered":
                if (this.allowCue("fss-signal", 1_200)) this.trigger("scan", 1_200, name, { priority: 470, context: { threatLevel: event.ThreatLevel } });
                break;
            case "FSSAllBodiesFound":
            case "NavBeaconScan":
            case "DatalinkScan":
            case "DataScanned":
            case "CodexEntry":
                this.trigger("scan_complete", 540, name, eventAccent());
                break;
            case "FSSBodySignals": {
                const bodyAccent = bodyScanAccent(this.world, event);
                if (bodyAccent && this.allowCue(bodyAccent.key, 1_500)) {
                    this.trigger("body_scan_complete", 540, `${name}: ${bodyAccent.planetClass}`, eventAccent({
                        key: bodyAccent.key,
                        context: { planetClass: bodyAccent.planetClass }
                    }));
                } else if (!bodyAccent) {
                    this.trigger("scan_complete", 540, name, eventAccent());
                }
                break;
            }
            case "SAAScanComplete":
            case "SAASignalsFound":
                if (this.allowCue("dss-scan-complete", 1_500)) {
                    this.trigger("dss_scan_complete", 320, "DSS scan complete", eventAccent({ key: "dss-scan-complete" }));
                }
                break;
            case "Scan": {
                rememberPlanetClass(this.world, event);
                const bodyAccent = bodyScanAccent(this.world, event);
                if (bodyAccent && this.allowCue(bodyAccent.key, 1_500)) {
                    this.trigger("body_scan_complete", 540, `${name}: ${bodyAccent.planetClass}`, eventAccent({
                        key: bodyAccent.key,
                        context: { planetClass: bodyAccent.planetClass }
                    }));
                } else if (!bodyAccent) {
                    this.trigger("scan_complete", 540, name, eventAccent());
                }
                break;
            }
            case "ShipTargeted":
                if (event.TargetLocked === false) {
                    this.world.targetScan = null;
                    break;
                }
                if (event.TargetLocked !== true) break;
                {
                    const scanStage = Math.max(0, Math.trunc(finiteNumber(event.ScanStage, 0)));
                    const ship = String(event.Ship ?? "");
                    const previousTarget = this.world.targetScan;
                    const newLock = !previousTarget || previousTarget.ship !== ship || scanStage < previousTarget.scanStage;
                    const advanced = previousTarget && scanStage > previousTarget.scanStage;
                    this.world.targetScan = { ship, scanStage, locked: true };
                    if (newLock || advanced) {
                        this.trigger(scanStage >= 3 ? "scan_complete" : "scan", scanStage >= 3 ? 540 : 800, `${name}: stage ${scanStage}`, scanStage >= 3
                            ? eventAccent({ context: { scanStage, legalStatus: event.LegalStatus } })
                            : { priority: 470, context: { scanStage, legalStatus: event.LegalStatus } });
                    }
                }
                break;
            case "Scanned":
                if (this.allowCue("being-scanned", 3_000)) this.trigger("scan", 1_600, `${name}: ${event.ScanType ?? "Unknown"}`, { priority: 500 });
                break;
            case "ScanOrganic":
                {
                    const completed = normalizedText(event.ScanType) === "analyse";
                    this.trigger(
                        "organic_scan",
                        completed ? 1_590 : 880,
                        completed ? "Bio sample collected: species complete" : "Bio sample collected",
                        {
                            ...eventAccent(),
                            context: {
                                species: event.Species,
                                variant: event.Variant,
                                scanType: event.ScanType,
                                completed
                            }
                        }
                    );
                }
                break;
            case "ProspectedAsteroid":
                this.setActivity("mining", 30_000);
                this.trigger("mining", 2_300, name, { priority: 540, context: { motherlode: event.MotherlodeMaterial } });
                break;
            case "FuelScoop":
                this.trigger("fuel_scoop_complete", 800, name, eventAccent({
                    context: { scoopAmount: event.ScoopAmount, total: event.Total }
                }));
                break;
            case "LaunchDrone":
                if (normalizedText(event.Type).includes("prospector")) {
                    this.setActivity("mining", 25_000);
                    this.trigger("scan", 1_600, "Prospector launched", { priority: 480 });
                }
                break;
            case "MiningRefined":
                this.setActivity("mining", 25_000);
                this.trigger("mining", 1_800, name, { priority: 540 });
                break;
            case "AsteroidCracked":
                this.setActivity("mining", 30_000);
                this.trigger("asteroid_cracked", 890, name, eventAccent());
                break;
            case "CommitCrime":
                this.trigger("crime", 880, name, eventAccent());
                break;
            case "MissionFailed":
            case "MissionAbandoned":
                this.trigger("mission_failed", 1_080, name, eventAccent());
                break;
            case "MissionAccepted":
                this.trigger("mission_accepted", 640, name, eventAccent({ key: "mission-accepted" }));
                break;
            case "CollectCargo":
            case "EjectCargo": {
                const direction = name === "EjectCargo" ? "out" : "in";
                this.trigger("cargo_transfer", 1_300, `${name}: ${direction === "in" ? "loaded" : "ejected"}`, {
                    key: "cargo-transfer",
                    priority: 440,
                    retrigger: "restart",
                    context: { direction, type: event.Type, commodity: event.Type_Localised }
                });
                break;
            }
            case "ColonisationConstructionDepot": {
                const marketId = String(event.MarketID ?? "unknown");
                const provided = Array.isArray(event.ResourcesRequired)
                    ? event.ResourcesRequired.reduce((total, resource) =>
                        total + Math.max(0, finiteNumber(resource?.ProvidedAmount, 0)), 0)
                    : 0;
                const complete = event.ConstructionComplete === true;
                const previous = this.world.colonisationDepots.get(marketId);
                this.world.colonisationDepots.set(marketId, { provided, complete });
                if (this.world.colonisationDepots.size > 16) {
                    this.world.colonisationDepots.delete(this.world.colonisationDepots.keys().next().value);
                }
                if (previous && provided !== previous.provided) {
                    const delta = provided - previous.provided;
                    this.trigger("cargo_transfer", 1_500, `Construction depot: ${Math.abs(delta)} units ${delta > 0 ? "delivered" : "removed"}`, {
                        key: `construction-transfer:${marketId}`,
                        priority: 470,
                        retrigger: "restart",
                        context: { direction: delta > 0 ? "in" : "out", amount: Math.abs(delta) }
                    });
                }
                if (previous && !previous.complete && complete) {
                    this.trigger("reward", 610, "Construction complete", eventAccent({ key: `construction-complete:${marketId}` }));
                }
                break;
            }
            case "SearchAndRescue":
                this.trigger("rescue_complete", 880, name, eventAccent({ key: "search-and-rescue" }));
                break;
            case "Screenshot":
                this.trigger("camera_flash", 150, name, eventAccent({ key: "camera-flash" }));
                break;
            case "SystemsShutdown":
                this.trigger("systems_shutdown", 2_500, name, { priority: 960, exclusiveGroup: "critical-primary" });
                break;
            case "SelfDestruct":
                this.trigger("self_destruct", 10_000, name, { key: "self-destruct", priority: 990, exclusiveGroup: "critical-primary" });
                break;
            case "RebootRepair":
                this.trigger("systems_reboot", 4_500, name, { priority: 850 });
                break;
            case "MaterialCollected":
            case "MaterialDiscovered":
                if (this.allowCue("material", 650)) this.trigger("material_collected", 1_100, name, { priority: 430 });
                break;
            case "ReceiveText": {
                const channel = normalizedText(event.Channel);
                const from = String(event.From ?? "");
                const personal = ["player", "wing", "friend", "crew", "squadron", "local", "starsystem"].includes(channel) && !from.startsWith("$");
                if (personal && this.allowCue("comms", 4_000)) this.trigger("comms_ping", 900, name, { priority: 420 });
                break;
            }
            case "FighterRebuilt":
                this.world.fighterHullHealth = 1;
                this.trigger("fighter_rebuilt", 3_600, name, { priority: 580 });
                break;
            case "Died":
                this.world.shutdownLatched = true;
                this.trigger("destruction", 5_500, name, { priority: 1_000, exclusiveGroup: "critical-primary" });
                this.scheduleStop(5_500, name);
                break;
            case "FighterDestroyed":
                this.world.fighterHullHealth = null;
                if (this.world.status.inFighter) this.trigger("destruction", 4_000, name, { priority: 980 });
                break;
            case "SRVDestroyed":
                this.world.srvHullHealth = null;
                if (this.world.status.inSrv) this.trigger("destruction", 4_000, name, { priority: 980 });
                break;
            default:
                if (SERVICE_EVENTS.has(name)) this.trigger("service", 2_200, name, { priority: 480 });
                else if (KILL_EVENTS.has(name)) this.trigger("kill_confirmed", 850, name, eventAccent());
                else if (REWARD_EVENTS.has(name)) this.trigger("reward", 610, name, eventAccent());
                else if (ENGINEERING_EVENTS.has(name)) this.trigger("engineer_craft", 820, name, eventAccent());
                break;
        }

        if (isDefinitiveThargoidEvent(event)) this.world.thargoidEncounter = true;
        this.reconcile(name);
    }

    previewScene(sceneId, { durationMs = 10_000 } = {}) {
        if (this.previewTimer) this.clearTimeoutFn(this.previewTimer);
        this.engine.clearTransientLayers?.({ source: "manual" });
        const scene = getLightingScene(sceneId);
        this.previewing = true;
        this.engine.setSessionActive(true);
        if (scene.kind === "base") {
            this.engine.setBaseScene(scene.id, { reason: "Tray preview", transitionMs: 350, context: contextForWorld(this.world) });
            this.engine.setPersistentLayers([]);
        } else {
            this.engine.setBaseScene("normal_flight", { reason: "Tray preview", transitionMs: 350 });
            this.engine.setPersistentLayers([]);
            this.engine.triggerOverlay(scene.id, { durationMs, priority: 1_000, reason: "Tray preview", source: "manual" });
        }
        this.previewTimer = this.setTimeoutFn(() => {
            this.previewTimer = null;
            this.previewing = false;
            if (this.world.sessionActive) this.reconcile("Live game state");
            else this.engine.stopNow("preview_complete");
        }, durationMs);
        this.previewTimer?.unref?.();
    }

    stopPreview(reason = "preview_stopped") {
        if (this.previewTimer) this.clearTimeoutFn(this.previewTimer);
        this.previewTimer = null;
        this.previewing = false;
        this.engine.clearTransientLayers?.({ source: "manual" });
        if (this.world.sessionActive) this.reconcile("Live game state");
        else this.engine.stopNow(reason);
    }

    destroy() {
        if (this.activityTimer) this.clearTimeoutFn(this.activityTimer);
        if (this.stopTimer) this.clearTimeoutFn(this.stopTimer);
        if (this.previewTimer) this.clearTimeoutFn(this.previewTimer);
        this.activityTimer = null;
        this.stopTimer = null;
        this.previewTimer = null;
    }
}
