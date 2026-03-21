jest.mock('dotenv', () => ({ config: jest.fn() }));

describe('config.js', () => {
    let originalEnv;

    beforeEach(() => {
        // Save original environment
        originalEnv = process.env;
        // Make a copy to avoid mutating the original directly in all tests
        process.env = { ...originalEnv };
        
        // Clear require cache so config is re-evaluated
        jest.resetModules();
    });

    afterEach(() => {
        // Restore original environment
        process.env = originalEnv;
    });

    it('should load default intervals when optional env vars are missing', () => {
        // Remove optional intervals
        delete process.env.TADO_POLL_INTERVAL_WEATHER;
        delete process.env.TADO_POLL_INTERVAL_ROOMS;
        delete process.env.TADO_POLL_INTERVAL_HEATPUMP;
        delete process.env.TADO_POLL_INTERVAL_DEVICES;

        const config = require('../config');

        expect(config.tado.intervals.weather).toBe(3600000);
        expect(config.tado.intervals.rooms).toBe(600000);
        expect(config.tado.intervals.heatPump).toBe(600000);
        expect(config.tado.intervals.devices).toBe(600000);
    });

    it('should parse custom interval values correctly', () => {
        process.env.TADO_POLL_INTERVAL_WEATHER = '500';
        process.env.TADO_POLL_INTERVAL_ROOMS = '600';
        process.env.TADO_POLL_INTERVAL_HEATPUMP = '700';
        process.env.TADO_POLL_INTERVAL_DEVICES = '800';

        const config = require('../config');

        expect(config.tado.intervals.weather).toBe(500);
        expect(config.tado.intervals.rooms).toBe(600);
        expect(config.tado.intervals.heatPump).toBe(700);
        expect(config.tado.intervals.devices).toBe(800);
    });

    it('should correctly set required configurations based on env vars', () => {
        const config = require('../config');
        
        expect(config.tado.clientId).toBe('test_client_id');
        expect(config.influx.url).toBe('http://localhost:8086');
        expect(config.influx.token).toBe('test_token');
        expect(config.influx.org).toBe('test_org');
        expect(config.influx.bucket).toBe('test_bucket');
    });

    it('should exit process if required environment variables are missing', () => {
        delete process.env.TADO_CLIENT_ID;

        // Mock process.exit and process.stderr.write
        const exitMock = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit: ${code}`);
        });
        const stderrMock = jest.spyOn(process.stderr, 'write').mockImplementation(() => {});

        expect(() => {
            require('../config');
        }).toThrow('process.exit: 1');

        expect(exitMock).toHaveBeenCalledWith(1);
        expect(stderrMock).toHaveBeenCalledWith(expect.stringContaining('[config] Missing required environment variables: TADO_CLIENT_ID'));

        exitMock.mockRestore();
        stderrMock.mockRestore();
    });
});
