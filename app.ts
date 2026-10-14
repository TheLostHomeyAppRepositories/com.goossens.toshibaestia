import Homey from 'homey';
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('source-map-support').install();
import { ModbusController } from './modbus/controller';
import { ApiDevice, MeterChoice, meterChoices } from './drivers/heatpump/external-meter';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomeyAPI } = require('homey-api');

/** One heat pump on the settings page with the meter linked to it (null: the estimate). */
export interface MeterLink {
  deviceId: string;
  name: string;
  meterId: string | null;
}

/** What a heat pump device offers the app for external meters (drivers/heatpump/device.ts). */
interface MeterLinkedDevice extends Homey.Device {
  getExternalMeterId(): string | null;
  setExternalMeter(meterId: string | null): Promise<void>;
}

/**
 * App-level host. Owns a single ModbusController shared across all devices,
 * so multiple heat pumps behind the same gateway share one TCP socket.
 *
 * Devices access it through `this.homey.app.modbus`.
 */
export default class ToshibaEstiaApp extends Homey.App {
  public modbus!: ModbusController;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private homeyApi: any | null = null;

  async onInit(): Promise<void> {
    const debug = (this.homey.settings.get('debug') as boolean | null) ?? false;
    this.modbus = new ModbusController({
      log: (...args) => this.log('[ModbusController]', ...args),
      error: (...args) => this.error('[ModbusController]', ...args),
    });

    if (debug) this.log('Debug logging enabled');
    this.log(`${this.id} v${this.manifest.version} ready`);

    // Live-toggle debug logging without restart
    this.homey.settings.on('set', (key: string) => {
      if (key === 'debug') {
        const now = this.homey.settings.get('debug') as boolean | null;
        this.log(`Debug logging ${now ? 'enabled' : 'disabled'}`);
      }
    });
  }

  /**
   * Homey's Web API, used only to read an external meter the user links to a heat pump
   * (permission homey:manager:api). Created on first use.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getHomeyApi(): Promise<any> {
    if (!this.homeyApi) this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
    return this.homeyApi;
  }

  /** Devices that can be linked as meter (settings page). */
  async listMeters(): Promise<MeterChoice[]> {
    const api = await this.getHomeyApi();
    const devices = Object.values(await api.devices.getDevices()) as ApiDevice[];
    return meterChoices(devices, `homey:app:${this.id}:`);
  }

  private heatPumps(): MeterLinkedDevice[] {
    return this.homey.drivers.getDriver('heatpump').getDevices() as MeterLinkedDevice[];
  }

  /** Every heat pump with its linked meter (settings page). */
  getMeterLinks(): MeterLink[] {
    return this.heatPumps().map((device) => ({
      deviceId: String(device.getData().id),
      name: device.getName(),
      meterId: device.getExternalMeterId(),
    }));
  }

  /** Links a meter to a heat pump, or unlinks it with null (settings page). */
  async setMeterLink(deviceId: string, meterId: string | null): Promise<MeterLink[]> {
    const device = this.heatPumps().find((d) => String(d.getData().id) === deviceId);
    if (!device) throw new Error(`Unknown heat pump ${deviceId}`);
    await device.setExternalMeter(meterId);
    return this.getMeterLinks();
  }

  async onUninit(): Promise<void> {
    try {
      await this.modbus.destroy();
    } catch (err) {
      this.error('Error during onUninit', err);
    }
  }
}

module.exports = ToshibaEstiaApp;
