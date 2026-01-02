const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const config = require('./config');

let writeApi;
let queryApi;

try {
    const influxDB = new InfluxDB({ url: config.influx.url, token: config.influx.token });
    writeApi = influxDB.getWriteApi(config.influx.org, config.influx.bucket);
    queryApi = influxDB.getQueryApi(config.influx.org);
} catch (error) {
    console.error('Error initializing InfluxDB client:', error);
}

/**
 * Write a measurement to InfluxDB
 * @param {string} measurement - The name of the measurement
 * @param {object} tags - Key-value pair of tags
 * @param {object} fields - Key-value pair of fields (values)
 * @param {Date} timestamp - Optional timestamp
 */
async function writeMeasurement(measurement, tags, fields, timestamp) {
    if (config.dryRun) {
        console.log(`[DRY RUN] Would write to InfluxDB: ${measurement}`, { tags, fields, timestamp });
        return;
    }

    if (!writeApi) {
        console.error('InfluxDB Write API not initialized. Cannot write data.');
        return;
    }

    try {
        const point = new Point(measurement);

        for (const [key, value] of Object.entries(tags)) {
            point.tag(key, value);
        }

        for (const [key, value] of Object.entries(fields)) {
            if (typeof value === 'boolean') point.booleanField(key, value);
            else if (typeof value === 'number') point.floatField(key, value);
            else point.stringField(key, value);
        }

        if (timestamp) {
            point.timestamp(timestamp);
        }

        writeApi.writePoint(point);
        await writeApi.flush();
        // console.log(`Written ${measurement} to InfluxDB`);
    } catch (error) {
        console.error(`Error writing to InfluxDB (${measurement}):`, error);
    }
}

/**
 * Check InfluxDB health
 * @returns {Promise<boolean>}
 */
async function checkHealth() {
    if (config.dryRun) return true;
    if (!writeApi) return false;
    // Simple check (maybe improved later)
    return true;
}

module.exports = {
    writeMeasurement,
    checkHealth
};
