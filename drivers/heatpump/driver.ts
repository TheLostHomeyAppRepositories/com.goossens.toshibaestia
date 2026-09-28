import Homey from 'homey';
import type ToshibaEstiaApp from '../../app';
import type HeatpumpDevice from './device';
import type { Season } from './season';
import { REGISTERS, decodeHydroUnitType, decodeBaudRate } from '../../modbus/registers';

type TempScaling = 'x1' | 'x10';

interface PairState {
  host: string;
  port: number;
  unitId: number;
  timeoutMs: number;
  enableDhw: boolean;
  enableZone2: boolean;
  tempScaling: TempScaling;
}

interface ProbeResult {
  ok: boolean;
  deviceDefinition?: number;
  hydroUnitType?: number;
  hydroUnitSeries?: string;
  slaveAddress?: number;
  baudRate?: number | null;
  error?: string;
}

export default class HeatpumpDriver extends Homey.Driver {
  private pairState: PairState = {
    host: '192.168.1.30',
    port: 502,
    unitId: 1,
    timeoutMs: 2000,
    enableDhw: true,
    enableZone2: false,
    tempScaling: 'x1',
  };

  async onInit(): Promise<void> {
    this.log('HeatpumpDriver initialized');
    this.registerFlowCards();
  }

  /**
   * Flow-card run listeners. Device-scoped cards (with a `device` arg) get
   * the device instance via the args object. All cards filter on
   * driver_id=heatpump so they only see our devices.
   */
  private registerFlowCards(): void {
    // Condition: alarm is active
    try {
      this.homey.flow.getConditionCard('alarm_is_active')
        .registerRunListener(async (args: { device: HeatpumpDevice }) => {
          return Boolean(args.device.getCapabilityValue('alarm_generic'));
        });
    } catch (err) {
      this.error('register alarm_is_active', err);
    }

    // Action: boost DHW for N minutes
    try {
      this.homey.flow.getActionCard('dhw_boost_for')
        .registerRunListener(async (args: { device: HeatpumpDevice; minutes: number }) => {
          await args.device.startDhwBoostFor(Number(args.minutes));
        });
    } catch (err) {
      this.error('register dhw_boost_for', err);
    }

    // Actions: Zone 1 water temperature and auto temperature. Custom
    // capabilities (our target_temperature shadow, auto_temp) get no
    // auto-generated cards, so these go through the capability listeners.
    try {
      this.homey.flow.getActionCard('zone1_temperature_set')
        .registerRunListener(async (args: { device: HeatpumpDevice; temperature: number }) => {
          await args.device.triggerCapabilityListener('target_temperature', Number(args.temperature));
        });
    } catch (err) {
      this.error('register zone1_temperature_set', err);
    }
    try {
      this.homey.flow.getActionCard('auto_temp_set')
        .registerRunListener(async (args: { device: HeatpumpDevice; state: 'on' | 'off' }) => {
          await args.device.triggerCapabilityListener('auto_temp', args.state === 'on');
        });
    } catch (err) {
      this.error('register auto_temp_set', err);
    }

    // Season (1.1.0): the season_changed trigger is fired from device.ts.
    try {
      this.homey.flow.getConditionCard('season_is')
        .registerRunListener(async (args: { device: HeatpumpDevice; season: string }) => {
          return args.device.getCapabilityValue('season') === args.season;
        });
      this.homey.flow.getActionCard('season_set')
        .registerRunListener(async (args: { device: HeatpumpDevice; season: string }) => {
          await args.device.setSeason(args.season as Season);
        });
      this.homey.flow.getDeviceTriggerCard('season_changed');
    } catch (err) {
      this.error('register season cards', err);
    }

    // Trigger fault_triggered is fired from device.ts; no runListener needed unless
    // we add filter args later. Accessing it once here ensures Homey knows it exists.
    try { this.homey.flow.getDeviceTriggerCard('fault_triggered'); } catch (err) {
      this.error('register fault_triggered', err);
    }
  }

  private get app(): ToshibaEstiaApp {
    return this.homey.app as ToshibaEstiaApp;
  }

  /**
   * Pair session wiring. Three handlers:
   *  - `get_config`    : frontend reads the defaults/last values shown in the form
   *  - `set_config`    : frontend pushes user inputs before probing
   *  - `probe`         : frontend asks for a live test. Returns detected unit info.
   *  - `list_devices`  : Homey calls this when moving to the built-in add_devices view.
   */
  async onPair(session: any): Promise<void> {
    session.setHandler('get_config', async () => this.pairState);

    session.setHandler('set_config', async (data: Partial<PairState>) => {
      this.pairState = {
        ...this.pairState,
        ...data,
        port: Number(data.port ?? this.pairState.port),
        unitId: Number(data.unitId ?? this.pairState.unitId),
        timeoutMs: Number(data.timeoutMs ?? this.pairState.timeoutMs),
      };
      return this.pairState;
    });

    session.setHandler('set_features', async (data: Partial<PairState>) => {
      this.pairState = {
        ...this.pairState,
        enableDhw: Boolean(data.enableDhw),
        enableZone2: Boolean(data.enableZone2),
        tempScaling: data.tempScaling === 'x10' ? 'x10' : 'x1',
      };
      return this.pairState;
    });

    session.setHandler('probe', async (): Promise<ProbeResult> => this.probe(this.pairState));

    session.setHandler('build_device', async () => {
      const devices = await this.buildListDevices(this.pairState);
      if (devices.length === 0) {
        throw new Error('Connection probe failed — check the gateway settings.');
      }
      return devices[0];
    });

    session.setHandler('list_devices', async () => this.buildListDevices(this.pairState));
  }

  /** Test the connection and decode identity registers. */
  private async probe(state: PairState): Promise<ProbeResult> {
    try {
      const endpoint = {
        host: state.host,
        port: state.port,
        unitId: state.unitId,
        timeoutMs: state.timeoutMs,
      };
      const snapshot = await this.app.modbus.readRegisters(endpoint, [
        REGISTERS.deviceDefinition.number,
        REGISTERS.hydroUnitType.number,
        REGISTERS.slaveAddress.number,
        REGISTERS.baudRateCode.number,
      ]);
      const deviceDefinition = snapshot[REGISTERS.deviceDefinition.number];
      const hydroUnitType = snapshot[REGISTERS.hydroUnitType.number];
      const slaveAddress = snapshot[REGISTERS.slaveAddress.number];
      const baudRateCode = snapshot[REGISTERS.baudRateCode.number];
      return {
        ok: deviceDefinition === 0x2C00,
        deviceDefinition,
        hydroUnitType,
        hydroUnitSeries: decodeHydroUnitType(hydroUnitType),
        slaveAddress,
        baudRate: decodeBaudRate(baudRateCode),
        error: deviceDefinition === 0x2C00
          ? undefined
          : `Device definition mismatch (got 0x${(deviceDefinition ?? 0).toString(16).toUpperCase()}; expected 0x2C00). Wrong unit ID?`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /** After probe succeeds, offer the heat pump as a single device. */
  private async buildListDevices(state: PairState): Promise<Array<Record<string, unknown>>> {
    const probe = await this.probe(state);
    if (!probe.ok) return [];
    const series = probe.hydroUnitSeries ?? 'Estia Heat Pump';
    return [
      {
        name: `Toshiba Estia (${series})`,
        data: {
          // Stable unique ID — gateway + slave id
          id: `${state.host}:${state.port}#${state.unitId}`,
        },
        settings: {
          host: state.host,
          port: state.port,
          unitId: state.unitId,
          pollInterval: 30,
          requestTimeout: state.timeoutMs,
          tempScaling: state.tempScaling,
          enableZone2: state.enableZone2,
          enableDhw: state.enableDhw,
          detectedSeries: series,
          detectedSlaveAddress: String(probe.slaveAddress ?? state.unitId),
          detectedBaudRate: probe.baudRate != null ? `${probe.baudRate} bps` : '—',
          lastSeen: '—',
        },
      },
    ];
  }
}

module.exports = HeatpumpDriver;
