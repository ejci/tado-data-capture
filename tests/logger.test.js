const logger = require('../logger');

describe('logger.js', () => {
    it('should be an object with logging methods', () => {
        expect(typeof logger).toBe('object');
        expect(typeof logger.info).toBe('function');
        expect(typeof logger.error).toBe('function');
        expect(typeof logger.warn).toBe('function');
        expect(typeof logger.debug).toBe('function');
    });

    it('should have a default property indicating it is a pino logger (or similar core properties)', () => {
        expect(logger.level).toBeDefined();
    });
});
