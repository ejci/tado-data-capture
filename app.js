const express = require('express');
const path = require('path');
const config = require('./config');
const tado = require('./tado');
const influx = require('./influx');
const logger = require('./logger');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Application State
let lastUpdate = null;
let apiCalls = 0; // Reset daily? Tado has API limits, good to track.
// Reset API calls every 24h
setInterval(() => { apiCalls = 0; }, 24 * 60 * 60 * 1000);

function trackCall() {
    apiCalls++;
}

// Routes


app.post('/api/login/start', async (req, res) => {
    try {
        const result = await tado.startAuth();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/login/poll', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    try {
        const result = await tado.pollToken(code);
        if (result.access_token) {
            // Valid token, trigger immediate update?
            // Maybe wait for next interval
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Polling Logic
async function runPolling() {
    const authenticated = await tado.checkToken();
    if (!authenticated) {
        logger.warn('Not authenticated. Waiting for login...');
        return;
    }

    try {
        trackCall();
        const me = await tado.getMe();
        if (!me || !me.homes) return;

        for (const home of me.homes) {
            const homeId = home.id;
            logger.info({ homeId }, 'Polling home');

            // 1. Weather
            if (shouldPoll('weather')) {
                try {
                    logger.info({ homeId }, 'Polling weather');
                    trackCall();
                    const weather = await tado.getWeather(homeId);
                    if (config.dryRun) {
                        logger.debug({ homeId, data: weather }, 'Dry run: weather API result');
                    }
                    await influx.writeMeasurement('weather', { homeId }, {
                        solarIntensityPercentage: (weather.solarIntensity && weather.solarIntensity.percentage) || 0,
                        outsideTemperature: weather.outsideTemperature.celsius,
                        weatherState: weather.weatherState.value
                    });
                } catch (e) {
                    logger.error({ homeId, err: e.message, context: 'weather' }, 'Error polling weather');
                    await influx.writeMeasurement('errors', { type: 'polling' }, { message: e.message });
                }
            }

            // 2. Rooms
            if (shouldPoll('rooms')) {
                try {
                    logger.info({ homeId }, 'Polling rooms');
                    trackCall();
                    const rooms = await tado.getRooms(homeId);
                    if (config.dryRun) {
                        logger.debug({ homeId, data: rooms }, 'Dry run: rooms API result');
                    }

                    for (const room of rooms) {
                        const fields = {};
                        if (room.heatingPower) fields.heatingPowerPercentage = room.heatingPower.percentage;
                        // Check deep structure safely
                        if (room.sensorDataPoints && room.sensorDataPoints.humidity) {
                            fields.humidity = room.sensorDataPoints.humidity.percentage;
                        }
                        if (room.sensorDataPoints && room.sensorDataPoints.insideTemperature) {
                            fields.temperature = room.sensorDataPoints.insideTemperature.value;
                        }
                        if (room.setting && room.setting.temperature) {
                            fields.setTemperature = room.setting.temperature.value;
                        }

                        if (Object.keys(fields).length > 0) {
                            await influx.writeMeasurement('rooms', { homeId, roomId: room.id, roomName: room.name }, fields);
                        }
                    }
                } catch (e) {
                    logger.error({ homeId, err: e.message, context: 'rooms' }, 'Error polling rooms');
                    await influx.writeMeasurement('errors', { type: 'polling' }, { message: e.message });
                }
            }

            // 3. Heat Pump
            if (shouldPoll('heatPump')) {
                try {
                    logger.info({ homeId }, 'Polling heat pump');
                    trackCall();
                    const heatPump = await tado.getHeatPump(homeId);
                    if (config.dryRun) {
                        logger.debug({ homeId, data: heatPump }, 'Dry run: heat pump API result');
                    }

                    const fields = {};

                    // heating.setting.temperature.value -> heatPumpSetTemperature
                    if (heatPump.heating && heatPump.heating.setting && heatPump.heating.setting.temperature) {
                        fields.heatPumpSetTemperature = heatPump.heating.setting.temperature.value;
                    }

                    // domesticHotWater.currentTemperatureInCelsius -> hotWaterCurrentTemperatureInCelsius
                    if (heatPump.domesticHotWater) {
                        if (heatPump.domesticHotWater.currentTemperatureInCelsius !== undefined) {
                            fields.hotWaterCurrentTemperatureInCelsius = heatPump.domesticHotWater.currentTemperatureInCelsius;
                        }

                        // domesticHotWater.currentBlockSetpoint.setpointValue.value -> hotWaterSetTemperatureInCelsius
                        if (heatPump.domesticHotWater.currentBlockSetpoint &&
                            heatPump.domesticHotWater.currentBlockSetpoint.setpointValue) {
                            fields.hotWaterSetTemperatureInCelsius = parseFloat(heatPump.domesticHotWater.currentBlockSetpoint.setpointValue.value);
                        }
                    }

                    if (Object.keys(fields).length > 0) {
                        await influx.writeMeasurement('heat_pump', { homeId }, fields);
                    }
                } catch (e) {
                    logger.error({ homeId, err: e.message, context: 'heatPump' }, 'Error polling heat pump');
                    await influx.writeMeasurement('errors', { type: 'polling' }, { message: e.message });
                }
            }

            // 4. Devices
            if (shouldPoll('devices')) {
                try {
                    logger.info({ homeId }, 'Polling devices');
                    trackCall();
                    const devicesData = await tado.getRoomsAndDevices(homeId);
                    if (config.dryRun) {
                        logger.debug({ homeId, data: devicesData }, 'Dry run: devices API result');
                    }

                    if (devicesData.rooms) {
                        for (const room of devicesData.rooms) {
                            if (room.devices) {
                                for (const device of room.devices) {
                                    if (device.temperatureAsMeasured !== undefined && device.temperatureAsMeasured !== null) {
                                        const fields = {
                                            temperatureAsMeasured: device.temperatureAsMeasured,
                                            temperatureOffset: device.temperatureOffset || 0
                                        };
                                        const tags = {
                                            homeId,
                                            roomName: room.roomName,
                                            serialNumber: device.serialNumber,
                                            deviceType: device.type
                                        };
                                        await influx.writeMeasurement('devices', tags, fields);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    logger.error({ homeId, err: e.message, context: 'devices' }, 'Error polling devices');
                    await influx.writeMeasurement('errors', { type: 'polling' }, { message: e.message });
                }
            }


        }

        lastUpdate = new Date().toISOString();
        logger.info({ lastUpdate }, 'Polling completed');

    } catch (e) {
        logger.error({ err: e.message }, 'Error during polling');
        await influx.writeMeasurement('errors', { type: 'polling' }, { message: e.message });
    }
}

// Simple interval manager
const lastRun = {};
function shouldPoll(type) {
    const now = Date.now();
    const interval = config.tado.intervals[type];
    if (!lastRun[type] || now - lastRun[type] >= interval) {
        lastRun[type] = now;
        return true;
    }
    return false;
}

// Routes
app.get('/health', async (req, res) => {
    const authenticated = await tado.checkToken();
    const influxConnected = await influx.checkHealth();
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
setInterval(runPolling, 60000); // Check every minute if any interval is due
// Initial run delay
setTimeout(runPolling, 5000);


app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server running');
    if (config.dryRun) {
        logger.warn('DRY RUN MODE ENABLED — no data will be written to InfluxDB');
    }
});
