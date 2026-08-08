# G560 lighting scenes

The Logitech G560 integration treats the four speaker lamps as a tiny room-scale
stage rather than four independent status LEDs.

- Front lamps are the cockpit: controls, targeting, shield state and immediate
  warnings.
- Rear lamps are the environment: stars, planets, station light, engines and
  travel motion.
- A persistent world scene always runs while Elite Dangerous is active.
- Equipment, activity, warning and critical layers are composited over that
  world scene. Clearing a warning reveals the still-running ambient animation;
  it does not restart it.

This front/rear split follows Logitech's own
[Elite Dangerous G560 Screen Sampler guide](https://cx-assets.logi.com/CC%20Graphics/G560/SS_PDFs/Elite%20Dangerous_Screen%20Sampler%20Configuration%20Guide.pdf),
then extends it with semantic Journal and Status data.

## Persistent worlds

| Context | Lighting direction |
| --- | --- |
| Main menu | Near-black navy with a very slow Elite-orange cockpit breath |
| Docked / station services | Warm orange-white hangar light with sparse, procedural station-activity flickers |
| Damaged starport | Smoke-dark red, embers and irregular electrical faults |
| Normal space | Sparse procedural starlight tinted by the current star class |
| Primary-star arrival | Maximum star-class colour for 8 seconds, smoothly falling away over the next 82 seconds into sparse in-system twinkles |
| Exploration | Darker, slower star field with discovery glints |
| Supercruise | Flowing cobalt and cyan energy across the room |
| Supercruise assist | Calmer, symmetrical supercruise motion |
| Supercruise overcharge | Fast white/cyan/gold surges with seeded turbulence |
| Witchspace | Procedural indigo/cobalt plasma with non-repeating white filaments |
| Planetary flight / glide | Dust or ice horizon colour under fast descent rails |
| Landed | Low rust/dust horizon and restrained pad lighting |
| SRV | Rough terrain shimmer, amber instruments and scanner motion |
| Fighter | Tighter cyan engine pulses and sharper targeting accents |
| Taxi | Muted blue and warm cabin light |
| On foot, station | Steel-blue architecture, warm white and teal signage |
| On foot, surface | Temperature-sensitive terrain colour and suit breathing |
| Galaxy / system map | Indigo star field or slow teal orbital motion |
| FSS / SAA / Codex | Scanner sweeps, mapping rings and violet archive light |
| Mining | Dark asteroid field with violet rock light and gold laser sparks |
| Combat | Deep red/blue tension with irregular cross-room exchanges |
| Guardian site | Royal blue glyph rhythm, cyan energy and white sparks |
| Thargoid encounter | Near-black toxic green fog and cold-white probes |
| CQC | Saturated magenta/cyan arena motion |
| Capital ship | Slow monumental violet-white power sweeps |

## Sustained layers from `Status.json`

The current Status snapshot is authoritative for conditions that remain true:

- FSD charge, cooldown, hyperspace, glide, supercruise and overcharge
- docking state, landing gear, mass lock and fuel scoop
- cargo scoop, night vision and flight assist
- SRV handbrake, turret view, drive assist and high beam
- wing, telepresence multicrew and physical multicrew links
- power pips, selected weapon/fire group, fuel, cargo, heading and gravity as
  scene context
- left/right/comms/role cockpit-panel focus as a subtle zoned overlay
- danger, interdiction, shield state, silent running, overheating and low fuel
- wanted/hostile state
- on-foot low oxygen, low health, hot, very hot, cold and very cold states
- main ship, fighter, SRV, taxi and on-foot context
- Galaxy Map, System Map, Orrery, FSS, SAA and Codex focus

The initial Status snapshot hydrates state without replaying warning flashes.
An old snapshot cannot light the speakers merely because the companion started
with Windows.

## Journal choreography

Journal events provide transitions and accents that Status cannot express on
its own:

- launch, touchdown, settlement approach, docking request/denial and docking
  completion; granted clearance holds the station's red-left/green-right lane
  lights while both rear lamps fire a synchronized orange double strobe
- commander-controlled fighter launch spins the physical beacon for five
  seconds while an amber/orange hangar beacon rotates clockwise around all four
  speaker zones; NPC fighter launches remain silent
- FSD charging translates the MDCU's 840 ms teal meter into a synchronized
  blue brightness build across all four speaker zones; `StartJump` then copies
  its exact five-second red countdown before revealing witchspace or
  supercruise
- airlock sweeps for embark/disembark and a turbulent Frontline dropship
  insertion sequence
- supercruise entry/drop, FSD arrival, neutron boost and carrier jump
- threat-scaled signal-source drops and both sides of an interdiction outcome
- shield collapse/recovery, shield and hull impact,
  heat damage, cockpit breach, reboot and destruction
- FSS honk, signal/body completion, surface mapping, Codex and exobiology
- prospector activity, refining and asteroid-core detonation
- mission outcomes, combat bonds/bounties, exploration sales and promotions
- cargo loading/ejection, contract acceptance, search-and-rescue delivery,
  voucher and organic-data payouts, and a brief physical camera flash
- engineering, synthesis, refuel/repair/rearm and material collection
- fuel-scoop completion, fighter rebuild and self-destruct countdown
- crime, scan-stage edges and rate-limited incoming communication

### Discrete event accents

Single-action outcomes use a deliberately different visual language from
ambient and sustained scenes. They cut instantly to one solid colour across all
four lamps, insert fully black cuts between beats, and replace every lower
lighting layer for their brief duration. They never fade, dissolve, use zoned
gradients, or reveal the scene beneath them.

This hard-accent treatment is used for bio samples and species completion, kill
confirmation, completed scans, rewards, mission acceptance/failure, successful
rescue, engineering completion, asteroid cracking, fuel-scoop completion,
shield restoration, interdiction outcomes, docking denial, crimes and camera
capture. Terminal scenes such as destruction and self-destruct retain higher
priority and remain authoritative.

DSS mapping completion is intentionally quieter than the general scan fanfare:
the paired `SAAScanComplete`/`SAASignalsFound` journal events are deduplicated
into one 320 ms, low-output ice-blue acknowledgement with no orange or gold.

FSS planetary scan completion uses the fixed dominant colour for the scanned
`PlanetClass`. The `Scan` and matching `FSSBodySignals` records are deduplicated
by body identity, while star, ship, nav-beacon, Codex and data scans retain the
generic scan-complete palette.

`Undocked` is always a finite launch cue. It is never a persistent scene, which
also prevents settlement departures from leaving a light active indefinitely.
Events for a remote fighter, dismissed ship or NPC-controlled asset are filtered
so they do not take over the room.

## Layer order

From lowest to highest:

1. World ambience
2. Instrumentation and equipment
3. Activity and travel
4. Context warnings
5. Immediate danger
6. Critical survival and destruction

Most warnings own the front lamps strongly while only tinting the environmental
rear wash. Critical cues may take all four zones. Transitions use attack and
release envelopes, and ordinary world changes crossfade smoothly.

## Procedural motion

Witchspace, supercruise, exploration stars, surface dust, combat sparks,
asteroid debris and alien fog are generated from deterministic time-indexed
noise. Each activation receives a new seed, while any particular timestamp is
stable even if the renderer drops frames. This avoids both obvious short loops
and animation changes caused by computer performance.

The docked ambience has no short repeating breath. All four zones hold a slowly
changing orange-to-warm-white room wash; long randomized quiet intervals are
punctuated by one-to-four localized white, orange, yellow or occasional blue
flickers, with independently varied timing, brightness and movement.

Warnings use deliberate coded rhythms because they need to stay readable.
Reduced Flashing applies an output slew to remove abrupt full-room changes while
preserving colour and scene priority.

## Colour direction

The core palette comes from the orange/cyan Elite cockpit language and the
colours visible in Frontier's published game imagery. Guardian, Thargoid,
surface, damaged-station and supercruise-overcharge palettes are artistic
interpretations rather than colours specified by Frontier.

After an `FSDJump`, the primary star's class colour fills all four zones at
maximum scene intensity. Journal and Status telemetry do not provide live
distance from the primary, so elapsed time after arrival is used as a stable
proximity proxy. White dwarfs mix ice white with irregular electric-blue
flicker instead of using a single static colour.

- Elite amber `#ff7100`
- Energy cyan `#20d8ff`
- Alert red `#ff160d`
- Thermal orange `#ff3d08`
- Guardian blue `#187cff`
- Thargoid green `#b8ff20`
- Violet `#8f43ff`
- Near-black navy `#010519`

The event and Status contracts are based on Frontier's
[Player Journal manual](https://hosting.zaonce.net/community/journal/v37/Journal_Manual_v37.pdf).
