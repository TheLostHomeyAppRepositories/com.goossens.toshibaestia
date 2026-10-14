import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiDevice, ExternalMeterLink, MeterDelta, energyCapabilityOf, isApplianceMeter, meterChoices,
} from '../drivers/heatpump/external-meter';

const OWN = 'homey:app:com.goossens.toshibaestia:';

const shellyEm: ApiDevice = {
  id: 'shelly',
  name: 'Toshiba Estia Stroom',
  class: 'socket',
  driverId: 'homey:app:cloud.shelly.control:shellyproem50_local',
  capabilities: ['measure_power', 'meter_power.total', 'meter_power.imported', 'meter_power.exported'],
  capabilitiesObj: { measure_power: { value: 38.3 }, 'meter_power.imported': { value: 12.5 } },
  energyObj: { meterPowerImportedCapability: 'meter_power.imported', meterPowerExportedCapability: 'meter_power.exported' },
};

test('the energy counter is the one Homey Energy uses, else meter_power, else none', () => {
  assert.equal(energyCapabilityOf(shellyEm), 'meter_power.imported');
  assert.equal(energyCapabilityOf({ id: 'p', name: 'Plug', capabilities: ['measure_power', 'meter_power'] }), 'meter_power');
  assert.equal(energyCapabilityOf({ id: 'u', name: 'UPS', capabilities: ['measure_power'] }), null);
});

test('appliance meters only: no own devices, whole-home meters, batteries or solar panels', () => {
  const own: ApiDevice = { id: 'estia', name: 'Toshiba Estia', driverId: `${OWN}heatpump`, capabilities: ['measure_power', 'meter_power'] };
  const lamp: ApiDevice = { id: 'lamp', name: 'Lamp', capabilities: ['onoff'] };
  const plug: ApiDevice = { id: 'plug', name: 'Airco Stroom', class: 'socket', capabilities: ['measure_power', 'meter_power'] };
  const grid: ApiDevice = { id: 'grid', name: 'Grid', class: 'sensor', capabilities: ['measure_power'], energyObj: { cumulative: true } };
  const battery: ApiDevice = { id: 'bat', name: 'Battery', class: 'battery', capabilities: ['measure_power'], energyObj: { homeBattery: true } };
  const solar: ApiDevice = { id: 'pv', name: 'Solar', class: 'solarpanel', capabilities: ['measure_power', 'meter_power'], energyObj: { generator: true } };
  assert.equal(isApplianceMeter(shellyEm, OWN), true);
  for (const d of [own, lamp, grid, battery, solar]) assert.equal(isApplianceMeter(d, OWN), false, d.name);
  assert.deepEqual(meterChoices([shellyEm, own, lamp, plug, grid, battery, solar], OWN).map((c) => c.id), ['plug', 'shelly']);
});

test('meter delta: counts increases, starts over after a drop or a missing counter', () => {
  const d = new MeterDelta();
  assert.equal(d.next(10), 0);
  assert.equal(d.next(10.25), 0.25);
  assert.equal(d.next(3), 0, 'counter reset');
  assert.equal(d.next(3.5), 0.5);
  assert.equal(d.next(null), 0);
  assert.equal(d.next(4), 0, 'baseline again after a gap');
  assert.ok(Math.abs(d.next(4.1) - 0.1) < 1e-9);
});

test('link: takes the meter\'s power, counter and availability on every read', () => {
  const link = new ExternalMeterLink('shelly', shellyEm);
  assert.equal(link.watts, 38.3);
  assert.equal(link.usable, true);
  assert.equal(link.energySinceLast(), 0, 'first reading is the baseline');

  link.update({ ...shellyEm, capabilitiesObj: { measure_power: { value: 1500 }, 'meter_power.imported': { value: 12.9 } } });
  assert.equal(link.watts, 1500);
  assert.ok(Math.abs((link.energySinceLast() ?? 0) - 0.4) < 1e-9);

  link.update({ ...shellyEm, available: false });
  assert.equal(link.usable, false);
  link.update(shellyEm);
  assert.equal(link.usable, true);
  link.markUnavailable();
  assert.equal(link.usable, false);
});

test('link without an energy counter reports null, so the caller integrates the power', () => {
  const link = new ExternalMeterLink('ups', { id: 'ups', name: 'UPS', capabilities: ['measure_power'], capabilitiesObj: { measure_power: { value: 160 } } });
  assert.equal(link.energyCapability, null);
  assert.equal(link.energySinceLast(), null);
  assert.equal(link.watts, 160);
});
