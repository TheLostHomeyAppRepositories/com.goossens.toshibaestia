# AGENTS.md — Toshiba Estia Homey App

Knowledge base for AI agents (and humans) working on this repo. Captures everything painfully learned. Read all of it before making non-trivial changes.

---

## 1. What this app does

Bridges a **Toshiba Estia** air-to-water heat pump (R410A 4/5 Series WM, R32 1/2 Series WM/AIO) to **Homey Pro** over **Modbus TCP**. Physical chain:

```
Toshiba hydro unit
   │  (AB bus, 2-wire — Toshiba's internal RC bus)
BMS-IFMB0UEW-E  ← Toshiba's official Modbus RTU interface (RS-485)
   │  (RS-485 A/B)
Waveshare RS485-to-WiFi/ETH ← any Modbus TCP gateway works
   │  (WiFi or Ethernet)
Homey Pro
```

The Waveshare runs in **Modbus TCP ↔ Modbus RTU** mode on port 502. Register numbers and semantics come from the BMS-IFMB0UEW-E manual (EEU-006, 31/05/2021). The full register map and decoders live in [`modbus/registers.ts`](modbus/registers.ts).

---

## 2. SDK & language

- **Homey Apps SDK v3**, TypeScript (Athom's first-class path).
- **Node 16+** target (`@tsconfig/node16`); `.homeybuild/` is the compile output (gitignored).
- **CommonJS only**. `module.exports = ClassName` at the bottom of every Driver/Device/App. Don't switch to ESM — the SDK loader expects CJS.
- **ESLint**: `eslint-config-athom` + `eslint-plugin-homey-app`. Pinned to ESLint 7 because the plugin requires it.
- **No Homey Cloud support intended** — `app.json` declares `"platforms": ["local"]`. Some patterns we use (file-based settings, long-lived TCP sockets) wouldn't survive Cloud's process model.

---

## 3. Repo layout

```
.homeycompose/                ← source of truth; CLI generates app.json
  app.json                    ← top-level metadata (id, version, name, etc.)
  capabilities/               ← custom capabilities + 1 shadow (target_temperature.json)
  flow/triggers/              ← fault_triggered.json, season_changed.json
  flow/conditions/            ← alarm_is_active.json, season_is.json
  flow/actions/               ← dhw_boost_for.json, zone1_temperature_set.json, auto_temp_set.json, season_set.json

drivers/heatpump/
  driver.compose.json         ← class=heatpump, capabilities array, capabilitiesOptions, pair[]
  driver.settings.compose.json ← per-device settings schema (IP, port, unit ID, scaling, toggles)
  driver.flow.compose.json    ← (none yet — would be device-scoped flow cards)
  driver.ts                   ← pair-session wiring + flow-card runListeners
  device.ts                   ← capability ↔ register mapping, polling loop, capability writes
  season.ts                   ← season detection (pure functions), see "Season detection" below
  pair/configure.html         ← step 1: IP/port/unit + Test connection
  pair/features.html          ← step 2: DHW / Zone 2 / scaling toggles
  assets/icon.svg             ← driver icon (heat-pump cabinet + fan)
  assets/images/              ← driver tile images

modbus/
  controller.ts               ← shared modbus-serial client, pooled per host:port, request-serialised
  registers.ts                ← REGISTERS map + decoders (alarm code, baud, hydro type)
  types.ts                    ← ModbusEndpoint, ModbusLogger interfaces

settings/index.html           ← app-level settings (debug toggle only)
modbus-test/test-read.ts      ← standalone smoke test, runs OUTSIDE Homey
locales/{en,nl,…}.json        ← runtime strings (this.homey.__())
app.ts                        ← exposes this.homey.app.modbus (singleton)
assets/icon.svg               ← app icon
```

Generated/excluded:
- `app.json` (root) — regenerated from `.homeycompose/` every build. Never edit by hand.
- `.homeybuild/` — TypeScript build output; `homey app run/install` consumes this.
- `node_modules/`

---

## 4. Capability strategy — read this carefully

This is the single most error-prone part of the app. We landed on a hybrid pattern after multiple iterations.

### Three categories of capabilities

**A. Always-on, declared in `drivers/heatpump/driver.compose.json` `capabilities` array.**
Every device has them at pair time. Insights begins logging immediately.
```
onoff, thermostat_mode, target_temperature, measure_temperature,
measure_temperature.outdoor, measure_temperature.water_inlet,
measure_temperature.water_outlet, alarm_generic, fault_code,
frost_protection, night_setback, auto_temp,
onoff.hotwater, target_temperature.tank_water,
measure_temperature.tank_water, measure_temperature.water_heater_outlet,
boost_hotwater, antibacteria
```

**B. Feature-gated, declared dynamically in `device.ts → OPTIONAL_CAPABILITIES`.**
Currently only Zone 2:
```ts
const OPTIONAL_CAPABILITIES = {
  zone2: ['measure_temperature.zone2', 'target_temperature.zone2'] as const,
  dhw:   [/* listed for runtime add-back logic */] as const,
};
```
The `zone2` group is added/removed by `syncOptionalCapabilities()` based on `enableZone2`. Insights for Zone 2 only starts existing the first time the user enables it.

The `dhw` group is in `OPTIONAL_CAPABILITIES` AND in the manifest. This is intentional — see DHW exception below.

**C. Custom capabilities, defined in `.homeycompose/capabilities/*.json`.**
- `fault_code` (read-only string)
- `boost_hotwater`, `frost_protection`, `night_setback`, `auto_temp`, `antibacteria` (writable booleans)
- `target_temperature.json` — see "Shadow capabilities" below

### Why DHW is in BOTH the manifest AND OPTIONAL_CAPABILITIES

Originally Zone 2 + DHW were both purely dynamic (only added if enabled). That broke title overrides for `target_temperature.tank_water` because Homey only honours `capabilitiesOptions` from the manifest at pair-time — runtime `addCapability` doesn't pick them up cleanly.

The DHW caps were moved to the manifest so title overrides apply at pair-time. They remain in `OPTIONAL_CAPABILITIES.dhw` so flipping `enableDhw=false` in settings still removes them via `removeCapability`. Cost: turning DHW off creates a small Insights orphan. Acceptable for the rare "user changes DHW after pairing" case.

### Phase 2 checklist for adding new capabilities

- [ ] Decide: always-on, feature-gated (zone2/dhw), or custom?
- [ ] If always-on → `drivers/heatpump/driver.compose.json` `capabilities` array + `capabilitiesOptions`.
- [ ] If feature-gated for a future feature → add to `OPTIONAL_CAPABILITIES` AND the manifest (mirror DHW pattern).
- [ ] If custom (boolean toggle, string, fancy number) → `.homeycompose/capabilities/<id>.json` with `title`/`desc` in `en` + `nl` minimum.
- [ ] Wire write logic in `device.ts → registerCapabilityListeners()` via `safeRegisterListener(id, fn)`.
- [ ] Add the register number to `ALWAYS_ON_REGISTERS` (or `ZONE2_REGISTERS` / `DHW_REGISTERS`) so polling reads it.
- [ ] Read it back in `applySnapshot()` so the UI mirrors the unit's actual state when changed via the wired remote controller.
- [ ] If the cap appears in Phase-3 flow cards, gate the runListener on `device.hasCapability(id)`.
- [ ] Run `homey app translate` to fan out to 13 languages.

---

## 5. Homey UI gotchas — the painful list

These are the things we learned by trial and error. Skim before changing UI behaviour.

### Title overrides for `target_temperature` and sub-caps are LOCKED in Dutch

Homey's core ships with `target_temperature.title.nl = "Ingestelde temperatuur"` baked into `node-homey-lib`. Neither `capabilitiesOptions[id].title` nor runtime `device.setCapabilityOptions(id, {title})` makes this string change in the Dutch UI. **All three of these were tried — none stuck.** Same applies to all sub-capabilities like `target_temperature.tank_water`, `target_temperature.zone2`. Confirmed against MELCloud's identical override that "ships" but doesn't visibly render distinct titles either.

The only thing that DOES move the needle is **shadowing the base capability** — see next section.

### Shadow capability technique

`.homeycompose/capabilities/target_temperature.json` redefines the base capability for *this app only*. The shadow's `title` field IS rendered by the UI (verified empirically). Caveat: **all sub-capabilities inherit the shadow's title** — there is no per-sub-cap shadow because the validator forbids dots in capability filenames.

Current shadow (`target_temperature.json`) uses generic title "Setpoint" / "Instelpunt" so neither Zone 1 nor DHW tile says "Ingestelde temperatuur" but they share a single neutral label. **Do not** put a Zone-1-specific title here — it bleeds into DHW.

If you ever need genuinely distinct labels per setpoint, the only path is **multiple virtual devices** (one per setpoint, each user-named). See `Future improvements` below.

### Pair-view button click capture-phase listener

Homey's pair iframe attaches its own click handler to elements with `homey-button-*` classes (for the press animation) and calls `event.stopPropagation()` BEFORE the event reaches button-level listeners. Result: `nextBtn.addEventListener('click', …)` never fires.

Fix used in both `configure.html` and `features.html`:
```js
document.addEventListener('click', function(e) {
  if (e.target && e.target.id === 'next') onNextClicked();
}, true /* CAPTURE PHASE — must be true */);
```
Capture phase runs before target phase, so we see the click before Homey's interceptor stops it.

### Pair view → settings page differences

| | Pair views (`drivers/.../pair/*.html`) | Settings page (`settings/index.html`) |
|---|---|---|
| `<script src="/homey.js">` | NOT needed | **Required** in `<head>` |
| `Homey` global available immediately | Yes (auto-injected) | No — wait for `onHomeyReady(Homey)` callback |
| `Homey.emit(event, data)` | callback OR Promise (use the dual-style helper below) | n/a, use `Homey.get/set` |
| Init pattern | IIFE that does work and calls `Homey.ready()` | Define `function onHomeyReady(Homey) { ...; Homey.ready(); }` |

Always wrap `Homey.emit` in this dual-style helper — some Homey versions are callback-only, some Promise-only:
```js
function emit(event, data) {
  return new Promise(function(resolve, reject) {
    var settled = false;
    function done(err, val) {
      if (settled) return; settled = true;
      err ? reject(err) : resolve(val);
    }
    try {
      var ret = Homey.emit(event, data, function(err, result) { done(err, result); });
      if (ret && typeof ret.then === 'function') ret.then(function(r){done(null,r);}, done);
    } catch (e) { done(e); }
  });
}
```

### `setCapabilityOptions` is not symmetric with `capabilitiesOptions`

Runtime `setCapabilityOptions` accepts `title`, `min`, `max`, `step`, `decimals`, `units`, `insightsTitleTrue/False`. It does NOT accept `uiComponent` — that field is only honoured when the capability is created. To change a `uiComponent` on an existing device you must remove the capability and re-add it (Homey re-reads the manifest on add) — or have the user re-pair.

We use a one-shot store-flag migration for this:
```ts
const flag = '_someChangeName_v3';
if (!this.getStoreValue(flag)) {
  for (const cap of [...]) {
    if (this.hasCapability(cap)) await this.removeCapability(cap);
  }
  await this.setStoreValue(flag, true);
}
```
Bump the suffix (`_v3` → `_v4` …) to make it run again when the manifest changes.

### Localization placeholders — don't use `{{name}}`

Homey's `__()` substitution silently fails for handlebars-style placeholders inside `setUnavailable()` (and possibly others — symptoms: literal `{{reason}}` in the UI). Build the string with a template literal:
```ts
const prefix = this.homey.__('error.poll_failed') || 'Modbus poll failed';
await this.setUnavailable(`${prefix}: ${actualError}`);
```
And keep the locale strings placeholder-free.

### Insights orphans

Calling `removeCapability(id)` removes the cap from the device UI but **Insights history persists indefinitely**. There's no SDK call to delete it; users have to delete the time-series manually via the Insights UI or accept it forever.

This is why Zone 2 stays purely dynamic: users without Zone 2 never trigger the addCapability call → no Insights data → no orphan.

### Standard capability classes lock UI rendering

`uiComponent: "thermostat"` on a custom capability does NOT pair with `measure_temperature.X` — the pair logic is hardcoded to the standard `target_temperature.X` ↔ `measure_temperature.X` namespace. Custom caps render as slider/sensor only. That's why "use a custom capability for DHW" loses the thermostat-dial UX.

---

## 6. Modbus controller architecture

### Singleton pattern

The `ModbusController` lives on `this.homey.app.modbus` (created in `app.ts → onInit`). Drivers/devices grab it; they never instantiate their own `ModbusRTU` clients.

### TCP connection pool

One TCP socket per `host:port` pair. `Map<"ip:port", ModbusClient>`. If two devices are paired against the same Waveshare gateway with different unit IDs, they share one socket — and `setID(unitId)` is called per-request.

### Request serialisation

Every endpoint has a per-host `queue: Promise<unknown>` chain. Requests `then`-chain on it so they execute in order. RS-485 is half-duplex; concurrent Modbus frames on the bus collide — the Waveshare's Modbus Polling cache helps but doesn't eliminate the need to serialise.

### Coalescing reads

`controller.readRegisters(endpoint, [40001, 40004, 40005])` automatically merges sorted addresses into contiguous blocks (max 50 regs per block, gaps ≤ 4 stitched together). Saves round-trips.

### Library

We use **`modbus-serial`** (the de-facto Node Modbus client, ~400k weekly downloads). Stick with it; alternatives (`jsmodbus`, `node-modbus`) are less actively maintained.

### Gateway behaviour & connection lifecycle

The Waveshare RS485-to-WiFi/ETH gateways we target run **HF-LPB / "M2M Web Server"** firmware (also rebranded under USR-IOT, etc.). Two firmware quirks shape our connection logic — both verified against a live unit at `192.168.1.30`, not assumed:

- **`tcp_to = 30 s` idle timeout (default).** The gateway closes the TCP connection after 30 s of no application-layer Modbus traffic. **TCP keepalive segments do NOT reset this timer** — confirmed by experiment (`modbus-test/keepalive-experiment.ts`): a connection with `setKeepAlive(true, 10_000)` and zero Modbus traffic gets FIN-closed at `t=31.1 s` exactly. The `heart` config field is MQTT-mode only and irrelevant in TCP-server mode.
- **Don't recommend `tcp_to=0` to users.** It works, but the gateway's small embedded TCP stack accumulates zombie sockets from every Homey crash / network drop / WiFi blip that doesn't FIN cleanly. Slots eventually fill up and the gateway needs a power-cycle. The 30 s idle timeout exists for a reason.

The right combination is to **set the app's poll interval intentionally above OR below `tcp_to`**, never *equal* to it (a poll interval *equal* to `tcp_to` lands exactly on the boundary and reconnects ~50 % of the time — worst of both worlds). Two clean operating points:

| Default | Behaviour | Cost |
|---|---|---|
| `pollInterval=20s` (`< tcp_to`) | Persistent connection, never closes | More frequent polls (~25 KB/h) |
| `pollInterval=60s` (`> tcp_to`) | Reconnects each poll (TCP handshake ~50 ms) | Less polling (~8 KB/h) |

**Current default: 60 s.** Heat pump state genuinely evolves over minutes; 60 s is plenty for live tiles and Flow triggers, and aligns with Homey HVAC convention (MELCloud, Tado cluster around 55–60 s). The dead-detection layer below makes reconnect-each-poll transparent.

### Three-layer dead-socket recovery

modbus-serial's `client.isOpen` is unreliable for half-closed sockets — it only flips when *we* call `close()`, not when the remote silently FIN-closes. The controller layers three defences (`modbus/controller.ts`):

1. **Socket event watchers** (`close` / `error` / `end`) on the underlying `net.Socket` flip a `dead: true` flag on the pooled client. Next request calls `getClient` → sees `dead` → reconnects.
2. **TCP keepalive at 20 s** acts as a *liveness probe* — when the network drops (gateway power loss, router reboot), the OS detects the failure within ~20 s and emits `error`/`close`, triggering layer 1. Keepalive is **not** for idle prevention (see above); it's for fast network-drop detection.
3. **Read/write error trap** wraps every `readHoldingRegisters` / `writeRegister` in a try-catch that sets `dead = true` on any I/O failure. Backstop for cases the socket events miss.

`setNoDelay(true)` is also enabled per-socket — disables Nagle batching so small Modbus frames go on the wire immediately.

---

## 7. Live-power & energy estimation

The BMS-IFMB0UEW-E exposes no power, kWh, current or flow register. A full read-only scan (holding 40001–42000 and input registers, idle and at 41 Hz) found only the registers below; the remote controller's WF (flow), CT (outdoor current), PMV and HPS are **not** on the interface. Since 1.2.0 the estimate lives in [`drivers/heatpump/power-model.ts`](drivers/heatpump/power-model.ts) (pure, replay-tested in `test/power-model.test.ts`).

### Undocumented registers (R32, verified against the remote's "Sensor information")

| Register | Value |
|---|---|
| 40021 | TC — refrigerant on the **liquid line** after the plate heat exchanger (°C; service manual AE0-2101W p. 29). In heating it reads subcooled liquid: at or above TWI, but up to 5 K **under** TWO in floor heating |
| 40027 | LPS × 0.01 MPa (stuck at 142 on the 1101 during 2026-10-12…14; unused) |
| 40028 / 40029 / 40030 | TE / TD / TS (°C) |
| 40032 | compressor frequency (Hz); lags the real stop by ~35 s |
| 40033 | FAN1 (rpm) |

Read in one separate request (40021–40032) so a unit that rejects them can't break the main poll; three refusals in a row → not read until restart.

### Frequency model (R32 units, primary)

```
electric = Hz × C × n/(n−1) · p1 · ((p2/p1)^((n−1)/n) − 1)  + aux     n = 1.2, R32 saturation pressures
heating/DHW (TC ≥ TE): p1 = psat(TE), p2 = psat(max(TC, TWO + 3 K))       compressionTempsC()
cooling/defrost (TC < TE): p1 = psat(TC), p2 = psat(TE)
aux = standbyW + (compressor on ? runAuxW : winding preheat in frost)
```

**Why TWO + 3 K:** TC sits on the liquid line, so in low-temperature heating it reads the subcooled liquid at the return-water end (TC 28 °C at TWO 32 °C), not the condensing temperature. The refrigerant must condense above the leaving water; field data and literature put the approach at 1–5.6 K. Using TC alone read 20–30 % low in floor heating (power meter, 2026-10-13); 3 K fits both floor heating and hot water within ±5 %. A load-scaled approach (1 + 3·Hz/fmax) and a TD/TS refrigerant energy balance were tested and were worse (TD/TS: 50–150 % error — it needs a real suction pressure, LPS is stuck).

**Aux** (`standbyW`, `runAuxW`, `preheatW`, per preset in `device.ts`): from the ErP tables of the installation manual (2F30151001_05 p. 37–39): standby = P_SB + 15 W (Modbus interface and remote controller, not in P_SB), running = P_TO − P_SB (pump and outdoor fan), preheat = 40 W single-phase / 50 W three-phase while stopped at TO ≤ −1 °C, 10/15 duty down to −3 °C, continuous below (service manual p. 104; the Estia has no crankcase heater). HRW outdoor units add a 150 W base-plate heater whose control isn't documented — not modelled. R410A presets borrow the R32 11 kW values.

`C` (cm³) = compressor displacement ÷ overall efficiency. Displacements from the service manual's part list (Toshiba's model number is the displacement in 0.1 cm³): DX150A1T (401/601) 15.0, NX220A1FJ (801/1101 1-phase) 22.0, DX380A2TJ (1401 1-phase) and RX380A2TJ (801/1101/1401 3-phase H8W) 38.0 cm³. Overall efficiency 0.77, measured on an 1101 HW with a power meter (2026-10-13, aux counted apart) → C = 19.5 / 28.6 / 49.4. (Until 2026-10-14: 0.75 → 20.0 / 29.3 / 50.7, fitted against TC alone; the calibration now uses compressionTempsC() too.) The 3-phase 801/1101 have their own model entries (bigger compressor). R410A units have no default; the user can calibrate any R32 unit by typing the CT current (setting `ctCurrentA`) during a run: `C = I × 230 V × 0.97 / (Hz × work)`, stored as `compressorCm3`, cleared on a model change. Every calibration is also kept with its operating point in the store (`ctCalibrations`, last 20) — compare summer DHW and winter heating points to see whether one constant fits. Uncalibrated units other than the 1101: expect ±10–15 % (efficiency differs per compressor).

Validation (11 kW AIO HWT-1101HW-E + HWT-1101F21ST6W-E):

| Reference | Result |
|---|---|
| **Power meter** (Shelly Pro EM-50 on both line wires of the Estia breaker, 2026-10-13): hot water to 80 Hz / hot water + 5 min heater / floor heating 32 °C / three 10–15 min runs | +2.0 / −2.2 / −1.8 / −7.5 % per run (app before: −5 / −6 / −21 / −28…−34 %) |
| Same, steady polls (Hz unchanged, meter within 5 %) | median model/meter 0.95–1.05 in hot water and floor heating; ±4 % mean error over 173 polls |
| Same, 37 h incl. standby | −3.0 % (before: −33 %: standby wasn't counted) |
| CT 14.6 A at 71 Hz (3362 W, whole outdoor unit), stop step 1973 W at 45 Hz, 45 → 30 Hz step 678 W | −3 / +5 / +3 % |
| House-meter stop step 3168 W at 67 Hz (2026-10-04) | +5 % (house meter ±5 %) |
| Data Book E23-103 peak input, all 8 R32 outdoor units, A7/A2/A−7 at W35 (TE ≈ TO − 7 K) | 0.76–1.02: small units 0.9–1.0; 1101/1401 at maximum Hz 0.76–0.88 |

**Open risk — winter / maximum frequency:** against the Data Book the model reads 12–24 % low at maximum frequency on the bigger compressors (1101 at 100 Hz, 1401 at 82 Hz), most at A−7. On the metered unit up to 80 Hz it is within ±5 %, so efficiency probably drops further at the highest speeds. Not modelled until winter data (power meter) shows it; an efficiency term over pressure ratio or frequency would have to fit both the meter and the Data Book points of every unit.

The registers are used only when `RefrigerantSensorCheck` trusts them (store key `sensorCheck`): ≥ 20 idle polls with 0 Hz and TE within 2 K of outdoor, ≥ 5 polls where the water side shows a run with Hz > 0, TE ≥ 4 K away and TC ≥ TWI − 2 (the liquid leaves at the return-water end; the old TC ≥ TWO − 3 missed 12 % of the polls of 2026-10-13 in floor heating and could have dropped the trust in a heating season), and at most one miss per two confirmations. A register stuck at 0, a constant or an outdoor-like value never passes.

### Water model (fallback: R410A, 1401 without calibration, or before the check passes)

### Inputs and their sources

| Input | Source |
|---|---|
| Performance (water model) | R32 401/601/801/1101: "part load capacity and input" + "average heating capacity" tables of the Estia R32 Engineering Data Book (`data/r32-tables.json`; input excludes the water pump). Other models (R32 1401, R410A S4/S5/Hi Power): rated COP from `MODEL_PRESETS` (capacity ÷ heating input at A7/W35), shaped by the 1101 COP curve over outdoor/water temperature. Above LWT 55 °C the part-load result is scaled by the max-frequency COP ratio. |
| Water flow | Learnt from hot-water heat-ups: `flow = tank litres × tank rise / ∫ΔT dt` over compressor-only DHW segments (≥ 10 min, ≥ 8 K rise; tank start = the reading before the run, the sensor dips ~1 K when the pump starts), median of the last 7. Until then the rated flow (capacity at 5 K ΔT). The `flowLpm` setting overrides both — the only way to correct it on installs without a tank. |
| Compressor on/off | Register **40028 (TE, undocumented)** when `RefrigerantSensorCheck` trusts it: \|TE − TO\| ≥ 4 K. Trusted only after ≥ 20 quiet-water polls with TE within 2 K of outdoor **and** ≥ 10 polls where the water side shows a run and TE is ≥ 4 K away (misses ≤ 20 %): a constant or an outdoor-like value never passes. Read in its own request; three refusals in a row → water only until restart. Otherwise the water side: on at a **start** (TWO moving ≥ 2 K away from TWI within 2 min, in the expected direction) or a steady ΔT ≥ 3 K with TWO flat for 5 min; off after two polls without the expected ΔT. |
| What is served | DHW only on → `dhw` (the 3-way valve can only point at the tank). Zone only → `heating`/`cooling` from register 40003. Both → ΔT sign, tank rising. **Register 40003 is only used while the zone is on** — it keeps "cool" while the zone is off, which made pre-1.2.0 versions treat DHW heat-ups as cooling (no power during the run, phantom power during the cool-down after it). |
| Backup heater | Recognised 1–3 polls after a DHW hand-over; when that's ≤ 5 min after the compressor stopped, the gap is booked on the meter (`backfillKwh`). THO − TWO ≥ 2 K for ≥ 60 s, TWI steady, and the water flowing: with the compressor on, TWO and THO steady; with it off, TWO within +1/−3 K of TWI. Power = heater steps (3 kW) from flow × (THO − TWO), capped at the `backupHeaterKW` setting. |
| Boost heater | During a boost Toshiba switches the backup heater on at once (service manual § 7-3 items 8, 10), and the pump then runs at any flow (11–26 l/min seen), so THO − TWO is too small to judge. `boostActive` = Modbus/remote boost (40009) **or** SG "System Forced ON" reported by a Flow (action card `sg_forced_on_set`, store `sgForcedOn`) with setting `sgHeaterAllowed` (= DN 6CE 0, Toshiba default). Then the heater counts at its rating while THO ≥ TWO + 1 K for 2 min and the tank is under the boost set point (40213). Validated on the 2026-10-05 SG boost: 1.04 vs 1.11 kWh (−6 %; heater nominal 3.0 vs ~3.3 kW measured). |
| Heater hours | Universal backstop: each tick of register 40040 (backup heater hours, whole hours) is compared with the heater time the model counted since the previous tick; missing time (> 5 min, period ≥ 90 % polled) is booked at one 3 kW step. No register shows the heater state itself — scanned 40001–42000 while it ran (2026-10-05). |
| Immersion | Only once register 40039 (cylinder heater hours) has ticked (store flag `immersionSeen`): 2.75 kW while DHW is on, the tank rises and nothing else heats. |

### Field lessons (R32 11 kW AIO, 2026-10-03, 15 s polls + whole-house meter)

- After the pump stops, the standing water keeps TWO and TWI apart for 20+ minutes (51 vs 43 °C, then 27 vs 25 °C) and THO 2–5 K above TWO. A water ΔT alone is not a running compressor and THO − TWO alone is not a heater — hence the start signature and the "water flowing" test.
- When the pump starts, warm water from the coil passes TWI, TWO and THO in turn: THO can read 2 K above TWO for ~20 s (hence the 60 s minimum for the heater).
- DHW end on this unit: the compressor stops when the return (TWI) reaches 56 °C (52 °C on smaller units, service manual § 7-3) and the backup heater takes over; TWO and THO drop a few K at the handover while TWI stays. The model sees the heater ~2 min after the handover.
- The whole-house meter has other appliances switching up to ~1 kW (a 2.1 kW one-minute spike, an 860 W step with no heat pump sensor change). The trustworthy references are **single-poll steps** with a matching sensor change and the **tank heat-up**.

### Validation (`npm test`, fixtures in `test/fixtures/`)

| Check | Result |
|---|---|
| Compressor power before the stop vs the house step (−1973 W at 10:08:01 UTC) | 1937 W (−2 %) |
| Thermal energy vs tank heat-up (210 l × rise) | 3.77 vs 3.91 kWh; 1.54 vs 1.47 kWh |
| DHW run 29 → 45 °C, energy vs house meter | within 15 % (refrigerant), 20 % (water only) |
| Heater power vs its house step (−3185 W) | 3000 W (nominal at 230 V) |
| Full 26 h replay at 15 s and 60 s polls, with and without TE | no phantom power; learnt flow 17.5 l/min every time (measured 17–18) |

**Known limits of the water model** (why the frequency model exists):
- The tank-learnt flow was 17.5 l/min while the unit's flow sensor (WF on the remote) showed 11.5: the tank method overestimates the flow (~+50 %).
- Toshiba's part-load tables overestimate the COP in DHW (real ≈ 2.2 at TO 23 / TC 61 vs ~3.1 in the tables). On the test unit both errors cancelled at one point (−2 %), which is luck, not accuracy.
- Before the first learnt flow, the rated flow is used: 2.7× the real flow on the test unit (5.7 kW shown for 3.3 kW real).
- Integer °C (DIP S4-1 off): ΔT of 3 K is ±17 %. Units set to decidegrees get better live values.
- The water pump (not in Toshiba's input figures) and supply voltage are not modelled: the 3 kW heater measured 3066–3185 W, so heater energy reads 5–10 % low.
- The frequency register lags the real compressor stop by 35–70 s (the heater backfill starts from the register's stop).
- Backup heater **while the compressor runs** needs THO − TWO ≥ 3 K (sensor offset alone flips between 1 and 2 K). At hot-water flow (~12 l/min) a 3 kW step adds ~3.6 K and is seen; in space heating at ~30 l/min it adds ~1.4 K and is **not** seen next to a running compressor. Idea (not built): reconcile with register 40040 (backup heater hours, whole hours) — book the hours the model missed.

### meter_power

Integrated from the live estimate and continued from the value the device already had, so Homey Energy never sees the meter go backwards. Totals from before 1.2.0 (hour counters × rated input) stay in that starting value. The per-mode `meter_power.*` sub-capabilities stay removed (`DEPRECATED_CAPABILITIES`).

### Store keys

`powerLearnt` (`{ flowSamplesLpm }`, cleared when `tankLitres` changes), `sensorCheck` (register-check counters; saved when the verdict changes or every 30 min), `compressorCm3` (calibrated constant), `ctCalibrations` (calibration history), `immersionSeen`.

## 8. Localization workflow

Languages currently shipped: `en`, `nl`, `da`, `de`, `es`, `fr`, `it`, `no`, `sv`, `pl`, `ru`, `ko`, `ar` (13 — the full Homey-supported set).

### Workflow

1. Author a new string in **English only**, in any of:
   - `.homeycompose/app.json` `name` / `description`
   - `.homeycompose/capabilities/<id>.json` `title` / `desc`
   - `.homeycompose/flow/**/*.json` `title` / `titleFormatted` / `hint`
   - `drivers/heatpump/driver.compose.json` `capabilitiesOptions[*].title`
   - `drivers/heatpump/driver.settings.compose.json` `label` / `hint`
   - `locales/en.json` (runtime strings via `this.homey.__()`)

2. Run:
   ```bash
   source ~/.openai_env && homey app translate
   ```
   This calls OpenAI (`gpt-4o`) to fan English into all 13 languages, in-place. The OpenAI key is in `~/.openai_env` (mode 600, sourced from `~/.bashrc`).

3. Review the diff for sensitive terminology — heating jargon ("aanvoertemperatuur" vs "aanvoerwatertemperatuur", "instelpunt" vs "ingestelde temperatuur"). Hand-fix obvious mistranslations before committing.

### Localization gotchas

- Standard capabilities (`target_temperature`, `measure_temperature`, etc.) have hardcoded core titles in `nl` — see UI gotchas above.
- For pair-view HTML and settings HTML, plain `data-i18n` is not used — strings are inline. Translate by editing the HTML directly if that ever matters (currently English-only).

---

## 9. Phase status

- ✅ **Phase 1**: read-only sensors + alarm + pair flow with connection probe.
- ✅ **Phase 2**: writable on/off, mode (heat/cool), setpoints (Zone 1 + DHW), DHW boost, frost protection, night setback, auto-temp, anti-bacteria. Flow cards: `fault_triggered` trigger, `alarm_is_active` condition, `dhw_boost_for` action.
- ✅ **Season detection (1.1.0)**: see 9b.
- ✅ **Phase 3 — Energy estimation & connection robustness**: estimated `measure_power` (W) gated on demand + delta-T direction + ΔT modulation, with starting hysteresis and post-cycle lock; lifetime `meter_power` (kWh) from per-mode hour counters with monotonicity guard; auto-detection of cylinder immersion via register 40039 delta-hours (no user setting); three-layer dead-socket recovery in the controller (socket events + TCP keepalive + read/write error trap); poll-interval default tuned to gateway behaviour (60 s, reconnect-each-poll).
- ✅ **Power model (1.2.0)**: physical estimate replacing the Phase 3 one — flow × ΔT through Toshiba's part-load tables, flow learnt from the tank, TE (40028) when it proves itself, kWh integrated. See § 7.
- ⏳ **Phase 4 (not started)**:
  - Zone 2 setpoint + per-zone flow cards (gated on `enableZone2`).
  - mDNS discovery for the Waveshare (low priority — the gateway doesn't announce cleanly; manual IP works).
  - Multiple virtual devices per heat pump (one per setpoint) to escape the title-locking. Reorganise drivers into `heatpump_zone1`, `heatpump_dhw`, `heatpump_zone2`. Significant refactor — only justified if users demand truly distinct labels.

---

## 9b. Season detection (1.1.0)

`season` (custom enum: summer / midseason / winter) and `measure_temperature.outdoor_avg` are always-on caps.
- Every poll feeds the outdoor temperature into an in-memory hour bucket; at each full hour `recordOutdoor()` stores that hour's average in the device store (`outdoorHourly`, `[hour, °C][]`, last 7 days) and calls `updateSeason()`.
- `averageOutdoor()` returns null until two thirds of the averaging period (setting `seasonDays`, default 3) has values — so after pairing the average and season stay empty for ~2 days. Device capability logs can't be read from an app, so there's no seeding from Insights.
- `nextSeason()` applies the switch points with hysteresis (defaults: summer ≥ 24 / leave ≤ 22, winter ≤ 14 / leave ≥ 16). With no season yet it picks the nearest band (midpoints 23 and 15).
- `season` is read-only (sensor). A setable picker shared Homey's picker component with `thermostat_mode`, and opening the device page then set the season — so a hand-picked season goes through the `season_set` flow card → `setSeason()`, which fires `season_changed`. Automatic detection then only changes it again when the average is past a switch point.
- The app never changes the heat pump's mode from the season — that's up to the user's flows.

---

## 10. Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Edit `app.json` (root) directly | Changes vanish next build | Edit `.homeycompose/app.json` instead. |
| Use global `setInterval` | Timer survives device delete; memory leak | Use `this.homey.setInterval`. |
| Throw out of `pollOnce` | App may crash; device permanently unavailable | Always `try`/`catch` the whole poll, call `setUnavailable` with the message, never re-throw. |
| Add new optional cap without `OPTIONAL_CAPABILITIES` entry | Cap stuck on disabled devices, Insights leak | Add to OPTIONAL_CAPABILITIES + driver-manifest if it needs title overrides. |
| Use `{{placeholder}}` in `__()` | Literal `{{...}}` in UI | Build the string with template literals. |
| Attach button click listener on the element | Click never fires in pair view | Use document-level capture-phase listener. |
| Forget to bump migration flag | Migration never re-runs | Bump `_someChangeName_vN` suffix. |
| Use callback-only `Homey.emit` | Promise hangs forever | Wrap in dual-style `emit()` helper. |
| Add cap to `capabilities` then `removeCapability` | Insights orphan forever | Use `OPTIONAL_CAPABILITIES` for caps that may be off. |
| Set `pollInterval` equal to gateway's `tcp_to` (default 30 s) | ~50% of polls land on a freshly-closed socket → spurious failures | Pick `pollInterval` strictly below (persistent, e.g. 20 s) **or** strictly above (reconnect-each-poll, e.g. 60 s). Never *equal* to `tcp_to`. |
| Recommend `tcp_to=0` to "fix" idle drops | Zombie sockets accumulate from every Homey crash / network drop; eventually need gateway power-cycle | Leave `tcp_to=30` and rely on the dead-detection layer in `modbus/controller.ts`. |
| Use `antibacteriaOnOff` (reg 40011) as "currently running" | Permanent 2700 W phantom from immersion when feature is just *enabled* | It's a config bit, not a runtime status. Use delta-hours on `immersionHeaterHours` (40039) only. |
| Use `operationMode` (reg 40003) while the zone is off | DHW heat-ups read as cooling: no power during the run, phantom power after it | 40003 keeps the last zone mode; only use it while `zone1OnOff` is on (see § 7). |

---

## 11. Development workflow

### Iteration loop: **always install locally before publishing**

Every code/asset change goes through:

1. **`homey app install`** to the user's own Homey (a "development install" — survives CLI exit, runs alongside the published version).
2. **User verifies on-device** — open the app on the phone, check the device card, trigger the relevant flow, etc.
3. **Only then `homey app publish`** to upload a build to the Athom dashboard.

Skipping step 1 and going straight to publish wastes a build slot, burns a version number (a version locks once promoted past Draft), and risks shipping cosmetic regressions the user could have caught in 30 seconds. Reserve publish for changes the user has already eyeballed.

If `homey app install` errors with `ENOMEM: not enough memory, scandir …` on the WSL+OneDrive path, that's a transient OneDrive reparse-point issue — wait a few seconds and retry, or `rm -rf .homeybuild` then retry. Don't move to publish until install actually succeeds.

```bash
npm install                         # one-time
npm run lint                        # eslint pass
npm run build                       # tsc only

# inside-Homey
homey app validate                  # quick sanity (against debug level)
homey app build                     # compose + tsc + validate
homey app run                       # install with live logs (uninstalls on Ctrl+C)
homey app install                   # install without logs (survives CLI exit)
homey app manage                    # opens Developer Tools in browser

# Modbus diagnostics outside Homey
npx ts-node modbus-test/test-read.ts 192.168.1.30 502 1

# Translation
source ~/.openai_env && homey app translate

# Inspecting the running device via Homey API
homey api devices get-devices --json --jq '...'
homey api apps restart-app --id com.goossens.toshibaestia
homey api apps get-app-std --id com.goossens.toshibaestia --message ''
```

The Homey CLI runs against the currently-selected Homey (`homey list`, `homey select`).

---

## 12. Hardware & register reference

See `README.md` "Hardware configuration — this install" — exhaustive Waveshare web-UI settings + Toshiba DIP switch positions on the test rig. Sync invariants live there too.

Register map: [`modbus/registers.ts`](modbus/registers.ts), backed by *BMS-IFMB0UEW-E User Manual EEU-006 (31/05/2021)*. Holding-register addresses on the wire are `registerNumber - 40001`.

---

## 13. Testing checklist before each release

- [ ] `homey app validate --level publish` (stricter than debug)
- [ ] `npx ts-node modbus-test/test-read.ts` returns sane values
- [ ] Pair flow: configure → features → device shows up
- [ ] Toggle `enableZone2` from settings → cap appears/disappears live
- [ ] Toggle `enableDhw` from settings → DHW caps appear/disappear
- [ ] Trigger an alarm somehow (or simulate via setting `alarmStatus` register manually) → flow trigger fires with tokens
- [ ] Run `homey app translate` and review diffs
- [ ] Bump `version` in `.homeycompose/app.json` + add changelog entry to `.homeychangelog.json`

---

## 14. Publication to the Homey App Store

The app currently passes `homey app validate --level publish` (stricter than the default `debug` level). Files in place for store submission:

| File | Purpose |
|---|---|
| `.homeycompose/app.json` | id, version, tagline (`description.en`), tags, support URL, bugs URL, contributors |
| `.homeychangelog.json` | per-version release note (locale object). Every version that has ever been published needs an entry. |
| `README.txt` | long-form store description (Kaisai-style: one paragraph value, one paragraph requirements, one paragraph supported models). Pasted into the Developer Dashboard at submission time — NOT loaded automatically. |
| `assets/icon.svg` + `assets/images/{small,large,xlarge}.png` | app-level (250×175 / 500×350 / 1000×700) |
| `drivers/heatpump/assets/icon.svg` + `images/{small,large,xlarge}.png` | driver-level (75×75 / 500×500 / 1000×1000) |
| `locales/*.json` | runtime strings, all 13 Homey-supported locales |

### Publish flow

1. Bump `version` in `.homeycompose/app.json` (e.g. `0.1.0` → `1.0.0` for the first store release; subsequent: SemVer).
2. Add a matching entry to `.homeychangelog.json` with at least an `en` description, ideally all 13 locales — run `homey app translate` after editing only `en` to fan it out.
3. Open a Homey Community forum thread for the app. Once it has an ID (see https://community.homey.app), set `homeyCommunityTopicId` in `.homeycompose/app.json`.
4. `homey app validate --level publish` (must pass clean).
5. `homey app publish` — uploads the build to https://tools.developer.homey.app and returns a Test URL.
6. In the Developer Dashboard:
   - Paste `README.txt` into the long description field.
   - Upload screenshots (mobile UI captures are nice; not strictly required).
   - Pick `category: climate` and verify `brandColor` renders well.
7. Promote: Draft → Test → Certification (Athom review) → Live.

### Forbidden phrasings (Athom guidelines)

The store reviewer rejects descriptions starting with "Adds support for…" or "Integrates X with Homey". Use active value framing — "Control your X locally", "Bring your X into Homey", "See/Read/Write …".

### Don't ship without

- A real GitHub repo at the URL set in `source` and `bugs.url` (currently `https://github.com/jogoossens/com.goossens.toshibaestia` — placeholder; create the repo before publishing).
- A `LICENSE` file. Tydom doesn't ship one but Athom's reviewer prefers an explicit license. MIT or GPL-3.0 are both fine.
- A `homeyCommunityTopicId` set; users come back to that thread for issues.

---

## 15. When in doubt

- `README.md` for the user-facing view.
- The BMS-IFMB0UEW-E manual is in the repo root (`OM_EEU-006_EN.pdf`) — quote section + page when referencing.
- The Waveshare manual is also there (`RS485-TO-WIFI-ETH-User-Manual-EN.pdf`).
- Athom docs canonical sources used during this build: https://apps.developer.homey.app/ and https://apps-sdk-v3.developer.homey.app/.
- This file (`AGENTS.md`) is the source of truth for *why* things are done a certain way. If you change a pattern, update this file in the same commit.
