require('dotenv').config();

const requiredEnv = [
  'TADO_CLIENT_ID',
  'INFLUX_URL',
  'INFLUX_TOKEN',
  'INFLUX_ORG',
  'INFLUX_BUCKET'
];

// Validate required environment variables
const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  dryRun: process.env.TADO_DRY_RUN === 'true',
  port: process.env.TADO_LOGIN_PORT || 3000,
  tado: {
    clientId: process.env.TADO_CLIENT_ID,
    intervals: {
      weather: parseInt(process.env.TADO_POLL_INTERVAL_WEATHER) || 3600000, // 1 hour
      rooms: parseInt(process.env.TADO_POLL_INTERVAL_ROOMS) || 600000,     // 10 mins
      heatPump: parseInt(process.env.TADO_POLL_INTERVAL_HEATPUMP) || 600000 // 10 mins
    }
  },
  influx: {
    url: process.env.INFLUX_URL,
    token: process.env.INFLUX_TOKEN,
    org: process.env.INFLUX_ORG,
    bucket: process.env.INFLUX_BUCKET
  }
};
