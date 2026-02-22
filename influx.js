/**
 * influx.js
 *
 * Handles all communication with InfluxDB v2 using the official
 * @influxdata/influxdb-client library.
 *
 * Responsibilities:
 *  - Initialise the InfluxDB write API client at startup.
 *  - Provide `writeMeasurement()`, a typed wrapper that converts plain objects
 *    into InfluxDB Line Protocol points.
 *  - Provide `checkHealth()` to verify the connection is alive by calling the
 *    InfluxDB /health HTTP endpoint (used by /health and the dashboard UI).
 *
 * In dry-run mode every write is suppressed and only logged at DEBUG level so
 * the application can be tested without a real InfluxDB instance.
 */

'use strict';

const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Initialise the InfluxDB write API
// Created once at module load and reused for all writes – avoids repeated
// connection setup overhead on each polling tick.
// ---------------------------------------------------------------------------

/** @type {import('@influxdata/influxdb-client').WriteApi | undefined} */
let writeApi;

try {
    const influxDB = new InfluxDB({ url: config.influx.url, token: config.influx.token });

    /**
     * writeApi – pushes Line Protocol points to the configured org/bucket.
     * Precision defaults to nanoseconds; most Tado fields do not need sub-second
     * precision so this is fine.
     */
    writeApi = influxDB.getWriteApi(config.influx.org, config.influx.bucket);
} catch (error) {
    logger.error({ err: error.message }, 'Failed to initialise InfluxDB client');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a single measurement point to InfluxDB.
 *
 * The function automatically infers the correct InfluxDB field type from the
 * JavaScript value type:
 *   - boolean → booleanField
 *   - number  → floatField
 *   - other   → stringField (value coerced via String())
 *
 * @param {string}               measurement - InfluxDB measurement name (table).
 * @param {Record<string,*>}     tags        - Tag key/value pairs (indexed, low cardinality).
 * @param {Record<string,*>}     fields      - Field key/value pairs (the actual measured data).
 * @param {Date|number}          [timestamp] - Optional point timestamp; defaults to "now".
 * @returns {Promise<void>}
 */
async function writeMeasurement(measurement, tags, fields, timestamp) {
    // Suppress writes in dry-run mode – just log what would have been sent.
    if (config.dryRun) {
        logger.debug({ measurement, tags, fields, timestamp }, 'Dry run: skipping InfluxDB write');
        return;
    }

    if (!writeApi) {
        // The write API is undefined when the client failed to initialise at startup.
        logger.error('InfluxDB Write API not initialised – cannot write measurement');
        return;
    }

    try {
        const point = new Point(measurement);

        // Tags are string-indexed metadata; they are indexed by InfluxDB and
        // suitable for filtering/grouping (e.g. homeId, roomName).
        for (const [key, value] of Object.entries(tags)) {
            point.tag(key, String(value));
        }

        // Fields hold the actual values.  Type inference ensures proper storage.
        for (const [key, value] of Object.entries(fields)) {
            if (typeof value === 'boolean') point.booleanField(key, value);
            else if (typeof value === 'number') point.floatField(key, value);
            else point.stringField(key, String(value));
        }

        // Only set a custom timestamp when explicitly provided; otherwise InfluxDB
        // uses the server's current time, which is usually what we want.
        if (timestamp) {
            point.timestamp(timestamp);
        }

        writeApi.writePoint(point);

        // flush() sends any buffered points immediately.  For low-frequency polling
        // this is fine; a batching strategy could be considered for higher volumes.
        await writeApi.flush();
    } catch (error) {
        logger.error({ measurement, err: error.message }, 'Error writing to InfluxDB');
    }
}

/**
 * Check whether InfluxDB is reachable by calling its `/health` HTTP endpoint.
 *
 * InfluxDB v2 responds with `{ status: 'pass' }` when healthy.  Any network
 * error or non-'pass' status is treated as unhealthy.
 *
 * @returns {Promise<boolean>} true if InfluxDB responds with status "pass".
 */
async function checkHealth() {
    // In dry-run mode there is no real InfluxDB to check.
    if (config.dryRun) return true;

    // If the write client never initialised, assume not healthy.
    if (!writeApi) return false;

    try {
        const response = await axios.get(`${config.influx.url}/health`, { timeout: 3000 });
        return response.data?.status === 'pass';
    } catch {
        // Any network or HTTP error means the service is not reachable.
        return false;
    }
}

module.exports = { writeMeasurement, checkHealth };
