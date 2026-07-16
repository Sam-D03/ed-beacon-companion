# ED Beacon Companion

ED Beacon Companion turns the Farming Simulator 22 Collector's Edition USB
beacon into a physical flight-deck and danger light for Elite Dangerous.

It is a standalone Windows tray utility that runs quietly in the notification
area and reads Elite Dangerous Player Journal events directly.

## Requirements

- Windows 10 or Windows 11, x64
- Elite Dangerous with its normal Player Journal enabled
- Farming Simulator 22 Collector's Edition USB beacon

The supported beacon identifies as USB vendor `340D`, product `1710`.

## What it does

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
still active when the danger cue ends, rotation resumes.

While the beacon is active, its tray menu shows the journal event that
triggered the current spin or strobe.

Only journal entries written after the companion starts watching are acted on.
Existing journal history is never replayed.

## Install and use

1. Download `ED-Beacon-Companion-Setup-<version>.exe` from GitHub Releases.
2. Run the installer and launch ED Beacon Companion.
3. Find the amber beacon icon in the Windows notification area.
4. Use **Test Spin** and **Test Strobe** to verify the hardware.
5. Enable **Launch at Login** if you want the companion to start with Windows.

The tray menu also provides Enable/Disable, Rescan Beacon, Stop Now, Open Logs,
About, and Quit.

## Privacy and networking

The companion reads Elite Dangerous journal files from the local computer and
writes HID reports to the local USB beacon. It has no runtime network feature,
does not upload journal data, and does not open a listening port.

## Troubleshooting

- **Beacon not found:** connect the beacon directly, close Farming Simulator if
  it is using the device, then choose **Rescan Beacon**.
- **Journal unavailable:** start Elite Dangerous once and check that its journal
  exists under `Saved Games/Frontier Developments/Elite Dangerous`.
- **Beacon stuck on:** choose **Stop Now** or quit the companion. Unplugging the
  beacon also resets it.
- **Logs:** choose **Open Logs** from the tray. Logs rotate locally and are kept
  small.
- **Windows SmartScreen:** initial releases are unsigned, so Windows may show an
  “unrecognised app” warning. Verify that the installer came from this
  repository's Releases page before choosing **Run anyway**.

## Development

```powershell
npm install
npm test
npm run start
npm run dist
npm run verify:package
```

Automated tests use fake HID devices and do not energise a connected beacon.

## Credits

USB protocol details come from
[duckfullstop/blinkybeacon](https://github.com/duckfullstop/blinkybeacon).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
