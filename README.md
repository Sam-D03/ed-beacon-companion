# ED Beacon Companion

ED Beacon Companion turns desk hardware into an immersive Elite Dangerous
lighting rig. It can drive:

- the Farming Simulator 22 Collector's Edition USB beacon; and
- all four front/rear lighting zones of Logitech G560 speakers through G HUB.

It is a standalone Windows tray utility. There is no main window, no account,
no network service, and no journal history replay.

## Requirements

- Windows 10 or Windows 11, x64
- Elite Dangerous with its normal Player Journal enabled
- Any supported light:
  - Farming Simulator 22 Collector's Edition beacon (`VID 340D`, `PID 1710`)
  - Logitech G560 speakers (`VID 046D`, `PID 0A78`) with current Logitech G HUB

The two devices are independent; either one can be used on its own.

## G560 experience

The speakers maintain a theatrical scene throughout a live game session. A
world scene describes the current location and mode, while equipment, activity,
warning and critical layers animate over it. When an alert clears, the ambient
scene underneath has kept moving and returns smoothly.

Examples include:

- procedural, differently seeded witchspace and supercruise energy;
- maximum-bright primary-star arrival colour that recedes into procedural
  in-system twinkles, including ice-white/electric-blue white dwarfs;
- station, damaged-station, surface, SRV, fighter, taxi and on-foot ambience;
- Galaxy Map, System Map, FSS, SAA and Codex looks;
- mining, combat, Guardian, Thargoid, CQC and capital-ship scenes;
- layered docking, FSD, fuel-scoop, heat, interdiction, shield, hull, oxygen,
  health, legal-state and equipment cues; and
- short choreography for scans, exobiology, asteroid cracking, rewards,
  engineering, signal drops, airlocks, Frontline insertion, launch, touchdown,
  arrival and destruction.

FSD charging synchronizes the beacon and all four G560 zones. The speakers
build in blue, copy the MDCU's five-second red jump countdown, then reveal the
witchspace or supercruise scene while the beacon stops at transition.

Scene changes crossfade. Procedural scenes use time-indexed seeded noise, so
they do not become a short hard-coded loop and remain smooth if a frame is
skipped. **Reduced Flashing** softens abrupt full-room changes.

See [G560 lighting scenes](docs/LIGHTING_SCENES.md) for the full design.

## USB beacon behaviour

| Elite event | Beacon behaviour |
| --- | --- |
| Docking granted | Spins until docking completes or clearance ends |
| Undocked | Spins for 5 seconds |
| Interdicted | Strobes for 6 seconds |
| Under attack | Strobes for 6 seconds for the commander or mothership |
| Heat warning or heat damage | Strobes for 8 seconds |
| Cockpit breached | Strobes for 10 seconds |
| Main ship at or below 50% hull | Strobes for 8 seconds |
| Load game, death, or shutdown | Stops and clears all effects |

Danger strobes temporarily take priority over deck rotation. If docking is
still active when the danger cue ends, rotation resumes. `Undocked` is always a
finite cue, including departures from surface settlements.

## Install and use

1. Download `ED-Beacon-Companion-Setup-<version>.exe` from GitHub Releases.
2. Install and launch ED Beacon Companion.
3. Find the amber beacon icon in the Windows notification area.
4. Open the tray menu and choose a hardware test or G560 scene preview.
5. Enable **Launch at Login** if wanted.

The tray shows the current Journal watcher, connected hardware, ambient scene,
active lighting layers and the event responsible for the dominant cue. Choose
**Developer Monitor** for a live, read-only second-screen view of the scene,
layer reasons, four rendered G560 colours, beacon trigger and recent Journal
activity. It opens on a non-primary display when one is available and uses no
network connection.

The tray also provides independent G560 enable/brightness controls, rescan,
Stop Now, restore to G HUB, logs, About and Quit.

Only Journal entries written after the companion begins watching are acted on.
`Status.json` supplies live sustained state; its initial snapshot establishes
context without replaying old warning flashes. A local process check gates that
snapshot and releases lighting when `EliteDangerous64.exe` exits, including
after a game crash with no final Journal event.

## G HUB ownership

The companion acquires LIGHTSYNC only while a live scene is requested. Disable,
Stop Now, Elite shutdown and app exit release the G HUB runtime so G HUB restores
the lighting it had before acquisition.

Logitech's legacy LED SDK allows one active integration at a time and targets
all connected Logitech zonal speakers. Starting another SDK integration may
replace this one. Windows Dynamic Lighting can also prevent G HUB LIGHTSYNC
control; the tray includes a shortcut to its Windows settings page.

The legacy SDK also snapshots and stops active effects on every connected,
supported Logitech lighting device when an integration starts, even when the
companion only writes G560 speaker zones. G HUB effects on a Logitech keyboard,
mouse, mouse mat or headset may therefore pause while a G560 scene is active.
The SDK restores the saved lighting when the companion releases control.

## Privacy and networking

Runtime operation is local and offline. The companion reads Elite Dangerous
Journal and Status files, talks to the signed lighting runtime installed by G
HUB and writes to the local USB beacon. It uploads nothing and opens no
listening port.

## Troubleshooting

- **G560 not found:** connect the speakers by USB, start G HUB, choose **Rescan
  G560**, then try a scene preview.
- **G560 detected but unavailable:** check that the app integration is enabled
  in G HUB. If Windows Dynamic Lighting owns the speakers, use the tray shortcut
  and disable it for G HUB LIGHTSYNC control.
- **Lighting owned by another game:** stop that game's G HUB integration, then
  choose **Rescan G560**. G HUB's SDK supports one integration at a time.
- **Beacon not found:** connect it directly, close Farming Simulator if it is
  using the device, then choose **Rescan Beacon**.
- **Journal unavailable:** start Elite Dangerous once and check
  `Saved Games/Frontier Developments/Elite Dangerous`.
- **Hardware remains active:** choose **Stop Now**, **Restore G HUB Lighting**,
  or quit the companion.
- **Logs:** choose **Open Logs**. Logs rotate locally and remain small.
- **Windows SmartScreen:** initial installers are unsigned. Verify that the
  installer came from this repository's Releases page before choosing **Run
  anyway**.

## Development

Development requires Node.js 22.12 or newer and npm.

Building the G560 bridge requires Visual Studio 2022 Build Tools with Desktop
development with C++. The bridge uses Windows runtime loading and does not
download, compile against or redistribute Logitech SDK headers or libraries.
At runtime it accepts only the expected G HUB DLL with a valid Logitech
Authenticode signer before resolving the required lighting functions.

```powershell
npm install
npm test
npm run build:g560
npm run start
npm run dist
npm run verify:package
npm run smoke:package
```

Automated tests use fake devices and do not energise connected hardware.

## Credits

USB beacon protocol details come from
[duckfullstop/blinkybeacon](https://github.com/duckfullstop/blinkybeacon).
G560 control uses the interface documented by Logitech's official
[LED Illumination SDK](https://futureisnow.logitechg.com/en-gb/programs/partner-developer-lab)
through an isolated native bridge and the signed runtime installed by G HUB.
No Logitech binary is included in this project or its installer. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
