const fs = require('fs');
const axios = require('axios');

jest.mock('axios');
jest.mock('fs');
jest.mock('../logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn()
}));

describe('tado.js', () => {
    const mockToken = {
        access_token: 'valid_access_token',
        refresh_token: 'valid_refresh_token'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Initialization', () => {
        it('should read token.json on startup if it exists', () => {
            let localFs, localLogger;
            
            jest.isolateModules(() => {
                localFs = require('fs');
                localLogger = require('../logger');
                jest.spyOn(localLogger, 'info');
                
                localFs.existsSync.mockImplementation(path => path.endsWith('token.json'));
                localFs.readFileSync.mockImplementation(path => path.endsWith('token.json') ? JSON.stringify(mockToken) : '');

                require('../tado');
            });
            
            expect(localFs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('token.json'), 'utf8');
            expect(localLogger.info).toHaveBeenCalledWith('Restored OAuth2 token from disk');
        });

        it('should log an error if token.json is invalid', () => {
            let localFs, localLogger;
            
            jest.isolateModules(() => {
                localFs = require('fs');
                localLogger = require('../logger');
                jest.spyOn(localLogger, 'error');
                
                localFs.existsSync.mockImplementation(path => path.endsWith('token.json'));
                localFs.readFileSync.mockImplementation(path => path.endsWith('token.json') ? 'invalid json' : '');

                require('../tado');
            });
            
            expect(localLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.any(String) }),
                expect.any(String)
            );
        });
    });

    describe('API Flow', () => {
        let tado, localAxios, localFs;

        // Since we import tado anew for ALL api tests, we set it up once for the block
        beforeAll(() => {
            jest.isolateModules(() => {
                localAxios = require('axios');
                localFs = require('fs');
                localFs.existsSync.mockReturnValue(false);
                tado = require('../tado');
            });
        });

        beforeEach(() => {
            jest.clearAllMocks();
        });

        it('startAuth should request a device code', async () => {
            const authResponse = { device_code: '123', user_code: '456' };
            localAxios.post.mockResolvedValueOnce({ data: authResponse });

            const result = await tado.startAuth();
            
            expect(result).toEqual(authResponse);
            expect(localAxios.post).toHaveBeenCalledWith(
                expect.stringContaining('/device_authorize'),
                expect.any(URLSearchParams)
            );
        });

        it('pollToken should return authorization_pending when expecting user action', async () => {
            localAxios.post.mockRejectedValueOnce({
                response: { data: { error: 'authorization_pending' } }
            });
            const result = await tado.pollToken('device_123');
            expect(result).toEqual({ error: 'authorization_pending' });
        });

        it('pollToken should save token and return access token on success', async () => {
            localAxios.post.mockResolvedValueOnce({ data: mockToken });
            localFs.writeFileSync.mockImplementation(() => {});

            const result = await tado.pollToken('device_123');
            
            expect(result.access_token).toBe(mockToken.access_token);
            expect(localFs.writeFileSync).toHaveBeenCalledWith(
                expect.stringContaining('token.json'),
                JSON.stringify(mockToken, null, 2)
            );
        });

        describe('Authenticated Requests', () => {
            beforeEach(async () => {
                // Seed the token cache
                localAxios.post.mockResolvedValueOnce({ data: mockToken });
                await tado.pollToken('device_123');
            });

            it('getMe should make authenticated request to /me', async () => {
                const meResponse = { homes: [{ id: 1, name: 'Home' }] };
                localAxios.mockResolvedValueOnce({ data: meResponse });

                const result = await tado.getMe();
                
                expect(result).toEqual(meResponse);
                expect(localAxios).toHaveBeenCalledWith(expect.objectContaining({
                    method: 'GET',
                    url: expect.stringContaining('/me'),
                    headers: { Authorization: `Bearer ${mockToken.access_token}` }
                }));
            });

            it('should automatically refresh token on 401', async () => {
                const newMockToken = { access_token: 'new_token', refresh_token: 'new_refresh' };
                const meResponse = { homes: [{ id: 1 }] };

                localAxios.mockRejectedValueOnce({ response: { status: 401 } });
                localAxios.post.mockResolvedValueOnce({ data: newMockToken });
                localAxios.mockResolvedValueOnce({ data: meResponse });

                const result = await tado.getMe();

                expect(result).toEqual(meResponse);
                expect(localAxios).toHaveBeenLastCalledWith(expect.objectContaining({
                    headers: { Authorization: `Bearer ${newMockToken.access_token}` }
                }));
            });
        });
    });
});
