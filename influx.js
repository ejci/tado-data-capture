const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const config = require('./config');
const logger = require('./logger');

let writeApi;
let queryApi;

try {
    const influxDB = new InfluxDB({ url: config.influx.url, token: config.influx.token });
    writeApi = influxDB.getWriteApi(config.influx.org, config.influx.bucket);
    queryApi = influxDB.getQueryApi(config.influx.org);
} catch (error) {
    logger.error({ err: error.message }, 'Error initializing InfluxDB client');
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
        logger.debug({ measurement, tags, fields, timestamp }, 'Dry run: would write to InfluxDB');
        return;
    }

    if (!writeApi) {
        logger.error('InfluxDB Write API not initialized. Cannot write data.');
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
    } catch (error) {
        logger.error({ measurement, err: error.message }, 'Error writing to InfluxDB');
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
