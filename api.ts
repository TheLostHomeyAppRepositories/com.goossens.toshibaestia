import type ToshibaEstiaApp from './app';

/** Settings page endpoints for linking an external meter to a heat pump. */
type Args = { homey: { app: ToshibaEstiaApp }; body?: { deviceId?: string; meterId?: string | null } };

module.exports = {
  async getMeters({ homey }: Args) {
    return homey.app.listMeters();
  },
  async getLinks({ homey }: Args) {
    return homey.app.getMeterLinks();
  },
  async setLink({ homey, body }: Args) {
    if (!body?.deviceId) throw new Error('deviceId is required');
    return homey.app.setMeterLink(body.deviceId, body.meterId || null);
  },
};
