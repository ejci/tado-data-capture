const pino = require('pino');

const logger = pino({
    level: process.env.TADO_LOG_LEVEL || 'info',
    base: {
        service: 'tado-data-capture'
    },
    timestamp: pino.stdTimeFunctions.isoTime
});

module.exports = logger;
