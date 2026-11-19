'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bundle = require('../lib/bundle.cjs');
const credentials = require('../lib/credentials.cjs');
const cryptoLib = require('../lib/crypto.cjs');
const { exportCommand } = require('../lib/commands/export.cjs');
const { importCommand } = require('../lib/commands/import.cjs');
const { inspectCommand } = require('../lib/commands/inspect.cjs');
const { status } = require('../lib/commands/status.cjs');
const { doctor } = require('../lib/commands/doctor.cjs');
const { MemoryCredentialStore } = require('../lib/keyring.cjs');
const paths = require('../lib/paths.cjs');
const processLib = require('../lib/process.cjs');

processLib.probeZcodeKeyringAddon = () => ({
  supported: true,
  available: true,
  reason: 'ok',
  path: 'test-double',
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-e2e-'));
const SOURCE_DIR = path.join(ROOT, 'source', 'v2');
const TARGET_DIR = path.join(ROOT, 'target', 'v2');
const ENV_DIR = path.join(ROOT, 'env', 'v2');
const MERGE_DIR = path.join(ROOT, 'merge', 'v2');
const REPLACE_DIR = path.join(ROOT, 'replace', 'v2');
const BUNDLE = path.join(ROOT, 'test.zcs');
const PASSPHRASE = 'correct horse battery staple';

const fakeZcode = { running: false, processes: [], exe: null, version: '3.18.2-test' };

function writeCredentials(dir, map) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'credentials.json');
  credentials.writeCredentialsFile(file, map);
  return file;
}

function makeSourceMap() {
  return {
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': 'access-token-123',
    'oauth:zai:refresh_token': 'refresh-token-456',
    'oauth:zai:user_info': JSON.stringify({
      id: 'user-1',
      email: 'tester@example.com',
      username: 'tester',
      displayName: 'Test User',
    }),
    zcodejwttoken: 'header.payload.signature',
    'custom:api_key': 'sk-custom-provider',
  };
}

function readPlain(file, store) {
  const record = credentials.readCredentialsFile(file);
  const decrypted = cryptoLib.decryptCredentialMap(record.map, {
    credentialsFile: file,
    env: process.env,
    keyStore: store,
  });
  return decrypted.plain;
}

async function main() {
  console.log('root:', ROOT);

  const sourceFile = path.join(SOURCE_DIR, 'credentials.json');
  const sourceKey = cryptoLib.randomBytes(32);
  const sourceStore = new MemoryCredentialStore({
    [paths.pathHash(sourceFile)]: sourceKey.toString('base64url'),
  });
  const sourcePlain = makeSourceMap();
  writeCredentials(SOURCE_DIR, cryptoLib.encryptCredentialMap(sourcePlain, {
    source: 'os',
    key: sourceKey,
  }));
  credentials.writeCredentialSource(sourceFile);
  fs.writeFileSync(
    path.join(SOURCE_DIR, 'onboarding-record.json'),
    `${JSON.stringify({ version: 2, deviceMid: '11111111-2222-3333-4444-555555555555', entries: [], decisions: [] }, null, 2)}\n`
  );

  const doctorResult = await doctor({
    home: path.dirname(SOURCE_DIR),
    keyStore: sourceStore,
    zcodeInfo: fakeZcode,
    json: true,
  });
  assert.strictEqual(doctorResult.exitCode, 0);

  const statusResult = await status({
    home: path.dirname(SOURCE_DIR),
    keyStore: sourceStore,
    zcodeInfo: fakeZcode,
    json: true,
  });
  assert.strictEqual(statusResult.exitCode, 0);

  await exportCommand({
    home: path.dirname(SOURCE_DIR),
    keyStore: sourceStore,
    zcodeInfo: fakeZcode,
    out: BUNDLE,
    passphrase: PASSPHRASE,
    includeDeviceId: true,
    json: true,
  });
  assert.ok(fs.existsSync(BUNDLE));

  const buffer = fs.readFileSync(BUNDLE);
  const { payload } = bundle.decryptBundle(buffer, PASSPHRASE);
  assert.deepStrictEqual(payload.credentials, sourcePlain);
  assert.strictEqual(payload.source.deviceMid, '11111111-2222-3333-4444-555555555555');

  const wrong = await (async () => {
    try {
      await inspectCommand({ file: BUNDLE, passphrase: 'wrong-password', json: true });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(wrong && wrong.code === 'CRYPTO', 'wrong passphrase should fail with CRYPTO');

  const targetFile = path.join(TARGET_DIR, 'credentials.json');
  const targetStore = new MemoryCredentialStore();
  const targetResult = await importCommand({
    home: path.dirname(TARGET_DIR),
    credentialsFile: targetFile,
    keyStore: targetStore,
    zcodeInfo: fakeZcode,
    file: BUNDLE,
    passphrase: PASSPHRASE,
    deviceId: 'clone',
    json: true,
  });
  assert.strictEqual(targetResult.exitCode, 0);
  assert.ok(fs.existsSync(targetFile));
  assert.ok(fs.existsSync(paths.credentialSourceFile(targetFile)));
  assert.strictEqual(fs.readFileSync(paths.credentialSourceFile(targetFile), 'utf8'), 'os\n');

  const targetPlain = readPlain(targetFile, targetStore);
  assert.deepStrictEqual(targetPlain, sourcePlain);
  assert.strictEqual(credentials.accountSummary(targetPlain).user.email, 'tester@example.com');
  assert.strictEqual(
    fs
      .readFileSync(path.join(TARGET_DIR, 'onboarding-record.json'), 'utf8')
      .includes('11111111-2222-3333-4444-555555555555'),
    true
  );

  // env mode
  const envFile = path.join(ENV_DIR, 'credentials.json');
  const envResult = await importCommand({
    home: path.dirname(ENV_DIR),
    credentialsFile: envFile,
    zcodeInfo: fakeZcode,
    file: BUNDLE,
    passphrase: PASSPHRASE,
    mode: 'env',
    json: true,
  });
  assert.strictEqual(envResult.exitCode, 0);
  assert.strictEqual(fs.existsSync(paths.credentialSourceFile(envFile)), false);
  const secret = fs.readFileSync(paths.credentialSecretFile(envFile), 'utf8');
  assert.ok(Buffer.byteLength(secret, 'utf8') >= 32);
  const envPlain = readPlain(envFile, new MemoryCredentialStore());
  assert.deepStrictEqual(envPlain, sourcePlain);

  // merge keeps target-only provider key
  const mergeFile = path.join(MERGE_DIR, 'credentials.json');
  const mergeKey = cryptoLib.randomBytes(32);
  const mergeStore = new MemoryCredentialStore({
    [paths.pathHash(mergeFile)]: mergeKey.toString('base64url'),
  });
  writeCredentials(MERGE_DIR, cryptoLib.encryptCredentialMap({
    ...sourcePlain,
    'oauth:zai:access_token': 'old-target-token',
    'other:api_key': 'target-only-provider-key',
  }, { source: 'os', key: mergeKey }));
  const mergeResult = await importCommand({
    home: path.dirname(MERGE_DIR),
    credentialsFile: mergeFile,
    keyStore: mergeStore,
    zcodeInfo: fakeZcode,
    file: BUNDLE,
    passphrase: PASSPHRASE,
    json: true,
  });
  assert.strictEqual(mergeResult.exitCode, 0);
  const mergedPlain = readPlain(mergeFile, mergeStore);
  assert.strictEqual(mergedPlain['other:api_key'], 'target-only-provider-key');
  assert.strictEqual(mergedPlain['oauth:zai:access_token'], 'access-token-123');

  // replace-all can recover from a missing target key, but only with --force
  const replaceFile = path.join(REPLACE_DIR, 'credentials.json');
  const orphanKey = cryptoLib.randomBytes(32);
  writeCredentials(REPLACE_DIR, cryptoLib.encryptCredentialMap({
    ...sourcePlain,
    'oauth:zai:access_token': 'orphaned-token',
  }, { source: 'os', key: orphanKey }));
  const orphanStore = new MemoryCredentialStore();
  const replaceWithoutForce = await (async () => {
    try {
      await importCommand({
        home: path.dirname(REPLACE_DIR),
        credentialsFile: replaceFile,
        keyStore: orphanStore,
        zcodeInfo: fakeZcode,
        file: BUNDLE,
        passphrase: PASSPHRASE,
        replaceAll: true,
        json: true,
      });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(
    replaceWithoutForce && replaceWithoutForce.code === 'TARGET_KEY_UNAVAILABLE',
    'replace-all without --force must refuse when the old key is missing'
  );

  const replaceResult = await importCommand({
    home: path.dirname(REPLACE_DIR),
    credentialsFile: replaceFile,
    keyStore: orphanStore,
    zcodeInfo: fakeZcode,
    file: BUNDLE,
    passphrase: PASSPHRASE,
    replaceAll: true,
    force: true,
    json: true,
  });
  assert.strictEqual(replaceResult.exitCode, 0);
  assert.deepStrictEqual(readPlain(replaceFile, orphanStore), sourcePlain);

  // dry-run does not modify anything
  const before = fs.readFileSync(targetFile, 'utf8');
  const dry = await importCommand({
    home: path.dirname(TARGET_DIR),
    credentialsFile: targetFile,
    keyStore: targetStore,
    zcodeInfo: fakeZcode,
    file: BUNDLE,
    passphrase: PASSPHRASE,
    dryRun: true,
    json: true,
  });
  assert.strictEqual(dry.exitCode, 0);
  assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), before);

  // running guard
  const runningError = await (async () => {
    try {
      await importCommand({
        home: path.dirname(TARGET_DIR),
        credentialsFile: targetFile,
        keyStore: targetStore,
        zcodeInfo: { running: true, processes: [{ pid: 1234 }], exe: null, version: null },
        file: BUNDLE,
        passphrase: PASSPHRASE,
        json: true,
      });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(runningError && runningError.code === 'ZCODE_RUNNING');

  console.log('all synthetic E2E assertions passed');
  console.log('workdir kept for inspection:', ROOT);
}

main().catch((error) => {
  console.error('E2E FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

