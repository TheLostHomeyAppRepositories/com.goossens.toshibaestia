/**
 * External energy meter: any Homey device with `measure_power` that measures the heat pump's
 * circuit (e.g. a Shelly EM). The user picks it on the app settings page; the app reads it through
 * Homey's Web API (permission `homey:manager:api`). While it is linked and available, the heat
 * pump device reports the measured power and energy instead of the estimate.
 */

/** Minimal shape of a Web API device that this module reads. */
export interface ApiDevice {
  id: string;
  name: string;
  driverId?: string;
  class?: string;
  available?: boolean;
  capabilities?: string[];
  capabilitiesObj?: Record<string, { value?: unknown } | undefined> | null;
  energyObj?: Record<string, unknown> | null;
}

export interface MeterChoice {
  id: string;
  name: string;
  energyCapability: string | null;
}

const toNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The lifetime energy counter to follow: the one Homey Energy uses for the device's
 * consumption (`meterPowerImportedCapability`), else `meter_power`. Null when the meter
 * has no counter; the energy is then integrated from the power.
 */
export function energyCapabilityOf(device: ApiDevice): string | null {
  const capabilities = device.capabilities ?? [];
  const imported = device.energyObj?.meterPowerImportedCapability;
  if (typeof imported === 'string' && capabilities.includes(imported)) return imported;
  if (capabilities.includes('meter_power')) return 'meter_power';
  return null;
}

/**
 * Whether a device can be an appliance's meter: it measures power, is not one of this app's own
 * devices, and is not a whole-home meter, home battery or solar panel (those are no sub-meter).
 */
export function isApplianceMeter(device: ApiDevice, ownDriverPrefix: string): boolean {
  const energy = device.energyObj ?? {};
  return (device.capabilities ?? []).includes('measure_power')
    && !(device.driverId ?? '').startsWith(ownDriverPrefix)
    && energy.cumulative !== true
    && energy.homeBattery !== true
    && energy.generator !== true
    && device.class !== 'solarpanel'
    && device.class !== 'battery';
}

/** Devices that can serve as meter, sorted by name. */
export function meterChoices(devices: ApiDevice[], ownDriverPrefix: string): MeterChoice[] {
  return devices
    .filter((d) => isApplianceMeter(d, ownDriverPrefix))
    .map((d) => ({ id: d.id, name: d.name, energyCapability: energyCapabilityOf(d) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a Web API error means the meter device no longer exists (removed or paired again). */
export function isMeterGone(err: unknown): boolean {
  const e = err as { statusCode?: unknown; message?: unknown } | null;
  return e?.statusCode === 404 || /not found/i.test(String(e?.message ?? ''));
}

/**
 * Energy since the previous reading of a lifetime counter. The first reading, a missing
 * counter and a drop (counter reset, other meter) add nothing and start over.
 */
export class MeterDelta {
  private lastKwh: number | null = null;

  next(kwh: number | null): number {
    const previous = this.lastKwh;
    this.lastKwh = kwh;
    if (kwh === null || previous === null || kwh < previous) return 0;
    return kwh - previous;
  }

  reset(): void {
    this.lastKwh = null;
  }
}

/**
 * Link to one meter device. The caller re-reads the meter through the Web API on every poll
 * (`update`); a failed read makes it unusable until the next successful one.
 */
export class ExternalMeterLink {
  watts: number | null = null;
  kwh: number | null = null;
  available = true;
  name: string;
  readonly energyCapability: string | null;

  private readonly delta = new MeterDelta();

  constructor(readonly meterId: string, device: ApiDevice) {
    this.name = device.name;
    this.energyCapability = energyCapabilityOf(device);
    this.update(device);
  }

  /** Takes the meter's latest power, energy counter and availability. */
  update(device: ApiDevice): void {
    this.name = device.name;
    this.available = device.available !== false;
    this.watts = toNumber(device.capabilitiesObj?.measure_power?.value);
    this.kwh = this.energyCapability ? toNumber(device.capabilitiesObj?.[this.energyCapability]?.value) : null;
  }

  /** The meter could not be read (removed, Homey busy): use the estimate until it answers again. */
  markUnavailable(): void {
    this.available = false;
  }

  /** True when the meter can be used now: available and with a power reading. */
  get usable(): boolean {
    return this.available && this.watts !== null;
  }

  /** Energy (kWh) the meter counted since the previous call; null when it has no counter. */
  energySinceLast(): number | null {
    if (this.energyCapability === null) return null;
    return this.delta.next(this.kwh);
  }

  /** Forget the counter baseline, e.g. while the estimate is used instead. */
  resetEnergy(): void {
    this.delta.reset();
  }
}
