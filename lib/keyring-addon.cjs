'use strict';

/**
 * ZCode ships `@napi-rs/keyring` as a native addon that dynamically imports
 * VCRUNTIME140.dll. Images without the VC++ runtime (notably Windows Sandbox)
 * fail with "The specified module could not be found" (error 126), and ZCode
 * then reports "System credential storage is unavailable" instead of logging in.
 *
 * Node loads the addon with LoadLibraryEx(..., LOAD_WITH_ALTERED_SEARCH_PATH),
 * so the addon's own directory is searched for its dependencies first. Dropping
 * vcruntime140*.dll next to the .node is therefore enough — no admin rights, no
 * redistributable installer, no System32 changes.
 *
 * The DLLs already exist on most machines: Edge / WebView2 ship their own copy
 * under Application\<version>\. That is the preferred source.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const processLib = require('./process.cjs');
const { ZcodeSyncError } = require('./errors.cjs');

const RUNTIME_DLLS = Object.freeze(['vcruntime140.dll', 'vcruntime140_1.dll']);

function systemRuntimeDir() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32');
}

function addonRelativePath() {
  return path.join(
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@napi-rs',
    'keyring-win32-x64-msvc',
    'keyring.win32-x64-msvc.node'
  );
}

function addonPathFor(installDir) {
  return installDir ? path.join(installDir, addonRelativePath()) : null;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function hasRuntimeDll(dir) {
  return Boolean(dir) && isFile(path.join(dir, RUNTIME_DLLS[0]));
}

function localRuntimeDlls(addonDir) {
  if (!addonDir) return [];
  return RUNTIME_DLLS.filter((name) => isFile(path.join(addonDir, name)));
}

function defaultRuntimeRoots(env = process.env) {
  const roots = [];
  const add = (base) => {
    if (!base) return;
    roots.push(path.join(base, 'Microsoft', 'Edge', 'Application'));
    roots.push(path.join(base, 'Microsoft', 'EdgeWebView', 'Application'));
  };
  add(env['ProgramFiles(x86)']);
  add(env.ProgramFiles);
  add(env.LOCALAPPDATA);
  return roots;
}

function versionParts(name) {
  return name
    .split(/[^0-9]+/u)
    .filter(Boolean)
    .map(Number);
}

function compareVersionParts(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i] === undefined ? 0 : a[i];
    const right = b[i] === undefined ? 0 : b[i];
    if (left !== right) return left - right;
  }
  return 0;
}

/**
 * Find a directory that already contains vcruntime140.dll.
 * Highest build wins, then Edge over WebView2, then newest mtime.
 */
function findRuntimeSource(options = {}) {
  const roots = options.roots || defaultRuntimeRoots();
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (!hasRuntimeDll(dir)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        mtime = 0;
      }
      found.push({
        dir,
        version: entry.name,
        parts: versionParts(entry.name),
        kindRank: /EdgeWebView/iu.test(dir) ? 1 : 0,
        mtime,
      });
    }
  }
  if (found.length === 0) return null;
  found.sort(
    (a, b) =>
      compareVersionParts(b.parts, a.parts) ||
      a.kindRank - b.kindRank ||
      b.mtime - a.mtime
  );
  return found[0];
}

function describeSource(source) {
  if (!source) return null;
  // Edge / WebView2 directories are named after the build, e.g. 157.0.4341.60.
  const kind = /EdgeWebView/iu.test(source.dir) ? 'WebView2' : 'Edge';
  return `${kind} ${source.version}`;
}

/**
 * Copy the runtime DLLs next to the addon. Returns the file names copied.
 */
function patchRuntime(addonDir, sourceDir, options = {}) {
  const dlls = options.dlls || RUNTIME_DLLS;
  const copied = [];
  for (const name of dlls) {
    const from = path.join(sourceDir, name);
    const to = path.join(addonDir, name);
    if (!isFile(from)) {
      if (name === RUNTIME_DLLS[0]) {
        throw new ZcodeSyncError('IO', `源目录缺少 ${name}：${from}`);
      }
      continue;
    }
    try {
      fs.copyFileSync(from, to);
      copied.push(to);
    } catch (error) {
      const denied = error && (error.code === 'EPERM' || error.code === 'EACCES');
      throw new ZcodeSyncError(
        'IO',
        denied
          ? `无权写入 ZCode 安装目录：${addonDir}（请以管理员身份运行）`
          : `复制 ${name} 失败：${error && error.message ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  return copied;
}

/**
 * Load the addon in a fresh process so that a previously failed LoadLibrary is
 * not served from this process's negative cache.
 */
function probeAddonInChild(addonPath, options = {}) {
  const exe = options.zcodeExe || processLib.getZcodeExePath() || process.execPath;
  const script = `require(${JSON.stringify(addonPath)});process.stdout.write('load-ok')`;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawnSync(exe, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error) {
    return { attempted: false, ok: null, reason: child.error.message };
  }
  const stdout = child.stdout || '';
  if (stdout.includes('load-ok')) return { attempted: true, ok: true, reason: 'ok' };
  const stderr = (child.stderr || '').trim().split(/\r?\n/u);
  const detail = stderr.find((line) => /ERR_DLOPEN_FAILED|cannot open|module could not|126/iu.test(line));
  return {
    attempted: true,
    ok: false,
    reason: detail || `exit ${child.status}`,
  };
}

module.exports = {
  RUNTIME_DLLS,
  addonPathFor,
  addonRelativePath,
  compareVersionParts,
  defaultRuntimeRoots,
  describeSource,
  findRuntimeSource,
  hasRuntimeDll,
  isDir,
  isFile,
  localRuntimeDlls,
  patchRuntime,
  probeAddonInChild,
  systemRuntimeDir,
  versionParts,
};
