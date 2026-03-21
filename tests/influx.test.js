const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const axios = require('axios');
const logger = require('../logger');

jest.mock('@influxdata/influxdb-client', () => {
    const mockWritePoint = jest.fn();
    const mockFlush = jest.fn().mockResolvedValue();
    return {
        InfluxDB: jest.fn().mockImplementation(() => ({
            getWriteApi: jest.fn().mockReturnValue({
                writePoint: mockWritePoint,
                flush: mockFlush
            })
        })),
        Point: jest.fn().mockImplementation(function(measurement) {
            this.measurement = measurement;
            this.tag = jest.fn().mockReturnThis();
            this.booleanField = jest.fn().mockReturnThis();
            this.floatField = jest.fn().mockReturnThis();
            this.stringField = jest.fn().mockReturnThis();
            this.timestamp = jest.fn().mockReturnThis();
        })
    };
});
jest.mock('axios');
jest.mock('../logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn()
}));

describe('influx.js', () => {
    let influx;
    let mockWriteApi;
    
    beforeAll(() => {
        // Load the module once for standard tests
        influx = require('../influx');
        
        // Find the injected mock WriteApi
        const influxInstance = new InfluxDB();
        mockWriteApi = influxInstance.getWriteApi();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('writeMeasurement', () => {
        it('should correctly infer types and construct points', async () => {
            const tags = { homeId: 123, room: 'Living Room' };
            const fields = { temperature: 21.5, heating: true, mode: 'AUTO' };
            const ts = new Date('2024-01-01T12:00:00Z');

            await influx.writeMeasurement('test_measurement', tags, fields, ts);

            expect(Point).toHaveBeenCalledWith('test_measurement');
            // Get the constructor instance:
            const mockPoint = Point.mock.instances[0];
            
            expect(mockPoint.tag).toHaveBeenCalledWith('homeId', '123');
            expect(mockPoint.tag).toHaveBeenCalledWith('room', 'Living Room');
            expect(mockPoint.floatField).toHaveBeenCalledWith('temperature', 21.5);
            expect(mockPoint.booleanField).toHaveBeenCalledWith('heating', true);
            expect(mockPoint.stringField).toHaveBeenCalledWith('mode', 'AUTO');
            expect(mockPoint.timestamp).toHaveBeenCalledWith(ts);

            expect(mockWriteApi.writePoint).toHaveBeenCalledWith(mockPoint);
            expect(mockWriteApi.flush).toHaveBeenCalled();
        });

        it('should not write anything when dryRun is true', async () => {
            let influxDry;
            let loggerDry;
            let PointDry;
            let InfluxDBDry;
            
            const originalDryRun = process.env.TADO_DRY_RUN;
            process.env.TADO_DRY_RUN = 'true';
            
            jest.isolateModules(() => {
                influxDry = require('../influx');
                loggerDry = require('../logger');
                PointDry = require('@influxdata/influxdb-client').Point;
                InfluxDBDry = require('@influxdata/influxdb-client').InfluxDB;
            });

            await influxDry.writeMeasurement('test_measurement', {}, {});

            expect(loggerDry.debug).toHaveBeenCalledWith(
                expect.objectContaining({ measurement: 'test_measurement' }), 
                expect.any(String)
            );
            expect(PointDry).not.toHaveBeenCalled();
            
            // Revert env
            process.env.TADO_DRY_RUN = originalDryRun;
        });

        it('should log an error if writeApi fails', async () => {
            mockWriteApi.flush.mockRejectedValueOnce(new Error('Network Error'));
            await influx.writeMeasurement('test_measurement', {}, { value: 1 });
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ measurement: 'test_measurement', err: 'Network Error' }),
                'Error writing to InfluxDB'
            );
        });
    });

    describe('checkHealth', () => {
        it('should return true if dryRun is enabled', async () => {
            let influxDry;
            const originalDryRun = process.env.TADO_DRY_RUN;
            process.env.TADO_DRY_RUN = 'true';
            
            jest.isolateModules(() => {
                influxDry = require('../influx');
            });

            const isHealthy = await influxDry.checkHealth();
            expect(isHealthy).toBe(true);
            
            process.env.TADO_DRY_RUN = originalDryRun;
        });

        it('should return true if health endpoint returns pass', async () => {
            axios.get.mockResolvedValueOnce({ data: { status: 'pass' } });
            const isHealthy = await influx.checkHealth();
            expect(isHealthy).toBe(true);
            expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/health'), expect.any(Object));
        });

        it('should return false if health endpoint returns something else', async () => {
            axios.get.mockResolvedValueOnce({ data: { status: 'fail' } });
            const isHealthy = await influx.checkHealth();
            expect(isHealthy).toBe(false);
        });

        it('should return false on network error', async () => {
            axios.get.mockRejectedValueOnce(new Error('Network error'));
            const isHealthy = await influx.checkHealth();
            expect(isHealthy).toBe(false);
        });
    });
});
