// scripts/attack-scenarios.js
// Attack scenario generators. Each returns an array of decision request payloads.
// Used by traffic-daemon.js (scheduled) and POST /dev/attack/:scenario (on-demand trigger).

const SCENARIO_NAMES = ['credentialStuffing', 'accountTakeover', 'muleNetwork'];

// 15 rapid login attempts cycling through known customer IDs with unfamiliar devices
function credentialStuffing(personas) {
    const targets = personas.filter(p => p.archetype === 'bot_credential_stuffer');
    const customerIds = targets.length
        ? targets.map(p => p.customer_id)
        : ['Lara', 'Lenny', 'Maxim', 'Maddy', 'Jason', 'Alice', 'Ben', 'Nikky'];
    const devices = ['cs-device-001', 'cs-device-002', 'cs-device-003', 'cs-device-004', 'cs-device-005'];

    const payloads = [];
    for (let i = 0; i < 15; i++) {
        payloads.push({
            customer_id: customerIds[i % customerIds.length],
            action: 'login',
            device_id: devices[i % devices.length],
            _scenario_tag: 'credentialStuffing',
        });
    }
    return payloads;
}

// ATO attacker: uses a real customer's ID but a brand-new device (triggers is_new_device)
function accountTakeover(personas) {
    const attacker = personas.find(p => p.archetype === 'ato_attacker') || null;
    const customerId = attacker ? attacker.customer_id : 'Lara';
    const deviceId = attacker
        ? attacker.device_ids[Math.floor(Math.random() * attacker.device_ids.length)]
        : `ato-${Date.now()}`;

    return [
        { customer_id: customerId, action: 'login',            device_id: deviceId, _scenario_tag: 'accountTakeover' },
        { customer_id: customerId, action: 'account_recovery', device_id: deviceId, _scenario_tag: 'accountTakeover' },
        { customer_id: customerId, action: 'change_password',  device_id: deviceId, _scenario_tag: 'accountTakeover' },
        { customer_id: customerId, action: 'large_transfer',   device_id: deviceId, _scenario_tag: 'accountTakeover' },
    ];
}

// Mule network: 5 different legit customers all wire to the same new payee in quick succession
function muleNetwork(personas) {
    const victims = personas.filter(p => p.archetype === 'low_risk_regular' || p.archetype === 'medium_risk_traveller');
    const customerIds = victims.length >= 5
        ? victims.slice(0, 5).map(p => p.customer_id)
        : ['Lara', 'Lenny', 'Maxim', 'Jason', 'Nikky'];
    const sharedDevice = `mule-device-${Date.now()}`;

    return customerIds.map(customer_id => ({
        customer_id,
        action: 'wire_transfer',
        device_id: sharedDevice,
        _scenario_tag: 'muleNetwork',
    }));
}

module.exports = { credentialStuffing, accountTakeover, muleNetwork, SCENARIO_NAMES };
