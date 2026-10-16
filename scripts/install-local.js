/*
 * Local install with the external energy meter (homey:manager:api).
 *
 * The App Store build may not have that permission (Athom review of build 24), so the committed
 * manifests are the store variant. This script adds the parts from variants/external-meter.json,
 * runs `homey app install` (or `homey app run` with --run), and always restores the files afterwards.
 * The app enables the meter only when its manifest has the permission (app.ts externalMeterAvailable).
 *
 * Usage: npm run install:local          (homey app install)
 *        npm run install:local -- --run (homey app run, with live logs)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const file = (p) => path.join(root, p);
const APP = file('.homeycompose/app.json');
const DRIVER = file('drivers/heatpump/driver.compose.json');
const SETTINGS = file('drivers/heatpump/driver.settings.compose.json');
const GENERATED = file('app.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, j) => fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);

function applyVariant(variant) {
  const app = readJson(APP);
  app.permissions = [...new Set([...(app.permissions || []), ...variant.app.permissions])];
  app.api = { ...app.api, ...variant.app.api };
  writeJson(APP, app);

  const driver = readJson(DRIVER);
  if (!driver.capabilities.includes(variant.driver.capability)) driver.capabilities.push(variant.driver.capability);
  driver.capabilitiesOptions[variant.driver.capability] = variant.driver.capabilitiesOptions;
  driver.repair = variant.driver.repair;
  writeJson(DRIVER, driver);

  const settings = readJson(SETTINGS);
  const group = settings.find((g) => (g.children || []).some((s) => s.id === variant.settings.after));
  if (!group) throw new Error(`Setting ${variant.settings.after} not found`);
  if (!group.children.some((s) => s.id === variant.settings.setting.id)) {
    const at = group.children.findIndex((s) => s.id === variant.settings.after) + 1;
    group.children.splice(at, 0, variant.settings.setting);
  }
  writeJson(SETTINGS, settings);
}

const variant = readJson(file('variants/external-meter.json'));
const backup = new Map([APP, DRIVER, SETTINGS, GENERATED].map((p) => [p, fs.readFileSync(p)]));
const restore = () => {
  for (const [p, content] of backup) fs.writeFileSync(p, content);
};
// Restore on Ctrl+C too (homey app run is stopped that way).
process.on('SIGINT', () => {});

let status = 1;
try {
  applyVariant(variant);
  const command = process.argv.includes('--run') ? 'run' : 'install';
  console.log(`External meter added for this local build; running homey app ${command} …`);
  const result = spawnSync('homey', ['app', command], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  status = result.status ?? 1;
} finally {
  restore();
  console.log('Manifests restored to the App Store variant.');
}
process.exitCode = status;
