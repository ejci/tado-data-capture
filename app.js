/**
 * app.js – Application entry point
 *
 * Responsibilities:
 *  1. Start an Express HTTP server that serves:
 *       - The static dashboard UI  (public/)
 *       - REST endpoints for OAuth2 login flow  (/api/login/*)
 *       - A health/status endpoint  (/health)
 *  2. Run a background polling loop that periodically fetches data from the
 *     Tado API and writes it to InfluxDB.
 *
 * Polling architecture:
 *  A single `setInterval` fires every 60 seconds.  On each tick, `shouldPoll`
 *  checks whether enough time has elapsed since the last successful run for
 *  each data type (weather / rooms / heatPump / devices).  This allows each
 *  type to have its own independent interval without spawning multiple timers.
 *
 * Error handling:
 *  Errors within individual poll sections (weather, rooms, etc.) are caught
 *  per-section so one failure does not abort the remaining sections.  All
 *  errors are also written to InfluxDB as `errors` measurements for
 *  observability in Grafana dashboards.
 */

'use strict';

const express = require('express');
const path = require('path');
const config = require('./config');
const tado = require('./tado');
const influx = require('./influx');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

const app = express();

// Serve the dashboard UI from the `public/` directory.
app.use(express.static(path.join(__dirname, 'public')));

// Parse JSON request bodies (used by POST routes, if extended in future).
app.use(express.json());

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

/**
 * ISO-8601 timestamp of the last *successful* poll cycle completion.
 * Exposed via /health so the dashboard can display it.
 * @type {string|null}
 */
let lastUpdate = null;

/**
 * Running count of Tado API calls made in the current 24-hour window.
 * Tado imposes undocumented rate limits, so tracking this helps spot issues.
 * @type {number}
 */
let apiCalls = 0;

// Reset the API call counter at midnight each day.
setInterval(() => { apiCalls = 0; }, 24 * 60 * 60 * 1000);

/**
 * Increment the API call counter.
 * Called once before each Tado API request.
 */
function trackCall() {
    apiCalls++;
}

// ---------------------------------------------------------------------------
// Routes – Auth flow
//
// Tado uses the OAuth2 Device Authorization Grant (RFC 8628).
// The typical sequence is:
//   1. Frontend calls POST /api/login/start  → receives user_code + verification URL.
//   2. User visits the verification URL and logs in.
//   3. Frontend polls GET /api/login/poll?code=<device_code> until `access_token`
//      is returned, then the dashboard is shown.
// ---------------------------------------------------------------------------

/**
 * POST /api/login/start
 *
 * Triggers the Device Authorization Grant flow by requesting a `device_code`
 * from Tado.  Returns the full Tado response so the frontend can display the
 * verification URL and user code.
 */
app.post('/api/login/start', async (req, res) => {
    try {
        const result = await tado.startAuth();
        res.json(result);
    } catch (e) {
        logger.error({ err: e.message }, 'POST /api/login/start failed');
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/login/poll?code=<device_code>
 *
 * Polls the Tado token endpoint with the given device code.
 * Returns `{ access_token, ... }` when the user has completed login,
 * or `{ error: 'authorization_pending' }` while still waiting.
 */
app.get('/api/login/poll', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).json({ error: 'Missing required query parameter: code' });
    }

    try {
        const result = await tado.pollToken(code);
        res.json(result);
    } catch (e) {
        logger.error({ err: e.message }, 'GET /api/login/poll failed');
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Routes – Observability
// ---------------------------------------------------------------------------

/**
 * GET /health
 *
 * Returns a JSON snapshot of the application state for the dashboard UI and
 * external health checks (e.g. Docker HEALTHCHECK, Uptime Kuma).
 *
 * Response shape:
 * {
 *   status: 'UP',
 *   authenticated: boolean,
 *   influxConnected: boolean,
 *   lastUpdate: string|null,
 *   apiCalls24h: number,
 *   intervals: { weather: ms, rooms: ms, heatPump: ms, devices: ms },
 *   lastRun: { weather: epochMs, rooms: epochMs, ... }
 * }
 */
app.get('/health', async (req, res) => {
    const [authenticated, influxConnected] = await Promise.all([
        tado.checkToken(),
        influx.checkHealth()
    ]);

    res.json({
        status: 'UP',
        authenticated,
        influxConnected,
        lastUpdate,
        apiCalls24h: apiCalls,
        intervals: config.tado.intervals,
        lastRun
    });
});

// ---------------------------------------------------------------------------
// Polling – interval tracker
//
// `lastRun` stores the unix timestamp (ms) of the most recent execution for
// each polling type.  `shouldPoll` compares this against the configured
// interval to decide whether it is time to fetch data again.
//
// On first run every key is absent from the map, so all sections fire
// immediately during the first polling tick.
// ---------------------------------------------------------------------------

/** @type {Record<string, number>} Maps poll type → last-run epoch ms. */
const lastRun = {};

/**
 * Decide whether a given polling type is due for another execution.
 *
 * Side effect: if the answer is *yes*, `lastRun[type]` is updated to `now` so
 * the next call correctly counts from this execution.
 *
 * @param {'weather'|'rooms'|'heatPump'|'devices'} type - Which data type to check.
 * @returns {boolean} true when the configured interval has elapsed.
 */
function shouldPoll(type) {
    const now = Date.now();
    const interval = config.tado.intervals[type];
    const last = lastRun[type] ?? 0; // Default to 0 so first run always fires.

    if (now - last >= interval) {
        lastRun[type] = now;
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Polling – main loop
// ---------------------------------------------------------------------------

/**
 * Execute one full polling cycle across all enabled data types for every home.
 *
 * The function is intentionally coarse-grained:
 *  - Called every 60 seconds by `setInterval`.
 *  - Uses `shouldPoll` to skip data types whose interval has not yet elapsed.
 *  - Each section (weather, rooms, heatPump, devices) has its own try/catch so
 *    a failure in one section does not prevent the others from running.
 *
 * @returns {Promise<void>}
 */
async function runPolling() {
    // Skip the entire cycle if no valid token is present.
    const authenticated = await tado.checkToken();
    if (!authenticated) {
        logger.warn('Not authenticated – skipping poll cycle. Visit the dashboard to log in.');
        return;
    }

    try {
        // Fetch the user profile to discover which homes to poll.
        // A Tado account can have more than one home (e.g. main house + holiday flat).
        trackCall();
        const me = await tado.getMe();
        if (!me?.homes?.length) {
            logger.warn('No homes found for this Tado account');
            return;
        }

        for (const home of me.homes) {
            const homeId = home.id;
            logger.info({ homeId, homeName: home.name }, 'Processing home');

            // ── 1. Weather ──────────────────────────────────────────────────────
            if (shouldPoll('weather')) {
                try {
                    logger.info({ homeId }, 'Polling weather');
                    trackCall();
                    const weather = await tado.getWeather(homeId);

                    if (config.dryRun) {
                        logger.debug({ homeId, data: weather }, 'Dry run: weather payload');
                    }

                    await influx.writeMeasurement('weather', { homeId }, {
                        // Solar intensity may be absent at night – default to 0.
                        solarIntensityPercentage: weather.solarIntensity?.percentage ?? 0,
                        // outsideTemperature is always present in a valid weather response.
                        outsideTemperature: weather.outsideTemperature.celsius,
                        // weatherState is a string such as 'SUNNY', 'CLOUDY', 'NIGHT'.
                        weatherState: weather.weatherState.value
                    });
                } catch (e) {
                    logger.error({ homeId, err: e.message, context: 'weather' }, 'Error polling weather');
                    await influx.writeMeasurement('errors', { type: 'polling', context: 'weather' }, { message: e.message });
                }
            }

            // ── 2. Rooms ─────────────────────────────────────────────────────────
            if (shouldPoll('rooms')) {
                try {
                    logger.info({ homeId }, 'Polling rooms');
                    trackCall();
                    const rooms = await tado.getRooms(homeId);

                    if (config.dryRun) {
                        logger.debug({ homeId, data: rooms }, 'Dry run: rooms payload');
                    }

                    for (const room of rooms) {
                        // Build the fields object incrementally – only include a field when
                        // the data is actually present so we do not write `undefined` to Influx.
                        const fields = {};

                        if (room.heatingPower?.percentage !== undefined) {
                            fields.heatingPowerPercentage = room.heatingPower.percentage;
                        }
                        if (room.sensorDataPoints?.humidity?.percentage !== undefined) {
                            fields.humidity = room.sensorDataPoints.humidity.percentage;
                        }
                        if (room.sensorDataPoints?.insideTemperature?.value !== undefined) {
                            fields.temperature = room.sensorDataPoints.insideTemperature.value;
                        }
                        if (room.setting?.temperature?.value !== undefined) {
                            fields.setTemperature = room.setting.temperature.value;
                        }

                        // Only write to InfluxDB when we have at least one measurable field.
                        if (Object.keys(fields).length > 0) {
                            await influx.writeMeasurement(
                                'rooms',
                                { homeId, roomId: room.id, roomName: room.name },
                                fields
                            );
                        }
                    }
                } catch (e) {
                    logger.error({ homeId, err: e.message, context: 'rooms' }, 'Error polling rooms');
                    await influx.writeMeasurement('errors', { type: 'polling', context: 'rooms' }, { message: e.message });
                }
            }

            // ── 3. Heat Pump ─────────────────────────────────────────────────────
            if (shouldPoll('heatPump')) {
                try {
                    logger.info({ homeId }, 'Polling heat pump');
                    trackCall();
                    const heatPump = await tado.getHeatPump(homeId);

                    if (config.dryRun) {
                        logger.debug({ homeId, data: heatPump }, 'Dry run: heat pump payload');
                    }

                    const fields = {};

                    // Requested heating temperature (the setpoint the heat pump targets).
                    if (heatPump.heating?.setting?.temperature?.value !== undefined) {
                        fields.heatPumpSetTemperature = heatPump.heating.setting.temperature.value;
                    }

                    if (heatPump.domesticHotWater) {
                        const dhw = heatPump.domesticHotWater;

                        // Actual measured water temperature in the hot water cylinder.
                        if (dhw.currentTemperatureInCelsius !== undefined) {
                            fields.hotWaterCurrentTemperature = dhw.currentTemperatureInCelsius;
                        }

                        // Target temperature for the hot water schedule block currently active.
                        if (dhw.currentBlockSetpoint?.setpointValue?.value !== undefined) {
                            fields.hotWaterSetTemperature = parseFloat(dhw.currentBlockSetpoint.setpointValue.value);
                        }
                    }

                    if (Object.keys(fields).length > 0) {
                        await influx.writeMeasurement('heat_pump', { homeId }, fields);
                    }
                } catch (e) {
                    logger.error({ homeId, err: e.message, context: 'heatPump' }, 'Error polling heat pump');
                    await influx.writeMeasurement('errors', { type: 'polling', context: 'heatPump' }, { message: e.message });
                }
            }

            // ── 4. Devices ───────────────────────────────────────────────────────
            if (shouldPoll('devices')) {
                try {
                    logger.info({ homeId }, 'Polling devices');
                    trackCall();
                    const devicesData = await tado.getRoomsAndDevices(homeId);

                    if (config.dryRun) {
                        logger.debug({ homeId, data: devicesData }, 'Dry run: devices payload');
                    }

                    // The response groups devices by room; iterate both levels.
                    for (const room of devicesData.rooms ?? []) {
                        for (const device of room.devices ?? []) {
                            // Only write temperature data when the device has a valid reading.
                            // `temperatureAsMeasured` can be null for devices that report no
                            // sensor data (e.g. smart radiator valves without a sensor).
                            if (device.temperatureAsMeasured != null) {
                                await influx.writeMeasurement(
                                    'devices',
                                    {
                                        homeId,
                                        roomName: room.roomName,
                                        serialNumber: device.serialNumber,
                                        deviceType: device.type
                                    },
                                    {
                                        temperatureAsMeasured: device.temperatureAsMeasured,
                                        // Calibration offset applied by the user in the Tado app.
                                        temperatureOffset: device.temperatureOffset ?? 0
                                    }
                                );
                            }
                        }
                    }
                } catch (e) {
                    logger.error({ homeId, err: e.message, context: 'devices' }, 'Error polling devices');
                    await influx.writeMeasurement('errors', { type: 'polling', context: 'devices' }, { message: e.message });
                }
            }
        } // end for (home of me.homes)

        lastUpdate = new Date().toISOString();
        logger.info({ lastUpdate }, 'Poll cycle completed');

    } catch (e) {
        // Top-level catch handles unexpected errors (e.g. getMe() failing).
        logger.error({ err: e.message }, 'Unexpected error during poll cycle');
        await influx.writeMeasurement('errors', { type: 'polling', context: 'top-level' }, { message: e.message });
    }
}

// ---------------------------------------------------------------------------
// Polling scheduler
//
// The main loop runs every 60 seconds.  Each tick calls `shouldPoll` per
// data type so the actual fetch only happens when the configured interval has
// elapsed.  A 5-second delay before the first tick gives the Express server
// time to fully start before any network calls are made.
// ---------------------------------------------------------------------------

// Kick off the first poll 5 seconds after startup.
setTimeout(runPolling, 5_000);

// Then check every 60 seconds whether any interval is due.
setInterval(runPolling, 60_000);

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// Give in-flight requests and any buffered InfluxDB writes a chance to
// complete before the process exits (important in Docker / Kubernetes).
// ---------------------------------------------------------------------------
process.on('SIGTERM', () => {
    logger.info('Received SIGTERM – shutting down gracefully');
    process.exit(0);
});
process.on('SIGINT', () => {
    logger.info('Received SIGINT – shutting down gracefully');
    process.exit(0);
});

// ---------------------------------------------------------------------------
// Start HTTP server
// ---------------------------------------------------------------------------

app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server started');
    if (config.dryRun) {
        logger.warn('DRY RUN MODE enabled — data will NOT be written to InfluxDB');
    }
});
