'use strict';

const assert = require('assert');
const crypto = require('../lib/crypto.cjs');
const keyring = require('../lib/keyring.cjs');

const key = crypto.randomBytes(32);
const value = crypto.formatV2Value('os', key, 'hello-世界');
const parsed = crypto.parseCredentialValue(value);
assert.strictEqual(parsed.kind, 'v2');
assert.strictEqual(parsed.source, 'os');
assert.strictEqual(parsed.fingerprint, crypto.fingerprint(key));
assert.strictEqual(crypto.openV2(parsed.payload, key), 'hello-世界');

const wrong = crypto.randomBytes(32);
assert.throws(() => crypto.openV2(parsed.payload, wrong), /无法解密凭据/);

const envKey = crypto.deriveEnvKey('a'.repeat(43));
const envValue = crypto.formatV2Value('env', envKey, 'env-secret');
assert.strictEqual(
  crypto.openV2(crypto.parseCredentialValue(envValue).payload, envKey),
  'env-secret'
);

const store = new keyring.WindowsCredentialStore({ service: 'zcode-sync-test' });
const account = `probe-${process.pid}`;
try {
  store.set(account, key.toString('base64url'));
  const readBack = store.get(account);
  assert.strictEqual(readBack, key.toString('base64url'));
  console.log('keyring ok');
} finally {
  try {
    store.delete(account);
  } catch (error) {
    console.error('cleanup failed:', error.message);
  }
}

console.log('crypto ok');
