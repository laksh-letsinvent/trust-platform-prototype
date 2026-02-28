// adapters/deviceAdapter.js
/**
 * Device adapter: returns device score (0-100) from data store.
 * Falls back to 0 when device not found.
 */

const store = require('../data/store');

async function getDeviceScore(deviceId) {
    const device = await store.getDeviceById(deviceId);
    if (device != null && typeof device.device_score === 'number') {
        return device.device_score;
    }
    return 0;
}

async function getDeviceInfo(deviceId) {
    const device = await store.getDeviceById(deviceId);
    return device ? { ...device } : null;
}

module.exports = {
    getDeviceScore,
    getDeviceInfo
};
