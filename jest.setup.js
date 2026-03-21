// jest.setup.js
// Inject dummy environment variables required by config.js so it
// does not call process.exit(1) upon being imported during tests.

process.env.TADO_CLIENT_ID = 'test_client_id';
process.env.INFLUX_URL = 'http://localhost:8086';
process.env.INFLUX_TOKEN = 'test_token';
process.env.INFLUX_ORG = 'test_org';
process.env.INFLUX_BUCKET = 'test_bucket';

// Additional mock variables
process.env.TADO_LOGIN_PORT = '3000';
process.env.TADO_POLL_INTERVAL_WEATHER = '3600000';
process.env.TADO_POLL_INTERVAL_ROOMS = '600000';
process.env.TADO_POLL_INTERVAL_HEATPUMP = '600000';
process.env.TADO_POLL_INTERVAL_DEVICES = '600000';
