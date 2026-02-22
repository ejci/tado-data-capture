/**
 * logger.js
 *
 * Configures and exports a single application-wide Pino logger instance.
 *
 * Pino writes newline-delimited JSON by default, which is ideal for
 * Grafana Loki ingestion (structured log fields become queryable labels).
 *
 * Log level is controlled by the TADO_LOG_LEVEL environment variable.
 * Valid values (in ascending severity): trace | debug | info | warn | error | fatal
 * Default: info
 *
 * In development, pipe stdout through `pino-pretty` for human-readable output:
 *   node app.js | npx pino-pretty
 * (The `npm run dev` script does this automatically via --watch.)
 */
const pino = require('pino');

const logger = pino({
    /** Read log level from env; fall back to 'info' for production safety. */
    level: process.env.TADO_LOG_LEVEL || 'info',

    /**
     * Base fields included in every log line.
     * `service` helps Loki / Grafana identify the log source when multiple
     * services write to the same bucket.
     */
    base: {
        service: 'tado-data-capture'
    },

    /** Use ISO-8601 timestamps so Loki can parse them without extra config. */
    timestamp: pino.stdTimeFunctions.isoTime
});

module.exports = logger;
