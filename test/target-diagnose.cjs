'use strict';

const credentials = require('../lib/credentials.cjs');
const cryptoLib = require('../lib/crypto.cjs');
const { createCredentialStore } = require('../lib/keyring.cjs');
const paths = require('../lib/paths.cjs');

const file = paths.resolveCredentialsFile({});
const record = credentials.readCredentialsFile(file);
if (!record) {
  console.log('no credentials');
  process.exit(0);
}

function decodeJwt(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { header, payload };
  } catch {
    return null;
  }
}

function safeClaims(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const keys = [
    'iss', 'aud', 'sub', 'exp', 'iat', 'nbf', 'jti', 'scope', 'type', 'typ',
    'device', 'device_id', 'deviceId', 'device_mid', 'deviceMid', 'mid',
    'session', 'session_id', 'sessionId', 'sid', 'provider', 'user_id', 'userId',
    'customer_id', 'customerId', 'org', 'organization', 'project',
  ];
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) out[key] = payload[key];
  }
  return out;
}

function safeJsonKeys(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return { type: typeof parsed };
    return { keys: Object.keys(parsed) };
  } catch {
    return null;
  }
}

const store = createCredentialStore();
const decrypted = cryptoLib.decryptCredentialMap(record.map, {
  credentialsFile: file,
  env: process.env,
  keyStore: store,
});

for (const [name, value] of Object.entries(decrypted.plain)) {
  const out = { key: name, length: value.length };
  const jwt = decodeJwt(value);
  if (jwt) {
    out.jwtHeader = jwt.header;
    out.jwtClaims = safeClaims(jwt.payload);
    out.jwtPayloadKeys = Object.keys(jwt.payload);
  }
  const jsonKeys = safeJsonKeys(value);
  if (jsonKeys) out.json = jsonKeys;
  if (/session_revision|active_provider/i.test(name)) out.value = value;
  if (/user_info|linked_bigmodel/i.test(name)) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        const safe = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && /token|secret|key|credential/i.test(k)) {
            safe[k] = `<string:${v.length}>`;
          } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
            safe[k] = v;
          } else {
            safe[k] = Array.isArray(v) ? `array(${v.length})` : `object(${Object.keys(v || {}).length})`;
          }
        }
        out.parsed = safe;
      }
    } catch {
      // not JSON
    }
  }
  console.log(JSON.stringify(out));
}
