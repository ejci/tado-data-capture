const express = require('express');
const path = require('path');
const config = require('./config');
const tado = require('./tado');
const influx = require('./influx');

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
        console.log("Not authenticated. Waiting for login...");
        return;
    }

    try {
        trackCall();
        const me = await tado.getMe();
        if (!me || !me.homes) return;

        for (const home of me.homes) {
            const homeId = home.id;
            console.log(`Polling home ${homeId}...`);

            // 1. Weather
            if (shouldPoll('weather')) {
                try {
                    console.log(new Date().toISOString(), `Polling weather for home ${homeId}...`);
                    trackCall();
                    const weather = await tado.getWeather(homeId);
                    if (config.dryRun) {
                        console.log('--- [Dry Run] Weather API Result ---');
                        console.dir(weather, { depth: null, colors: true });
                    }
                    await influx.writeMeasurement('weather', { homeId }, {
                        solarIntensityPercentage: (weather.solarIntensity && weather.solarIntensity.percentage) || 0,
                        outsideTemperature: weather.outsideTemperature.celsius,
                        weatherState: weather.weatherState.value
                    });
                } catch (e) {
                    console.error("Error polling weather:", e.message);
                }
            }

            // 2. Rooms
            if (shouldPoll('rooms')) {
                try {
                    console.log(new Date().toISOString(), `Polling rooms for home ${homeId}...`);
                    trackCall();
                    const rooms = await tado.getRooms(homeId);
                    if (config.dryRun) {
                        console.log('--- [Dry Run] Rooms API Result ---');
                        console.dir(rooms, { depth: null, colors: true });
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
                    console.error("Error polling rooms:", e.message);
                }
            }

            // 3. Heat Pump
            if (shouldPoll('heatPump')) {
                try {
                    console.log(new Date().toISOString(), `Polling heat pump for home ${homeId}...`);
                    trackCall();
                    const heatPump = await tado.getHeatPump(homeId);
                    if (config.dryRun) {
                        console.log('--- [Dry Run] Heat Pump API Result ---');
                        console.dir(heatPump, { depth: null, colors: true });
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
                    console.error("Error polling heat pump:", e.message);
                }
            }


        }

        lastUpdate = new Date().toISOString();
        console.log(`Polling completed at ${lastUpdate}`);

    } catch (e) {
        console.error("Error during polling:", e.message);
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
    console.log(`Server running on port ${config.port}`);
    if (config.dryRun) {
        console.log("!!! DRY RUN MODE ENABLED - No data will be written to InfluxDB !!!");
    }
});
