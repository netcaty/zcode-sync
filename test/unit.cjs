'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bundle = require('../lib/bundle.cjs');
const credentials = require('../lib/credentials.cjs');
const cryptoLib = require('../lib/crypto.cjs');
const onboarding = require('../lib/onboarding.cjs');
const paths = require('../lib/paths.cjs');
const { MemoryCredentialStore } = require('../lib/keyring.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-unit-'));
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function withEnv(changes, fn) {
  const saved = {};
  for (const key of Object.keys(changes)) {
    saved[key] = process.env[key];
    if (changes[key] === undefined) delete process.env[key];
    else process.env[key] = changes[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(changes)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.strictEqual(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  throw new Error(`expected ${code}, but no error was thrown`);
}

test('pathHash matches Node path.resolve + sha256', () => {
  const input = path.join(ROOT, 'a', '..', 'b', 'credentials.json');
  const expected = crypto.createHash('sha256').update(path.resolve(input)).digest('hex');
  assert.strictEqual(paths.pathHash(input), expected);
});

test('credentials candidates prefer v2 and explicit path wins', () => {
  const home = path.join(ROOT, 'home');
  const candidates = paths.credentialsCandidates({ home });
  assert.strictEqual(candidates[0], path.join(home, 'v2', 'credentials.json'));
  assert.strictEqual(candidates.length, 2);
  assert.ok(
    candidates.every((candidate) =>
      candidate.startsWith(`${path.resolve(home)}${path.sep}`)
    ),
    'explicit --home must never fall back to the real ~/.zcode'
  );
  const explicit = path.join(ROOT, 'explicit', 'credentials.json');
  assert.deepStrictEqual(paths.credentialsCandidates({ credentialsFile: explicit }), [
    path.resolve(explicit),
  ]);
});

test('v2 seal/open round-trip and wrong key rejection', () => {
  const key = cryptoLib.randomBytes(32);
  const payload = cryptoLib.sealV2('hello-世界', key);
  assert.strictEqual(payload.split('.').length, 3);
  assert.strictEqual(cryptoLib.openV2(payload, key), 'hello-世界');
  expectCode(() => cryptoLib.openV2(payload, cryptoLib.randomBytes(32)), 'CRYPTO');
});

test('v2 value format and parsing', () => {
  const key = cryptoLib.randomBytes(32);
  const value = cryptoLib.formatV2Value('env', key, 'secret');
  const parsed = cryptoLib.parseCredentialValue(value);
  assert.strictEqual(parsed.kind, 'v2');
  assert.strictEqual(parsed.source, 'env');
  assert.strictEqual(parsed.fingerprint, cryptoLib.fingerprint(key));
  assert.strictEqual(cryptoLib.openV2(parsed.payload, key), 'secret');
  assert.strictEqual(cryptoLib.parseCredentialValue('enc:v3:whatever').kind, 'unknown');
});

test('keyring blob encodings: UTF-16LE, UTF-8, raw 32 bytes', () => {
  const key = cryptoLib.randomBytes(32);
  const keyString = key.toString('base64url');
  assert.strictEqual(cryptoLib.keyFromKeyringBlob(Buffer.from(keyString, 'utf16le')).toString('hex'), key.toString('hex'));
  assert.strictEqual(cryptoLib.keyFromKeyringBlob(Buffer.from(keyString, 'utf8')).toString('hex'), key.toString('hex'));
  assert.strictEqual(cryptoLib.keyFromKeyringBlob(key).toString('hex'), key.toString('hex'));
  expectCode(() => cryptoLib.keyFromKeyringBlob(Buffer.from('bad')), 'KEYRING_UNAVAILABLE');
});

test('legacy enc:v1 decrypts with explicit secret', () => {
  const secret = 'legacy-secret-'.padEnd(40, 'x');
  const key = cryptoLib.deriveEnvKey(secret);
  const payload = cryptoLib.sealV2('legacy-plain', key);
  withEnv({ ZCODE_CREDENTIAL_SECRET: secret }, () => {
    assert.strictEqual(cryptoLib.openV1(payload, process.env), 'legacy-plain');
  });
});

test('decrypt credential map supports v1 and plaintext', () => {
  const file = path.join(ROOT, 'legacy-map', 'v2', 'credentials.json');
  const secret = 'legacy-map-secret-'.padEnd(40, 'z');
  const key = cryptoLib.deriveEnvKey(secret);
  const v1 = `enc:v1:${cryptoLib.sealV2('legacy-token', key)}`;
  const map = {
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': v1,
    'custom:plain': 'plain-value',
  };
  withEnv({ ZCODE_CREDENTIAL_SECRET: secret }, () => {
    const decrypted = cryptoLib.decryptCredentialMap(map, {
      credentialsFile: file,
      env: process.env,
      keyStore: new MemoryCredentialStore(),
    });
    assert.strictEqual(decrypted.plain['oauth:zai:access_token'], 'legacy-token');
    assert.strictEqual(decrypted.plain['custom:plain'], 'plain-value');
    assert.deepStrictEqual(decrypted.counts, { os: 0, env: 0, v1: 1, plain: 2, unknown: 0 });
  });
});

test('managed secret precedence and conflict', () => {
  const dir = path.join(ROOT, 'managed');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'credentials.json');
  const secret = 'implicit-secret-'.padEnd(40, 'y');
  fs.writeFileSync(paths.credentialSecretFile(file), secret);
  withEnv({ ZCODE_CREDENTIAL_SECRET: undefined, ZCODE_CREDENTIAL_SECRET_FILE: undefined }, () => {
    assert.strictEqual(cryptoLib.resolveManagedSecret({ credentialsFile: file, force: false }), null);
    assert.strictEqual(
      cryptoLib.resolveManagedSecret({ credentialsFile: file, force: true }).secret,
      secret
    );
  });
  withEnv({ ZCODE_CREDENTIAL_SECRET: 'env-secret', ZCODE_CREDENTIAL_SECRET_FILE: undefined }, () => {
    assert.strictEqual(
      cryptoLib.resolveManagedSecret({ credentialsFile: file, force: true }).secret,
      'env-secret'
    );
  });
  withEnv(
    { ZCODE_CREDENTIAL_SECRET: 'a', ZCODE_CREDENTIAL_SECRET_FILE: 'b' },
    () => expectCode(() => cryptoLib.resolveManagedSecret({ credentialsFile: file, force: true }), 'CRYPTO')
  );
});

test('encrypt/decrypt credential map with a per-profile key', () => {
  const file = path.join(ROOT, 'profile', 'v2', 'credentials.json');
  const key = cryptoLib.randomBytes(32);
  const store = new MemoryCredentialStore({
    [paths.pathHash(file)]: key.toString('base64url'),
  });
  const plain = {
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': 'token',
    'custom:key': 'other',
  };
  const encrypted = cryptoLib.encryptCredentialMap(plain, { source: 'os', key });
  for (const value of Object.values(encrypted)) {
    assert.ok(value.startsWith('enc:v2:os:'));
  }
  const decrypted = cryptoLib.decryptCredentialMap(encrypted, {
    credentialsFile: file,
    env: process.env,
    keyStore: store,
  });
  assert.deepStrictEqual(decrypted.plain, plain);
  assert.deepStrictEqual(decrypted.counts, { os: 3, env: 0, v1: 0, plain: 0, unknown: 0 });

  const wrongStore = new MemoryCredentialStore({
    [paths.pathHash(file)]: cryptoLib.randomBytes(32).toString('base64url'),
  });
  expectCode(
    () =>
      cryptoLib.decryptCredentialMap(encrypted, {
        credentialsFile: file,
        env: process.env,
        keyStore: wrongStore,
      }),
    'CRYPTO'
  );
});

test('merge policies', () => {
  const bundleMap = {
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': 'new',
    'oauth:zai:refresh_token': 'new-refresh',
  };
  const targetMap = {
    'oauth:active_provider': 'bigmodel',
    'oauth:bigmodel:access_token': 'old',
    'other:api_key': 'keep-me',
  };
  const identity = credentials.mergeCredentialMaps({ bundleMap, targetMap, mode: 'identity' });
  assert.strictEqual(identity['oauth:zai:access_token'], 'new');
  assert.strictEqual(identity['oauth:bigmodel:access_token'], undefined);
  assert.strictEqual(identity['other:api_key'], 'keep-me');

  const merged = credentials.mergeCredentialMaps({ bundleMap, targetMap, mode: 'merge' });
  assert.strictEqual(merged['oauth:bigmodel:access_token'], 'old');
  assert.strictEqual(merged['other:api_key'], 'keep-me');

  const replaced = credentials.mergeCredentialMaps({ bundleMap, targetMap, mode: 'replace-all' });
  assert.deepStrictEqual(replaced, bundleMap);
});

test('bundle encrypt/decrypt, inspect, wrong passphrase, tamper', () => {
  const payload = bundle.buildPayload({
    plainMap: {
      'oauth:active_provider': 'zai',
      'oauth:zai:access_token': 'token',
    },
    source: { credentialsPath: 'C:\\x\\credentials.json', keySource: 'os' },
    summary: { activeProvider: 'zai', keyCount: 2 },
  });
  const passphrase = 'unit-test-passphrase';
  const buffer = bundle.encryptBundle(payload, passphrase);
  assert.ok(buffer.subarray(0, 6).toString('ascii') === 'ZCSYNC');
  const decrypted = bundle.decryptBundle(buffer, passphrase);
  assert.deepStrictEqual(decrypted.payload.credentials, payload.credentials);

  expectCode(() => bundle.decryptBundle(buffer, 'wrong-passphrase'), 'CRYPTO');

  const tampered = Buffer.from(buffer);
  tampered[tampered.length - 1] ^= 0xff;
  expectCode(() => bundle.decryptBundle(tampered, passphrase), 'CRYPTO');

  const inspected = bundle.inspectBundle(buffer, passphrase);
  assert.strictEqual(inspected.credentialCount, 2);
  assert.strictEqual(inspected.source.keySource, 'os');
  assert.ok(inspected.credentialNames.includes('oauth:zai:access_token'));
});

test('account summary parses user_info, JWT expiry and refresh fingerprint', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ exp })).toString('base64url'),
    'sig',
  ].join('.');
  const plain = {
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': jwt,
    'oauth:zai:refresh_token': 'refresh-token',
    'oauth:zai:user_info': JSON.stringify({
      email: 'user@example.com',
      username: 'user',
      id: 'u1',
    }),
    other: 'x',
  };
  const summary = credentials.accountSummary(plain);
  assert.strictEqual(summary.user.email, 'user@example.com');
  assert.strictEqual(summary.activeProvider, 'zai');
  assert.strictEqual(summary.accessTokenExpiresAt, new Date(exp * 1000).toISOString());
  assert.strictEqual(
    summary.refreshTokenFingerprint,
    cryptoLib.sha256(Buffer.from('refresh-token')).toString('hex').slice(0, 8)
  );
  assert.strictEqual(summary.identityKeyCount, 4);
  assert.strictEqual(summary.otherKeyCount, 1);
});

test('atomic write, backup and lock', () => {
  const dir = path.join(ROOT, 'atomic', 'v2');
  const file = path.join(dir, 'credentials.json');
  credentials.writeCredentialsFile(file, { a: '1' });
  assert.deepStrictEqual(credentials.readCredentialsFile(file).map, { a: '1' });
  fs.writeFileSync(paths.credentialSecretFile(file), 's'.repeat(40));
  const backups = credentials.backupCredentialState(file, { keep: 5 });
  assert.ok(backups.length >= 2);
  assert.ok(backups.some((item) => item.includes('credentials.json.zcs-backup-')));

  const lock = credentials.acquireLock(file);
  assert.ok(fs.existsSync(lock.path));
  expectCode(() => credentials.acquireLock(file), 'IO');
  lock.release();
  assert.strictEqual(fs.existsSync(lock.path), false);
});

test('onboarding deviceMid read/write', () => {
  const dir = path.join(ROOT, 'onboarding', 'v2');
  const file = path.join(dir, 'credentials.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    paths.onboardingFile(file),
    `${JSON.stringify({ version: 2, deviceMid: 'old', entries: [], decisions: [] }, null, 2)}\n`
  );
  assert.strictEqual(onboarding.getDeviceMid(file), 'old');
  onboarding.setDeviceMid(file, 'new-mid');
  assert.strictEqual(onboarding.getDeviceMid(file), 'new-mid');
  const record = JSON.parse(fs.readFileSync(paths.onboardingFile(file), 'utf8'));
  assert.deepStrictEqual(record.entries, []);
});

console.log('');
console.log(`unit tests: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('failures:', failures.map((item) => item.name).join(', '));
  process.exitCode = 1;
}
