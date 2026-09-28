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

The BMS-IFMB0UEW-E exposes neither real-time power nor lifetime kWh. We synthesise both from per-mode lifetime hour counters (registers 40035–40040) × per-model nominal electrical input (kW), with delta-T modulation for live W.

### MODEL_PRESETS — what the numbers represent

`MODEL_PRESETS` in [`drivers/heatpump/device.ts`](drivers/heatpump/device.ts) holds rated **electrical input** in kW @ Toshiba's standard rating points (heating A7/W35, cooling A35/W7, DHW A7/W55), pulled directly from datasheets. **COP is not modelled explicitly** — the rated values implicitly encode it (e.g. R32 1101: 2.39 kW input → 11 kW thermal = COP 4.6 baked in). This is accurate within ±10–20 % at typical conditions but underestimates in cold weather (real COP drops to ~2.5 at A−7) and overestimates at mild outdoor temps. The OSS community consensus is that anyone needing invoice-grade accuracy fits a Shelly EM clamp; we don't try to compete with that.

### R32 1 Series and 2 Series share electrical inputs

Verified against Toshiba Klima Austria S2 datasheets (4 / 6 / 8 / 14 kW). The S1 → S2 refresh changed the indoor hydro module code from `F21` → `S21` and upgraded the cabinet (stainless tank, 10-bar pressure, 595 mm width) but reused the same outdoor units (`HWT-_HW-E`) and same compressor → identical input ratings to the digit. **One MODEL_PRESETS entry per kW class is correct**; there's no S1/S2 distinction worth exposing in the dropdown.

### Heater configuration: HWT All-In-One has only the BUH

Verified against the HWT AIO IM, the Wall-Mounted Hydro IM, and the Estia Engineering Data Book E23-103. The AIO range (`HWT-_F21S` / `HWT-_S21S`) ships with **only one electric heater** — the BUH on the primary heating-water circuit. There is **no separate cylinder immersion** in the integrated 210–220 L tank. The Wall-Mounted hydro variants optionally pair with an `HWS-CSHM3-E` external cylinder that *can* contain a 2.75 kW immersion, but only if the installer wires it.

The BMS-IFMB0UEW-E exposes register 40039 ("DHW cylinder heater hours") on **all** Estia models because the gateway firmware is generic — meaningful only when an immersion is physically wired. **Detection is auto by delta-hours**: the immersion contributes to `meter_power` only when 40039 actually ticks between polls. AIO owners see 0 W from immersion forever; split-system owners with a wired CSHM cylinder get correct billing without configuration. The hardcoded rating is **2.75 kW** (Toshiba's only spec); no user setting.

### Live W algorithm (`measure_power`)

Computed each poll in `applySnapshot` (`device.ts`):

1. **Demand gate** — if neither `zone1OnOff` nor `hotWaterOnOff` is set, watts from compressor are forced to 0.
2. **Active-running gate** — `|TWO − TWI| > 1.5 °C` (heat exchange occurring) AND TWO moving in the right direction for the current mode (rising in heating, falling in cooling — kills residual-stratification false positives).
3. **Demand-transition state machine** — 60 s starting hysteresis (suppresses compressor ramp) and 180 s post-cycle lock (suppresses water-side delta-T after demand drops).
4. **Modulation** — `ratedKw × clip(|ΔT| / 5°C, 0.5, 1.5)`. Captures inverter modulation: a unit at 30 % load shows roughly half rated, a unit in defrost recovery shows up to 1.5×. Old `rated × on/off` always reported full-rated and was hugely wrong during normal modulation.
5. **BUH** — `THO − TWO > 1.0 °C` flips BUH to "running" and adds `ratedBackup × 1000` W. Independent of compressor — the BUH heats whichever side the 3-way valve points at.
6. **Immersion** — delta-hours only (40039 ticked between polls). The anti-bacteria flag (40011) is a *config* bit ("feature enabled"), not runtime — using it as "currently running" caused a permanent 2700 W false positive (see commit history). Tank-temperature heuristics also misfire on integer-quantised readings.

### Lifetime kWh (`meter_power`)

`Σ (hour_counter × rated_input_kW)` for each of the five sources, with a **monotonicity guard**: a single bad register read can produce a kWh value lower than the previous one, and lifetime totals must be non-decreasing — drop the new value and keep the last known good one if it tries to roll back.

The five per-mode `meter_power.heating/cooling/dhw/backup/immersion` sub-capabilities were removed in favour of a single `meter_power` total (cleaner device card; Insights still tracks the total over time). The sub-cap names are in `DEPRECATED_CAPABILITIES` so existing devices auto-clean on the next `onInit`.

---

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
- ⏳ **Phase 4 (not started)**:
  - Zone 2 setpoint + per-zone flow cards (gated on `enableZone2`).
  - COP-aware live-power scaling: per-model COP curve indexed by outdoor temp + flow temp. Gets us within ±10 % year-round instead of being weather-blind. ~50 LOC, needs datasheet curve data baked in.
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
