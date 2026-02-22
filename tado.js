/**
 * tado.js
 *
 * Encapsulates all communication with the Tado OAuth2 and REST APIs.
 *
 * Authentication uses the OAuth2 Device Authorization Grant (RFC 8628):
 *  1. The user visits a verification URL shown in the dashboard UI.
 *  2. The frontend polls /api/login/poll until the user completes the flow.
 *  3. Tokens are persisted to disk (data/token.json) so the application
 *     survives restarts without requiring re-authentication.
 *  4. If a request returns HTTP 401 the module automatically refreshes the
 *     access token using the stored refresh token.
 *
 * API base URLs:
 *  TADO_API_URL  – Standard REST API (home/user info, weather).
 *  TADO_HOPS_URL – Next-generation API (rooms, heat pump, devices).
 *                  Requires `?ngsw-bypass=true` to skip the Angular service
 *                  worker cache when called from a browser context.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path where OAuth2 tokens are persisted between application restarts. */
const TOKEN_FILE = path.join(__dirname, 'data', 'token.json');

const TADO_AUTH_URL = 'https://login.tado.com/oauth2';
const TADO_API_URL = 'https://my.tado.com/api/v2';
const TADO_HOPS_URL = 'https://hops.tado.com';

// ---------------------------------------------------------------------------
// In-memory token cache
// Populated either from disk at startup or after a successful auth flow.
// ---------------------------------------------------------------------------

/** @type {{ access_token: string, refresh_token: string, expires_in?: number } | null} */
let tokenData = null;

// Attempt to restore a previously saved token so the app resumes polling
// immediately after a restart instead of waiting for re-authentication.
if (fs.existsSync(TOKEN_FILE)) {
    try {
        tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        logger.info('Restored OAuth2 token from disk');
    } catch (e) {
        logger.error({ err: e.message }, 'Failed to parse token.json – user will need to re-authenticate');
    }
}

// ---------------------------------------------------------------------------
// Token persistence helpers
// ---------------------------------------------------------------------------

/**
 * Persist a token response to disk and update the in-memory cache.
 * Called after every successful token issuance or refresh.
 *
 * @param {{ access_token: string, refresh_token: string }} data - Token response from Tado.
 */
function saveToken(data) {
    tokenData = data;
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        logger.error({ err: e.message }, 'Failed to persist token.json');
    }
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Check whether a valid access token is available.
 *
 * NOTE: This currently only verifies that a token *exists* in memory/on disk.
 * A future improvement would decode the JWT to check `exp` and proactively
 * refresh before the token actually expires (avoiding a failed request cycle).
 *
 * @returns {Promise<boolean>} true if an access token is present.
 */
async function checkToken() {
    return !!(tokenData && tokenData.access_token);
}

/**
 * Initiate the OAuth2 Device Authorization Grant flow.
 *
 * Returns a response containing `device_code`, `user_code`,
 * `verification_uri_complete`, and `interval` (polling interval in seconds).
 * The frontend uses these to guide the user through authentication.
 *
 * @returns {Promise<object>} Device authorization response from Tado.
 * @throws {Error} If the request to Tado fails.
 */
async function startAuth() {
    const params = new URLSearchParams();
    params.append('client_id', config.tado.clientId);
    // offline_access – grants a refresh_token so the app stays authenticated.
    // home.user      – allows reading home/device data.
    params.append('scope', 'offline_access home.user');

    try {
        const response = await axios.post(`${TADO_AUTH_URL}/device_authorize`, params);
        return response.data;
    } catch (error) {
        const detail = error.response ? error.response.data : error.message;
        logger.error({ err: detail }, 'Failed to start device authorization');
        throw error;
    }
}

/**
 * Poll the Tado token endpoint during the Device Authorization Grant flow.
 *
 * Should be called repeatedly (using the `interval` returned by `startAuth`)
 * until the user completes authentication.
 *
 * @param {string} deviceCode - The `device_code` returned by `startAuth`.
 * @returns {Promise<{ access_token?: string, error?: string }>}
 *   On success: the full token response (includes `access_token`).
 *   While pending: `{ error: 'authorization_pending' }`.
 * @throws {Error} On any error other than `authorization_pending`.
 */
async function pollToken(deviceCode) {
    const params = new URLSearchParams();
    params.append('client_id', config.tado.clientId);
    params.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    params.append('device_code', deviceCode);

    try {
        const response = await axios.post(`${TADO_AUTH_URL}/token`, params);
        if (response.data.access_token) {
            saveToken(response.data);
        }
        return response.data;
    } catch (error) {
        // `authorization_pending` is the expected state while the user has not yet
        // completed the device login – it is not a real error.
        if (error.response?.data?.error === 'authorization_pending') {
            return { error: 'authorization_pending' };
        }
        logger.error({ err: error.message }, 'Unexpected error while polling for token');
        throw error;
    }
}

/**
 * Refresh the access token using the stored refresh token.
 *
 * Called automatically by `authenticatedRequest` when an HTTP 401 is received.
 * After a successful refresh, `saveToken` is called to update both the
 * in-memory cache and the on-disk copy.
 *
 * @returns {Promise<string>} The new access token.
 * @throws {Error} If no refresh token is available or the request fails.
 */
async function refreshToken() {
    if (!tokenData?.refresh_token) {
        throw new Error('No refresh token available – user must re-authenticate');
    }

    const params = new URLSearchParams();
    params.append('client_id', config.tado.clientId);
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', tokenData.refresh_token);

    try {
        const response = await axios.post(`${TADO_AUTH_URL}/token`, params);
        saveToken(response.data);
        logger.info('Access token refreshed successfully');
        return response.data.access_token;
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to refresh access token');
        throw error;
    }
}

/**
 * Perform an authenticated HTTP request, retrying once after a token refresh
 * if the server responds with HTTP 401 (Unauthorized).
 *
 * This single helper is used by every Tado API call so the refresh logic lives
 * in one place and is not duplicated across `getMe`, `getWeather`, etc.
 *
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method - HTTP method.
 * @param {string} url - Fully qualified URL.
 * @returns {Promise<import('axios').AxiosResponse>}
 * @throws {Error} If not authenticated or if the retry also fails.
 */
async function authenticatedRequest(method, url) {
    if (!tokenData) {
        throw new Error('Not authenticated – call startAuth first');
    }

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    try {
        return await axios({ method, url, headers });
    } catch (error) {
        if (error.response?.status === 401) {
            // Token has expired – refresh it and retry the original request once.
            logger.info('Access token expired – attempting refresh');
            await refreshToken();
            return await axios({ method, url, headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Tado API wrappers
// All wrappers return parsed response data (response.data), not the raw Axios
// response, so callers work with plain objects instead of Axios internals.
// ---------------------------------------------------------------------------

/**
 * Retrieve the authenticated user's profile, including their linked homes.
 * `me.homes` is an array of `{ id, name }` objects used to drive per-home polling.
 *
 * @returns {Promise<{ homes: Array<{ id: number, name: string }> }>}
 */
async function getMe() {
    const response = await authenticatedRequest('GET', `${TADO_API_URL}/me`);
    return response.data;
}

/**
 * Retrieve current weather data for the specified home.
 * Includes outdoor temperature, solar intensity, and a weather state string.
 *
 * @param {number} homeId - The Tado home identifier.
 * @returns {Promise<object>} Weather payload.
 */
async function getWeather(homeId) {
    const response = await authenticatedRequest('GET', `${TADO_API_URL}/homes/${homeId}/weather`);
    return response.data;
}

/**
 * Retrieve room-level data (temperature, humidity, heating power, setpoint)
 * for all rooms in the specified home.
 *
 * Uses the HOPS (next-gen) API.  `ngsw-bypass=true` prevents Angular's
 * service-worker from intercepting the request in browser contexts.
 *
 * @param {number} homeId - The Tado home identifier.
 * @returns {Promise<Array<object>>} Array of room objects.
 */
async function getRooms(homeId) {
    const response = await authenticatedRequest('GET', `${TADO_HOPS_URL}/homes/${homeId}/rooms?ngsw-bypass=true`);
    return response.data;
}

/**
 * Retrieve heat pump status for the specified home, including heating setpoint
 * and domestic hot water temperatures.
 *
 * @param {number} homeId - The Tado home identifier.
 * @returns {Promise<object>} Heat pump status payload.
 */
async function getHeatPump(homeId) {
    const response = await authenticatedRequest('GET', `${TADO_HOPS_URL}/homes/${homeId}/heatPump?ngsw-bypass=true`);
    return response.data;
}

/**
 * Retrieve a combined list of rooms and their associated devices (thermostats,
 * sensors) including measured temperatures and calibration offsets.
 *
 * @param {number} homeId - The Tado home identifier.
 * @returns {Promise<{ rooms: Array<object> }>} Rooms-and-devices payload.
 */
async function getRoomsAndDevices(homeId) {
    const response = await authenticatedRequest('GET', `${TADO_HOPS_URL}/homes/${homeId}/roomsAndDevices?ngsw-bypass=true`);
    return response.data;
}

module.exports = {
    checkToken,
    startAuth,
    pollToken,
    getMe,
    getWeather,
    getRooms,
    getHeatPump,
    getRoomsAndDevices
};
