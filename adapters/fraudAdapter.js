// adapters/fraudAdapter.js
/**
 * Fraud adapter: returns fraud score from user data store.
 * User has a single fraud_score (no trust_score). Falls back to default when user not found.
 */

const store = require('../data/store');

async function getFraudScore(customerId) {
    const user = await store.getUserById(customerId);
    if (user != null && typeof user.fraud_score === 'number') {
        return user.fraud_score;
    }
    return 50;
}

module.exports = {
    getFraudScore
};
