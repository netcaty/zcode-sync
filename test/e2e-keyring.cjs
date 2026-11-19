'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credentials = require('../lib/credentials.cjs');
const cryptoLib = require('../lib/crypto.cjs');
const { exportCommand } = require('../lib/commands/export.cjs');
const { importCommand } = require('../lib/commands/import.cjs');
const { WindowsCredentialStore } = require('../lib/keyring.cjs');
const paths = require('../lib/paths.cjs');
const processLib = require('../lib/process.cjs');

processLib.probeZcodeKeyringAddon = () => ({
  supported: true,
  available: true,
  reason: 'ok',
  path: 'test-double',
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-keyring-'));
const SOURCE_DIR = path.join(ROOT, 'source', 'v2');
const TARGET_DIR = path.join(ROOT, 'target', 'v2');
const BUNDLE = path.join(ROOT, 'real-keyring.zcs');
const PASSPHRASE = 'real-keyring-test-passphrase';
const SERVICE_SOURCE = `zcode-sync-test-src-${process.pid}`;
const SERVICE_TARGET = `zcode-sync-test-dst-${process.pid}`;
const fakeZcode = { running: false, processes: [], exe: null, version: '3.18.2-test' };

async function main() {
  const sourceFile = path.join(SOURCE_DIR, 'credentials.json');
  const targetFile = path.join(TARGET_DIR, 'credentials.json');
  const sourceAccount = paths.pathHash(sourceFile);
  const targetAccount = paths.pathHash(targetFile);

  const sourceStore = new WindowsCredentialStore({ service: SERVICE_SOURCE });
  const targetStore = new WindowsCredentialStore({ service: SERVICE_TARGET });

  const sourceKey = cryptoLib.randomBytes(32);
  const plain = {
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': 'real-keyring-access',
    'oauth:zai:refresh_token': 'real-keyring-refresh',
    'oauth:zai:user_info': JSON.stringify({ email: 'keyring@example.com' }),
    zcodejwttoken: 'a.b.c',
  };

  try {
    fs.mkdirSync(SOURCE_DIR, { recursive: true });
    credentials.writeCredentialsFile(
      sourceFile,
      cryptoLib.encryptCredentialMap(plain, { source: 'os', key: sourceKey })
    );
    credentials.writeCredentialSource(sourceFile);
    sourceStore.set(sourceAccount, sourceKey.toString('base64url'));
    assert.strictEqual(sourceStore.get(sourceAccount), sourceKey.toString('base64url'));

    await exportCommand({
      home: path.dirname(SOURCE_DIR),
      credentialsFile: sourceFile,
      keyStore: sourceStore,
      zcodeInfo: fakeZcode,
      out: BUNDLE,
      passphrase: PASSPHRASE,
      json: true,
    });
    assert.ok(fs.existsSync(BUNDLE));

    await importCommand({
      home: path.dirname(TARGET_DIR),
      credentialsFile: targetFile,
      keyStore: targetStore,
      zcodeInfo: fakeZcode,
      file: BUNDLE,
      passphrase: PASSPHRASE,
      json: true,
    });

    const targetKeyString = targetStore.get(targetAccount);
    assert.ok(targetKeyString, 'target keyring should contain a key');
    const targetKey = cryptoLib.keyFromB64url(targetKeyString);
    assert.notStrictEqual(
      targetKey.toString('hex'),
      sourceKey.toString('hex'),
      'each machine should get its own key'
    );

    const record = credentials.readCredentialsFile(targetFile);
    const decrypted = cryptoLib.decryptCredentialMap(record.map, {
      credentialsFile: targetFile,
      env: process.env,
      keyStore: targetStore,
    });
    assert.deepStrictEqual(decrypted.plain, plain);
    assert.strictEqual(
      fs.readFileSync(paths.credentialSourceFile(targetFile), 'utf8'),
      'os\n'
    );

    console.log('real Windows Credential Manager E2E passed');
  } finally {
    try {
      sourceStore.delete(sourceAccount);
    } catch (error) {
      console.error('source keyring cleanup failed:', error.message);
    }
    try {
      targetStore.delete(targetAccount);
    } catch (error) {
      console.error('target keyring cleanup failed:', error.message);
    }
    console.log('workdir kept for inspection:', ROOT);
  }
}

main().catch((error) => {
  console.error('KEYRING E2E FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
