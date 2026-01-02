const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const TOKEN_FILE = path.join(__dirname, 'data', 'token.json');
const TADO_AUTH_URL = 'https://login.tado.com/oauth2';
const TADO_API_URL = 'https://my.tado.com/api/v2';
const TADO_HOPS_URL = 'https://hops.tado.com';

let tokenData = null;

// Load token on startup
if (fs.existsSync(TOKEN_FILE)) {
    try {
        tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    } catch (e) {
        console.error('Error loading token.json:', e);
    }
}

function saveToken(data) {
    tokenData = data;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

async function checkToken() {
    if (!tokenData) return false;
    // Simple check: if access_token exists
    // In a real scenario, we should check expiration and refresh if needed
    return !!tokenData.access_token;
}

/**
 * Start the Device Flow Authorization
 */
async function startAuth() {
    const params = new URLSearchParams();
    params.append('client_id', config.tado.clientId);
    params.append('scope', 'offline_access home.user'); // Standard scopes

    try {
        const response = await axios.post(`${TADO_AUTH_URL}/device_authorize`, params);
        return response.data;
    } catch (error) {
        console.error('Error starting auth:', error.response ? error.response.data : error.message);
        throw error;
    }
}

/**
 * Poll for the token using device code
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
            return response.data;
        }
    } catch (error) {
        if (error.response && error.response.data && error.response.data.error === 'authorization_pending') {
            return { error: 'authorization_pending' };
        }
        throw error;
    }
}


async function refreshToken() {
    if (!tokenData || !tokenData.refresh_token) {
        throw new Error("No refresh token available");
    }

    const params = new URLSearchParams();
    params.append('client_id', config.tado.clientId);
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', tokenData.refresh_token);

    try {
        const response = await axios.post(`${TADO_AUTH_URL}/token`, params);
        saveToken(response.data);
        return response.data.access_token;
    } catch (error) {
        console.error("Error refreshing token:", error.message);
        throw error;
    }
}

async function authenticatedRequest(method, url) {
    if (!tokenData) throw new Error("Not authenticated");

    try {
        return await axios({
            method,
            url,
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.log("Token expired, refreshing...");
            await refreshToken();
            return await axios({
                method,
                url,
                headers: { Authorization: `Bearer ${tokenData.access_token}` }
            });
        }
        throw error;
    }
}

async function getMe() {
    const response = await authenticatedRequest('GET', `${TADO_API_URL}/me`);
    return response.data;
}

async function getWeather(homeId) {
    const response = await authenticatedRequest('GET', `${TADO_API_URL}/homes/${homeId}/weather`);
    return response.data;
}

async function getDevices(homeId) {
    // Placeholder or deprecated
    return [];
}

async function getRooms(homeId) {
    const response = await authenticatedRequest('GET', `${TADO_HOPS_URL}/homes/${homeId}/rooms?ngsw-bypass=true`);
    return response.data;
}

async function getHeatPump(homeId) {
    const response = await authenticatedRequest('GET', `${TADO_HOPS_URL}/homes/${homeId}/heatPump?ngsw-bypass=true`);
    return response.data;
}

module.exports = {
    checkToken,
    startAuth,
    pollToken,
    getMe,
    getWeather,
    getRooms,
    getHeatPump
};
