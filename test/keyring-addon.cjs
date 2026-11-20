'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const addon = require('../lib/keyring-addon.cjs');
const { fixKeyring } = require('../lib/commands/fix-keyring.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-addon-'));
let passed = 0;
const failures = [];
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

function silence(fn) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

function write(file, content = 'stub') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeRuntime(root, version, dlls = addon.RUNTIME_DLLS) {
  const dir = path.join(root, version);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of dlls) write(path.join(dir, name), name);
  return dir;
}

/** Fake ZCode install with just the addon file in place. */
function makeFakeZcode(name) {
  const installDir = path.join(ROOT, name);
  write(path.join(installDir, addon.addonRelativePath()), 'stub-node');
  return installDir;
}

test('versionParts / compareVersionParts', () => {
  assert.deepStrictEqual(addon.versionParts('157.0.4341.60'), [157, 0, 4341, 60]);
  assert.deepStrictEqual(addon.versionParts('SetupMetrics'), []);
  assert.ok(addon.compareVersionParts([157, 0, 4341, 60], [157, 0, 4341, 46]) > 0);
  assert.strictEqual(addon.compareVersionParts([157, 0], [157, 0, 0, 0]), 0);
});

test('defaultRuntimeRoots covers Edge and WebView2', () => {
  const roots = addon.defaultRuntimeRoots({
    'ProgramFiles(x86)': 'C:\\PF86',
    ProgramFiles: 'C:\\PF',
    LOCALAPPDATA: 'C:\\LAD',
  });
  assert.deepStrictEqual(roots, [
    'C:\\PF86\\Microsoft\\Edge\\Application',
    'C:\\PF86\\Microsoft\\EdgeWebView\\Application',
    'C:\\PF\\Microsoft\\Edge\\Application',
    'C:\\PF\\Microsoft\\EdgeWebView\\Application',
    'C:\\LAD\\Microsoft\\Edge\\Application',
    'C:\\LAD\\Microsoft\\EdgeWebView\\Application',
  ]);
  assert.deepStrictEqual(addon.defaultRuntimeRoots({}), []);
});

test('findRuntimeSource picks the highest build', () => {
  const edge = path.join(ROOT, 'src-high', 'Edge', 'Application');
  makeRuntime(edge, '157.0.4341.46');
  makeRuntime(edge, '158.0.1.2');
  const found = addon.findRuntimeSource({ roots: [edge] });
  assert.strictEqual(path.basename(found.dir), '158.0.1.2');
});

test('findRuntimeSource prefers Edge over WebView2 on equal builds', () => {
  const webview = path.join(ROOT, 'tie', 'EdgeWebView', 'Application');
  const edge = path.join(ROOT, 'tie', 'Edge', 'Application');
  makeRuntime(webview, '157.0.4341.60');
  makeRuntime(edge, '157.0.4341.60');
  const found = addon.findRuntimeSource({ roots: [webview, edge] });
  assert.strictEqual(found.kindRank, 0);
  assert.ok(found.dir.includes(`${path.sep}Edge${path.sep}`));
});

test('findRuntimeSource ignores dirs without the DLL and missing roots', () => {
  const root = path.join(ROOT, 'no-dll', 'Edge', 'Application');
  makeRuntime(root, '157.0.4341.46', ['not-a-dll.dll']);
  assert.strictEqual(addon.findRuntimeSource({ roots: [root] }), null);
  assert.strictEqual(
    addon.findRuntimeSource({ roots: [path.join(ROOT, 'does-not-exist')] }),
    null
  );
});

test('describeSource labels Edge vs WebView2', () => {
  const edge = path.join(ROOT, 'src-high', 'Edge', 'Application', '158.0.1.2');
  const webview = path.join(ROOT, 'tie', 'EdgeWebView', 'Application', '157.0.4341.60');
  assert.strictEqual(addon.describeSource({ dir: edge, version: '158.0.1.2' }), 'Edge 158.0.1.2');
  assert.strictEqual(
    addon.describeSource({ dir: webview, version: '157.0.4341.60' }),
    'WebView2 157.0.4341.60'
  );
  assert.strictEqual(addon.describeSource(null), null);
});

test('patchRuntime copies only the runtime DLLs', () => {
  const source = makeRuntime(path.join(ROOT, 'patch-src'), '1.0.0');
  write(path.join(source, 'unrelated.dll'), 'x');
  const target = path.join(ROOT, 'patch-dst');
  fs.mkdirSync(target, { recursive: true });
  write(path.join(target, 'keep-me.txt'), 'x');

  const copied = addon.patchRuntime(target, source);
  assert.deepStrictEqual(
    copied.map((item) => path.basename(item)),
    ['vcruntime140.dll', 'vcruntime140_1.dll']
  );
  assert.deepStrictEqual(fs.readdirSync(target).sort(), [
    'keep-me.txt',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
  ]);
  assert.deepStrictEqual(addon.localRuntimeDlls(target).sort(), [
    'vcruntime140.dll',
    'vcruntime140_1.dll',
  ]);

  // Second run is idempotent.
  assert.strictEqual(addon.patchRuntime(target, source).length, 2);
});

test('patchRuntime fails when the primary DLL is missing from the source', () => {
  const source = makeRuntime(path.join(ROOT, 'bad-src'), '1.0.0', ['vcruntime140_1.dll']);
  const target = path.join(ROOT, 'bad-dst');
  fs.mkdirSync(target, { recursive: true });
  assert.throws(() => addon.patchRuntime(target, source), /vcruntime140\.dll/u);
});

test('addonPathFor builds the app.asar.unpacked path', () => {
  const dir = path.join('C:', 'ZCode');
  assert.strictEqual(
    addon.addonPathFor(dir),
    path.join(
      dir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      '@napi-rs',
      'keyring-win32-x64-msvc',
      'keyring.win32-x64-msvc.node'
    )
  );
  assert.strictEqual(addon.addonPathFor(null), null);
});

test('fixKeyring refuses to guess when no runtime source exists', async () => {
  const installDir = makeFakeZcode('cli-no-source');
  const emptySystem = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-nosys-'));
  const result = await silence(() =>
    fixKeyring({
      installDir,
      systemDir: emptySystem,
      runtimeRoots: [path.join(ROOT, 'empty-root')],
      verify: false,
      quiet: true,
    })
  );
  assert.strictEqual(result.exitCode, 1);
  assert.strictEqual(result.result.reason, 'no-source');
  assert.deepStrictEqual(result.result.copied, []);
});

test('fixKeyring patches the addon and reports success', async () => {
  const installDir = makeFakeZcode('cli-patch');
  const edgeRoot = path.join(ROOT, 'cli-patch-edge');
  makeRuntime(edgeRoot, '157.0.4341.60');
  const emptySystem = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-nosys2-'));

  const result = await silence(() =>
    fixKeyring({
      installDir,
      systemDir: emptySystem,
      runtimeRoots: [edgeRoot],
      verify: false,
      quiet: true,
    })
  );
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.result.reason, 'patched');
  const addonDir = path.dirname(addon.addonPathFor(installDir));
  assert.deepStrictEqual(addon.localRuntimeDlls(addonDir).sort(), [
    'vcruntime140.dll',
    'vcruntime140_1.dll',
  ]);
});

test('fixKeyring skips when System32 already has the runtime', async () => {
  const installDir = makeFakeZcode('cli-system-ok');
  const systemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-sys-'));
  write(path.join(systemDir, 'vcruntime140.dll'), 'x');

  const result = await silence(() =>
    fixKeyring({
      installDir,
      systemDir,
      runtimeRoots: [path.join(ROOT, 'never-used')],
      verify: false,
      quiet: true,
    })
  );
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.result.reason, 'system-runtime-present');
  const addonDir = path.dirname(addon.addonPathFor(installDir));
  assert.deepStrictEqual(addon.localRuntimeDlls(addonDir), []);
});

test('fixKeyring --dry-run writes nothing', async () => {
  const installDir = makeFakeZcode('cli-dry');
  const edgeRoot = path.join(ROOT, 'cli-dry-edge');
  makeRuntime(edgeRoot, '157.0.4341.60');
  const emptySystem = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-sync-nosys3-'));

  const result = await silence(() =>
    fixKeyring({
      installDir,
      systemDir: emptySystem,
      runtimeRoots: [edgeRoot],
      dryRun: true,
      verify: false,
      quiet: true,
    })
  );
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.result.reason, 'dry-run');
  const addonDir = path.dirname(addon.addonPathFor(installDir));
  assert.deepStrictEqual(addon.localRuntimeDlls(addonDir), []);
});

test('fixKeyring reports a missing addon instead of patching', async () => {
  const installDir = path.join(ROOT, 'cli-no-addon');
  fs.mkdirSync(installDir, { recursive: true });
  const result = await silence(() =>
    fixKeyring({ installDir, verify: false, quiet: true })
  );
  assert.strictEqual(result.exitCode, 1);
  assert.strictEqual(result.result.reason, 'addon-not-found');
});

(async () => {
  for (const item of queue) {
    try {
      await item.fn();
      passed += 1;
      console.log(`ok   ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.error(`FAIL ${item.name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log('');
  console.log(`keyring-addon tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error('failures:', failures.map((item) => item.name).join(', '));
    process.exitCode = 1;
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
})();
