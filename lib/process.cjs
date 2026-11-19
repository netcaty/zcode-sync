'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { sleepSync } = require('./credentials.cjs');

const PS_TIMEOUT = 20000;

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      timeout: PS_TIMEOUT,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
}

function parseJsonArray(stdout) {
  const text = (stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  } catch {
    return [];
  }
}

function listZcodeProcesses() {
  if (process.platform !== 'win32') return [];
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$items = Get-CimInstance Win32_Process -Filter "Name='ZCode.exe'" |
  Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine
if ($null -eq $items) { '[]' } else { @($items) | ConvertTo-Json -Compress -Depth 4 }
`;
  const result = runPowerShell(script);
  if (result.error || result.status !== 0) return [];
  return parseJsonArray(result.stdout).map((item) => ({
    pid: Number(item.ProcessId),
    ppid: Number(item.ParentProcessId),
    exe: item.ExecutablePath || null,
    commandLine: item.CommandLine || '',
  }));
}

function ancestorPids(processes, startPid) {
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const ancestors = new Set();
  let current = Number(startPid);
  for (let i = 0; i < 32; i += 1) {
    const entry = byPid.get(current);
    if (!entry) break;
    ancestors.add(entry.pid);
    if (!Number.isFinite(entry.ppid) || entry.ppid === entry.pid) break;
    current = entry.ppid;
  }
  return ancestors;
}

/**
 * Ignore the CLI itself (it may be a ZCode.exe running as Node), its ancestors,
 * and Electron helper processes. What remains is the GUI main process.
 */
function findRunningZcode() {
  const all = listZcodeProcesses();
  const excluded = ancestorPids(all, process.pid);
  excluded.add(process.pid);
  const processes = all.filter((item) => {
    if (excluded.has(item.pid)) return false;
    if (/zcode-sync(?:\.cjs)?/iu.test(item.commandLine)) return false;
    // ZCode spawns ZCode.exe helper processes that run zcode.cjs (agent
    // app-server, plugin hosts, etc.). Only the GUI main process has a bare
    // ZCode.exe command line.
    if (/zcode\.cjs|app-server|__zcode-|--type=/iu.test(item.commandLine)) return false;
    return true;
  });
  return { running: processes.length > 0, processes };
}

function getZcodeExeCandidates() {
  const candidates = [];
  if (process.env.ZCODE_EXE) candidates.push(process.env.ZCODE_EXE);
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'ZCode.exe'));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'ZCode', 'ZCode.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(path.join(process.env['ProgramFiles(x86)'], 'ZCode', 'ZCode.exe'));
  }
  return candidates;
}

function getZcodeExePath() {
  for (const candidate of getZcodeExeCandidates()) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // ignore
    }
  }

  if (process.platform !== 'win32') return null;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $keys |
  Where-Object { $_.DisplayName -like '*ZCode*' } |
  ForEach-Object { $_.DisplayIcon; $_.InstallLocation }
`;
  const result = runPowerShell(script);
  if (!result.error && result.stdout) {
    for (const rawLine of result.stdout.split(/\r?\n/u)) {
      let line = rawLine.trim();
      if (!line) continue;
      line = line.replace(/^"|"$/gu, '').replace(/,\d+$/u, '');
      let candidate = line;
      if (!/\.exe$/iu.test(candidate)) {
        candidate = path.join(candidate, 'ZCode.exe');
      }
      try {
        if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
      } catch {
        // ignore
      }
    }
  }
  return null;
}

const versionCache = new Map();

function getZcodeVersion(exePath) {
  if (!exePath) return null;
  if (versionCache.has(exePath)) return versionCache.get(exePath);
  if (process.platform !== 'win32') return null;
  const escaped = exePath.replace(/'/gu, "''");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$item = Get-Item -LiteralPath '${escaped}'
if ($null -ne $item) { $item.VersionInfo.ProductVersion }
`;
  const result = runPowerShell(script);
  const version = (result.stdout || '').trim() || null;
  versionCache.set(exePath, version);
  return version;
}

function getZcodeInfo() {
  const exe = getZcodeExePath();
  return {
    exe,
    version: exe ? getZcodeVersion(exe) : null,
    ...findRunningZcode(),
  };
}

function getZcodeInstallDir() {
  const fromEnv = (process.env.ZCODE_WINDOWS_APP_INSTALL_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const exe = getZcodeExePath();
  if (exe) return path.dirname(exe);
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode');
  }
  return null;
}

/**
 * ZCode decrypts enc:v2:os credentials with @napi-rs/keyring. If that native
 * addon cannot load (typically a missing VC++ runtime DLL), ZCode reports
 * "System credential storage is unavailable" and cannot log in, even though
 * a PowerShell-based reader can access Credential Manager just fine.
 */
function probeZcodeKeyringAddon() {
  if (process.platform !== 'win32') {
    return { supported: false, available: false, reason: 'not-windows', path: null };
  }
  const installDir = getZcodeInstallDir();
  const addonPath = installDir
    ? path.join(
        installDir,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        '@napi-rs',
        'keyring-win32-x64-msvc',
        'keyring.win32-x64-msvc.node'
      )
    : null;
  if (!addonPath || !fs.existsSync(addonPath)) {
    return { supported: true, available: false, reason: 'addon-not-found', path: addonPath };
  }
  try {
    // Load it in-process; this mirrors the DLL search that ZCode's Electron
    // main process performs for the same addon.
    require(addonPath);
    return { supported: true, available: true, reason: 'ok', path: addonPath };
  } catch (error) {
    return {
      supported: true,
      available: false,
      reason: 'load-failed',
      path: addonPath,
      message: error && error.message ? error.message : String(error),
    };
  }
}

function killZcode(processes) {
  if (!processes || processes.length === 0) return;
  for (const item of processes) {
    if (!Number.isInteger(item.pid)) continue;
    spawnSync('taskkill', ['/PID', String(item.pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
  }
}

function waitForNoZcode(timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!findRunningZcode().running) return true;
    sleepSync(250);
  }
  return !findRunningZcode().running;
}

function startZcode(exePath) {
  if (!exePath) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
  });
  child.unref();
  return true;
}

module.exports = {
  listZcodeProcesses,
  findRunningZcode,
  getZcodeExePath,
  getZcodeVersion,
  getZcodeInfo,
  getZcodeInstallDir,
  probeZcodeKeyringAddon,
  killZcode,
  waitForNoZcode,
  startZcode,
};
