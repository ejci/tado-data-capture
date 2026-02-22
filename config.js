/**
 * config.js
 *
 * Centralises all configuration for the application.
 * Reads environment variables (via dotenv), validates that required ones are
 * present, and exports a single frozen config object consumed by every module.
 *
 * Polling intervals are expressed in milliseconds throughout the application.
 * Sensible defaults are provided so the app works out-of-the-box with only the
 * required variables set.
 */
require('dotenv').config();

// ---------------------------------------------------------------------------
// Required environment-variable validation
// Fail fast at startup rather than encountering cryptic errors later.
// ---------------------------------------------------------------------------
const requiredEnv = [
  'TADO_CLIENT_ID',
  'INFLUX_URL',
  'INFLUX_TOKEN',
  'INFLUX_ORG',
  'INFLUX_BUCKET'
];

const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length > 0) {
  process.stderr.write(`[config] Missing required environment variables: ${missing.join(', ')}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exported configuration object
// ---------------------------------------------------------------------------
module.exports = Object.freeze({
  /**
   * When true the application logs what it *would* write to InfluxDB but does
   * not actually send any data.  Useful for local testing.
   */
  dryRun: process.env.TADO_DRY_RUN === 'true',

  /** HTTP port the Express web server listens on. */
  port: parseInt(process.env.TADO_LOGIN_PORT, 10) || 3000,

  tado: {
    /** OAuth2 client ID used for Device Flow authorisation. */
    clientId: process.env.TADO_CLIENT_ID,

    /**
     * How often (in ms) each data type is polled from the Tado API.
     * Independent intervals allow high-frequency data (rooms) to be collected
     * more often than slow-changing data (weather).
     *
     * Defaults:
     *   weather  – 3 600 000 ms  (1 hour)
     *   rooms    –   600 000 ms  (10 minutes)
     *   heatPump –   600 000 ms  (10 minutes)
     *   devices  –   600 000 ms  (10 minutes)
     */
    intervals: {
      weather: parseInt(process.env.TADO_POLL_INTERVAL_WEATHER, 10) || 3_600_000,
      rooms: parseInt(process.env.TADO_POLL_INTERVAL_ROOMS, 10) || 600_000,
      heatPump: parseInt(process.env.TADO_POLL_INTERVAL_HEATPUMP, 10) || 600_000,
      devices: parseInt(process.env.TADO_POLL_INTERVAL_DEVICES, 10) || 600_000,
    }
  },

  influx: {
    url: process.env.INFLUX_URL,
    token: process.env.INFLUX_TOKEN,
    org: process.env.INFLUX_ORG,
    bucket: process.env.INFLUX_BUCKET
  }
});
