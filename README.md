# Toshiba Estia — Homey App

**[➜ Install Toshiba Estia from the Homey App Store](https://homey.app/a/com.goossens.toshibaestia)**

That's the easiest way to get the app, and it keeps itself up to date. Installing from this repository is only needed for development.

Homey Pro integration for **Toshiba Estia** air-to-water heat pumps (R410A 4/5 Series WM, R32 1/2 Series WM/AIO), over **Modbus TCP**.

Works with the Toshiba **BMS-IFMB0UEW-E** Modbus RTU interface (or any compatible interface that exposes the Estia register map) wired to any Modbus TCP gateway. Tested with the **Waveshare RS485-to-WiFi/ETH** converter in "Modbus TCP ↔ Modbus RTU" mode.

## Features

### Read

- Zone 1 room temperature (paired with the Zone 1 thermostat tile)
- Zone 2 room temperature *(toggleable in device settings — turn off for single-zone installs)*
- Outdoor temperature
- Water inlet (TWI) and outlet (TWO) temperatures
- DHW tank (TTW), heater outlet (THO), and DHW setpoint
- Live status: heat pump on/off, mode, all energy-saving toggles
- Alarm flag + decoded fault code (e.g. `F10 [Hydro unit 0]`)

### Write

- Heat pump on/off + mode (heat / cool / off)
- Zone 1 setpoint, with min/max bounded by the unit's own limits
- Zone 2 setpoint *(when enabled in device settings)*, with the unit's per-zone limits
- Domestic hot water on/off + setpoint
- Energy-saving toggles: frost protection, night setback, auto temperature (weather compensation)
- Anti-bacteria cycle (DHW)
- DHW boost (manual)

### Flow cards

- **Trigger**: "Heat pump faulted" — fires on alarm rising edge, tokens carry fault code, origin, human description.
- **Condition**: "Heat pump alarm is (not) active".
- **Action**: "Boost DHW for [N] minutes" — turns boost on now, off after N minutes, with a safety timer that survives flow completion.

## Localization

13 languages: English, Dutch, Danish, German, Spanish, French, Italian, Norwegian, Swedish, Polish, Russian, Korean, Arabic.

> **Note about Dutch labels**: Homey's core hardcodes the Dutch title "Ingestelde temperatuur" / "Setpoint" for `target_temperature` and its sub-capabilities. Both the Zone 1 and DHW thermostat tiles therefore share this title. Distinguish them by the **current temperature value** displayed on each dial: Zone 1 shows your room/flow temperature (low 20s °C), the DHW tile shows the tank temperature (40–60 °C). This is a known Homey SDK limitation — see `AGENTS.md` for full background.

---

## Install

```bash
npm install
homey app build            # compose + tsc + validate
homey app install          # or: homey app run   (live logs)
```

When pairing, enter your gateway's IP, port (502 for the Waveshare default) and Modbus unit ID (1 by default on the Toshiba interface), then click **Test connection**. The app reads identity registers to confirm before offering the device. A second screen asks whether DHW and Zone 2 are present — these toggle the corresponding capabilities, flow cards and polling.

## All connection details are editable after pairing

Open the device in the Homey app → Settings:

- **Connection**: gateway IP, TCP port, Modbus unit ID.
- **Polling**: interval (seconds) and request timeout (ms).
- **Hydro unit**: temperature scaling (°C×1 / ×10), Zone 2 installed, DHW installed.
- **Detected (read-only)**: hydro unit series, slave address on the interface, baud rate, last successful poll timestamp — so you can verify what the unit is actually reporting.

Changing any of these reconfigures the Modbus client live. No re-pair needed.

---

## Troubleshooting — intermittent Modbus errors

Symptoms: device occasionally goes "Apparaat onbeschikbaar" / "Device unavailable" with the message `Modbus poll failed: <error>`.

### Step 1 — Read the actual error

Once the `{{reason}}` interpolation bug is fixed (current build), the unavailable message includes the underlying error string. Common ones and what they mean:

| Error in the message | Meaning |
|---|---|
| `connect ETIMEDOUT 192.168.1.30:502` | Waveshare didn't respond to the TCP handshake. Network or gateway power issue. |
| `connect ECONNREFUSED` | Waveshare is up but Modbus TCP server is off. Re-check Waveshare web UI → Mode Selection. |
| `Timed out` (no host info) | TCP connection is fine but no Modbus reply. RS-485 side issue (baud mismatch, slave off, address wrong). |
| `Modbus exception 0x02 (Illegal data address)` | Wrong register address. Won't happen unless you're hacking on the register map. |
| `Modbus exception 0x0B (Gateway target failed to respond)` | Waveshare's RS-485 target didn't reply. Power-cycle the Toshiba interface. |
| `Port Not Open` / `socket hang up` | Modbus client lost the socket; will auto-reconnect on next poll. Usually self-healing. |

### Step 2 — Verify the chain end-to-end with the smoke test

The `modbus-test/test-read.ts` script bypasses Homey entirely. Run it from any machine that can reach the gateway:

```bash
cd /path/to/ToshibaEstia
npx ts-node modbus-test/test-read.ts 192.168.1.30 502 1
```

Expected healthy output includes:
- `40050 deviceDefinition raw=0x2C00` — Toshiba magic number, confirms Modbus chain works
- `40052 hydroUnitType raw=0x0101` — R32 1 Series detected
- `40041 baudRateCode raw=0x0003 (19200 bps)` — RS-485 baud
- `40042 slaveAddress raw=0x0001` — interface address

If the script ALSO times out or returns garbage, the issue is hardware/network — not the Homey app.

### Step 3 — Triangulate

Run these in order; each step rules out the layer above it.

1. **Ping the gateway**: `ping 192.168.1.30`. If packets drop, it's a WiFi/network issue. Check signal strength at the gateway location, consider moving it to Ethernet.
2. **Open the Waveshare web UI** at `http://192.168.1.30` (admin/admin). If it's slow or unreachable, the gateway is overloaded or has lost WiFi. Power-cycle it.
3. **Run the smoke test** (Step 2 above). Compare its result with the Homey app's behaviour.
4. **Power-cycle the BMS-IFMB0UEW-E** (turn off the indoor unit at the breaker for 30 s). Sometimes the interface gets into a bad state, especially after baud-rate changes.
5. **Verify DIP switches** match the manual section in this README — particularly the baud rate (S3 bits 7-8) MUST match the Waveshare UART setting.

### Step 4 — Get the Homey app log

The most useful direct view:

```bash
homey app run                 # streams live logs to your terminal
                              # (Ctrl+C uninstalls — only use for debugging)
```

For a non-intrusive snapshot:

```bash
homey app manage              # opens the Developer Tools in your browser
                              # → Logs tab shows the live console output
```

Or via the API:

```bash
homey api apps restart-app --id com.goossens.toshibaestia    # gentle restart
```

If you'd like *more* logging from this app, enable the **debug toggle** in app settings (Homey → Settings → Apps → Toshiba Estia → Configure app). Caveat: it's chatty — turn it off after the diagnosis.

### Step 5 — Tune the polling

If errors are correlated with high frequency, in device settings increase:
- **Poll interval** to 60 s (default 30 s)
- **Request timeout** to 4000 ms (default 2000 ms)

The Waveshare's own "Modbus Polling" cache (set on its web UI) helps, but only if its 200 ms internal interval is short enough to deliver fresh data on demand.

### Common root causes seen during dev

- **WiFi signal at the gateway**: the Waveshare antenna is small. If the unit is in a basement / utility cupboard, a WiFi-extender or wired Ethernet drops the error rate to near zero.
- **DIP switch / baud mismatch**: changing the Toshiba S3 bits without changing the Waveshare UART baud (or vice-versa) creates silent timeouts. Verify both sides match before debugging anywhere else.
- **Multiple Modbus clients on the same gateway**: if you have *another* TCP client polling the Waveshare (a Home Assistant integration, an MQTT bridge, etc.) at the same time, frame collisions are real. Pick one master.
- **Toshiba interface in re-init**: register `40013` returns `-4` ("initialization") for a few seconds after power-on. The app handles this gracefully (treats it as "no fault"), but other Modbus clients may not.

---

## Hardware configuration — this install

Only the **non-default / install-specific** settings. Anything not listed is left at factory default.

### Network topology

```
Toshiba hydro unit  ──(AB bus, 2-wire)──  BMS-IFMB0UEW-E  ──(RS-485 A/B)──  Waveshare RS485-to-WiFi/ETH  ──(Ethernet or WiFi)──  LAN
    R32 1 Series                               Modbus RTU interface                 Modbus TCP gateway                              ↓
                                                                                                                               Homey Pro (192.168.1.20)
```

| Device | Address |
|---|---|
| Homey Pro | `192.168.1.20` |
| Waveshare gateway | `192.168.1.30` (Modbus TCP port `502`) |

### Waveshare RS485-to-WiFi/ETH (at 192.168.1.30)

Set via the built-in web UI at http://192.168.1.30 (admin / admin).

| Section | Setting | Value | Why |
|---|---|---|---|
| Mode Selection | Wi-Fi mode | **STA** (Station) | Connects to the house Wi-Fi / LAN. |
| Mode Selection | Data Transfer Mode | **Modbus TCP ↔ Modbus RTU** | **Critical.** Without this, the gateway won't translate TCP frames to RTU on the RS-485 side. |
| STA Interface Setting | WAN Connection Type | Static IP or DHCP reservation | Fix the IP so the Homey app keeps finding it. |
| Ethernet Setting | Ethernet work mode | LAN port | Allows mixing Ethernet + Wi-Fi; use Ethernet if the signal is weak where the gateway is mounted. |
| Application Setting → UART | **Baudrate** | **19200** | **Must match the Toshiba's S3 DIP setting (see below).** |
| Application Setting → UART | Data bits / Parity / Stop | 8 / None / 1 | Compatible with Toshiba's 8N2 (the interface is 8N1-compatible). |
| Application Setting → UART | Baudrate adaptive (RFC2217) | Enabled (default) | Harmless; keep it on. |
| Application Setting → Net | Protocol / Mode / Port | TCP / Server / **502** | Standard Modbus TCP. |
| Application Setting → Net | Max TCP clients | 24 (default) | Plenty of headroom. |
| Application Setting → Modbus Polling | Modbus Polling | **On**, 200 ms | Waveshare caches register reads and serves them to TCP faster than round-tripping the RS-485 each time. |
| Application Setting → RS-485 | `trxen_en` / TX-enable | **On** (on RTS) | Required to drive the RS-485 transceiver. |

### Toshiba BMS-IFMB0UEW-E (DIP switches inside the interface)

Power-cycle the interface after changing any DIP switch — settings are read at boot.

The manual table uses `↓` = OFF, `↑` = ON, `x` = don't care.

| Switch | Setting on this install | Meaning |
|---|---|---|
| **S1** — Hydro unit type | Default (`↑ ↑ x x`) | R32 1 Series (WM/AIO). Matches detected register `40052 = 0x0101`. |
| **S3 bits 1-6** — Slave address | `↑ ↓ ↓ ↓ ↓ ↓` = **1** | Only one interface on this bus. Confirmed by register `40042 = 1`. |
| **S3 bits 7-8** — Baud rate | **`↑ ↑` = 19200 bps** *(NON-DEFAULT — factory is 9600)* | Confirmed by register `40041 = 3`. The Waveshare UART baud must match this exactly. |
| **S4 bit 1** — Temperature scaling | `↓` = °C × 1 | Outdoor register reads as `0x0011 = 17` meaning 17 °C (not 1.7 °C). Matches the app's "x1" device setting. |
| **S4 bit 2** — °C / °F | `↓` = °C | |
| **S4 bit 3** — reserved | `x` | Don't touch. |
| **S4 bit 4** — 120 Ω termination | Check physically | Enable (ON) only if this interface sits at one **end** of the RS-485 bus. Pure electrical — no software consequence. |

### Toshiba ↔ Waveshare sync invariants

Keep these three pairs in sync — changing one side without the other silently breaks communication:

| Toshiba side | Waveshare side |
|---|---|
| S3 bits 7-8 (baud code, register `40041`) | Application Setting → UART → Baudrate |
| S3 bits 1-6 (slave address, register `40042`) | → **device settings** in this Homey app (`Modbus unit ID`) |
| S4 bit 1 (°C × 1 / × 10) | → **device settings** in this Homey app (`Temperature scaling`) |

### Quick verification

Run the standalone smoke test after any hardware change:

```bash
npx ts-node modbus-test/test-read.ts 192.168.1.30 502 1
```

A healthy response includes:

- `deviceDefinition = 0x2C00` (Toshiba magic number)
- `hydroUnitType = 0x0101` → R32 1 Series
- `baudRateCode = 3` → 19200 bps
- `slaveAddress = 1`

If all four match, the RS-485 chain is correctly wired and configured.

---

## Contributing / development

See [`AGENTS.md`](AGENTS.md) for the full developer guide — architecture, capability strategy, the painful list of UI gotchas (including the title-override saga), and Phase 3 roadmap.
