// policyValidator.js
// AJV-based structural validation for policy JSON files.
// validate() returns { valid, errors }. Pass-through (valid=true) if AJV is absent.

const path = require('path');
const fs = require('fs');

let Ajv;
try {
    const m = require('ajv');
    Ajv = m.default || m;
} catch (_) {}

const SCHEMA_FILES = {
    decisions:  'decisions.schema.json',
    confidence: 'confidence.schema.json',
    idvRouting: 'idvRouting.schema.json',
};

let ajv = null;
const compiled = {};

function getAjv() {
    if (!Ajv) return null;
    if (!ajv) ajv = new Ajv({ allErrors: true });
    return ajv;
}

function validate(policyName, content) {
    const validator = getAjv();
    if (!validator) return { valid: true, errors: [] };

    if (!compiled[policyName]) {
        const schemaFile = SCHEMA_FILES[policyName];
        if (!schemaFile) return { valid: true, errors: [] };
        try {
            const schema = JSON.parse(
                fs.readFileSync(path.join(__dirname, 'policies', 'schema', schemaFile), 'utf8')
            );
            compiled[policyName] = validator.compile(schema);
        } catch (err) {
            console.warn(`policyValidator: could not compile schema for ${policyName}:`, err.message);
            return { valid: true, errors: [] };
        }
    }

    const ok = compiled[policyName](content);
    const errors = ok ? [] : (compiled[policyName].errors || []).map(
        e => `${e.instancePath || '(root)'} ${e.message}`
    );
    return { valid: !!ok, errors };
}

module.exports = { validate };
