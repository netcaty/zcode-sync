'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credentials = require('../lib/credentials.cjs');
const cryptoLib = require('../lib/crypto.cjs');
const paths = require('../lib/paths.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-cli-'));
const CLI = path.join(__dirname, '..', 'zcode-sync.cjs');
const SOURCE_HOME = path.join(ROOT, 'source');
const TARGET_HOME = path.join(ROOT, 'target');
const PIPE_HOME = path.join(ROOT, 'pipe-target');
const BUNDLE = path.join(ROOT, 'cli-test.zcs');
const PIPED_BUNDLE = path.join(ROOT, 'piped.zcs');
const PASS_FILE = path.join(ROOT, 'passphrase.txt');
const FAKE_USER_HOME = path.join(ROOT, 'fake-user-home');
const PASSPHRASE = 'cli-e2e-passphrase-123';
const SECRET = 'S'.repeat(43) + 'secret';

const PLAIN = {
  'oauth:active_provider': 'zai',
  'oauth:zai:access_token': 'cli-access-token',
  'oauth:zai:refresh_token': 'cli-refresh-token',
  'oauth:zai:user_info': JSON.stringify({
    email: 'cli@example.com',
    username: 'cli-user',
    id: 'cli-1',
  }),
  zcodejwttoken: 'a.b.c',
};

function writeEnvProfile(homeDir, secret) {
  const dir = path.join(homeDir, 'v2');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'credentials.json');
  const key = cryptoLib.deriveEnvKey(secret);
  credentials.writeCredentialsFile(
    file,
    cryptoLib.encryptCredentialMap(PLAIN, { source: 'env', key })
  );
  fs.writeFileSync(path.join(dir, 'credential-secret'), secret, { mode: 0o600 });
  return file;
}

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOME: FAKE_USER_HOME,
    USERPROFILE: FAKE_USER_HOME,
  };
  delete env.ZCODE_HOME;
  delete env.ZCODE_CREDENTIAL_SECRET;
  delete env.ZCODE_CREDENTIAL_SECRET_FILE;
  delete env.ZCS_PASSPHRASE;
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [CLI, ...args], {
    input: options.input,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${result.status})\nstdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`
    );
  }
}

function readEnvPlain(file) {
  const record = credentials.readCredentialsFile(file);
  return cryptoLib.decryptCredentialMap(record.map, {
    credentialsFile: file,
    env: process.env,
    keyStore: null,
  }).plain;
}

async function main() {
  fs.mkdirSync(FAKE_USER_HOME, { recursive: true });
  fs.writeFileSync(PASS_FILE, `${PASSPHRASE}\n`, { mode: 0o600 });
  writeEnvProfile(SOURCE_HOME, SECRET);

  const exported = runCli([
    'export',
    '--home',
    SOURCE_HOME,
    '-o',
    BUNDLE,
    '--passphrase-file',
    PASS_FILE,
    '--json',
  ]);
  assertSuccess(exported, 'export');
  assert.ok(fs.existsSync(BUNDLE));
  const exportJson = JSON.parse(exported.stdout);
  assert.strictEqual(exportJson.ok, true);
  assert.strictEqual(exportJson.account.user.email, 'cli@example.com');

  const imported = runCli([
    'import',
    BUNDLE,
    '--home',
    TARGET_HOME,
    '--mode',
    'env',
    '--passphrase-file',
    PASS_FILE,
    '--force',
    '--json',
  ]);
  assertSuccess(imported, 'import');
  const targetFile = path.join(TARGET_HOME, 'v2', 'credentials.json');
  const importedJson = JSON.parse(imported.stdout);
  assert.strictEqual(
    importedJson.target.file,
    targetFile,
    '--home must keep the import target inside the selected profile'
  );
  assert.deepStrictEqual(readEnvPlain(targetFile), PLAIN);
  assert.strictEqual(
    fs.existsSync(paths.credentialSourceFile(targetFile)),
    false,
    'env mode must not leave credential-source'
  );
  const targetSecret = fs.readFileSync(paths.credentialSecretFile(targetFile), 'utf8');
  assert.ok(Buffer.byteLength(targetSecret, 'utf8') >= 32);

  const statusResult = runCli([
    'status',
    '--home',
    TARGET_HOME,
    '--json',
  ]);
  assertSuccess(statusResult, 'status');
  const statusJson = JSON.parse(statusResult.stdout);
  assert.strictEqual(statusJson.account.user.email, 'cli@example.com');
  assert.strictEqual(statusJson.credentials.storage, 'env');

  const doctorResult = runCli([
    'doctor',
    '--home',
    TARGET_HOME,
    '--json',
  ]);
  assertSuccess(doctorResult, 'doctor');
  const doctorJson = JSON.parse(doctorResult.stdout);
  assert.strictEqual(doctorJson.ok, true);

  fs.writeFileSync(path.join(ROOT, 'wrong.txt'), 'wrong-passphrase\n');
  const bad2 = runCli([
    'inspect',
    BUNDLE,
    '--passphrase-file',
    path.join(ROOT, 'wrong.txt'),
    '--json',
  ]);
  assert.strictEqual(bad2.status, 6, `wrong passphrase should exit 6, got ${bad2.status}: ${bad2.stdout}${bad2.stderr}`);

  const runningImport = runCli([
    'import',
    BUNDLE,
    '--home',
    TARGET_HOME,
    '--mode',
    'env',
    '--passphrase-file',
    PASS_FILE,
    '--json',
  ]);
  assert.strictEqual(runningImport.status, 5, `import while ZCode is running should exit 5, got ${runningImport.status}`);

  const piped = runCli([
    'export',
    '--home',
    SOURCE_HOME,
    '-o',
    '-',
    '--passphrase-file',
    PASS_FILE,
  ], { encoding: null });
  assertSuccess(piped, 'export -o -');
  assert.ok(Buffer.isBuffer(piped.stdout) && piped.stdout.length > 100);
  fs.writeFileSync(PIPED_BUNDLE, piped.stdout);

  const pipedImport = runCli([
    'import',
    '-',
    '--home',
    PIPE_HOME,
    '--mode',
    'env',
    '--passphrase-file',
    PASS_FILE,
    '--force',
    '--json',
  ], { input: piped.stdout, encoding: 'utf8' });
  assertSuccess(pipedImport, 'import -');
  const pipeTargetFile = path.join(PIPE_HOME, 'v2', 'credentials.json');
  const pipedImportJson = JSON.parse(pipedImport.stdout);
  assert.strictEqual(
    pipedImportJson.target.file,
    pipeTargetFile,
    'piped import must keep the target inside the selected profile'
  );
  assert.deepStrictEqual(readEnvPlain(pipeTargetFile), PLAIN);

  // export-json: plaintext token file for a machine without ZCode installed.
  const TOKEN_FILE = path.join(ROOT, 'zcode-token.json');
  const exportedJson = runCli([
    'export-json', '--home', SOURCE_HOME, '-o', TOKEN_FILE, '--json',
  ]);
  assertSuccess(exportedJson, 'export-json');
  const exportJsonResult = JSON.parse(exportedJson.stdout);
  assert.strictEqual(exportJsonResult.ok, true);
  assert.strictEqual(exportJsonResult.tokenFile.file, TOKEN_FILE);
  const tokenFile = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  assert.strictEqual(tokenFile.format, 1);
  assert.deepStrictEqual(tokenFile.credentials, PLAIN);
  assert.strictEqual(tokenFile.source.keySource, 'env');

  const overwrite = runCli([
    'export-json', '--home', SOURCE_HOME, '-o', TOKEN_FILE, '--json',
  ]);
  assert.strictEqual(overwrite.status, 1, 'overwrite without --force should be refused');
  assert.strictEqual(JSON.parse(overwrite.stdout).error.code, 'FILE_EXISTS');

  const forced = runCli([
    'export-json', '--home', SOURCE_HOME, '-o', TOKEN_FILE, '--force', '--json',
  ]);
  assertSuccess(forced, 'export-json --force');

  const pipedJson = runCli([
    'export-json', '--home', SOURCE_HOME, '-o', '-',
  ]);
  assertSuccess(pipedJson, 'export-json -o -');
  assert.deepStrictEqual(JSON.parse(pipedJson.stdout).credentials, PLAIN);

  console.log('CLI E2E passed');
  console.log('workdir kept for inspection:', ROOT);
}

main().catch((error) => {
  console.error('CLI E2E FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
