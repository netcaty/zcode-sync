'use strict';

const fs = require('fs');
const path = require('path');

const { fail } = require('./errors.cjs');
const crypto = require('./crypto.cjs');
const paths = require('./paths.cjs');

const BACKUP_TAG = '.zcs-backup-';
const LOCK_TAG = '.zcode-sync.lock';

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy wait fallback for runtimes without SharedArrayBuffer.
    }
  }
}

function validateCredentialMap(map, file) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    fail('CORRUPT_CREDENTIALS', `ZCode 凭据文件格式无效（应为 JSON object）：${file}`);
  }
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== 'string') {
      fail('CORRUPT_CREDENTIALS', `ZCode 凭据 ${name} 的值不是字符串：${file}`);
    }
  }
  return map;
}

function readCredentialsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('IO', `无法读取 ZCode 凭据文件：${file}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    fail(
      'CORRUPT_CREDENTIALS',
      `ZCode 凭据文件不是有效 JSON，已拒绝读取/覆盖：${file}`,
      { cause: error }
    );
  }
  return {
    file,
    raw: raw.toString('utf8'),
    map: validateCredentialMap(parsed, file),
  };
}

function writeAtomic(file, data, options = {}) {
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(file);
  paths.ensureDir(dir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    fail('IO', `无法写入临时文件：${tmp}`, { cause: error });
  }
  try {
    fs.closeSync(fd);
  } catch {
    // ignore
  }

  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) break;
      sleepSync(60);
    }
  }
  if (lastError) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    fail('IO', `无法替换文件（可能被 ZCode/杀毒软件占用）：${file}`, { cause: lastError });
  }

  if (process.platform !== 'win32') {
    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Best effort.
    }
  }
}

function serializeCredentials(map) {
  return `${JSON.stringify(map, null, 2)}\n`;
}

function writeCredentialsFile(file, map) {
  validateCredentialMap(map, file);
  writeAtomic(file, serializeCredentials(map), { mode: 0o600 });
}

function acquireLock(file, options = {}) {
  const staleMs = options.staleMs ?? 10 * 60 * 1000;
  const lockFile = `${file}${LOCK_TAG}`;

  const tryCreate = () => {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
    );
    fs.closeSync(fd);
  };

  try {
    tryCreate();
  } catch (error) {
    if (error.code !== 'EEXIST') {
      fail('IO', `无法创建锁文件：${lockFile}`, { cause: error });
    }
    let stale = false;
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const stat = fs.statSync(lockFile);
      const age = Date.now() - stat.mtimeMs;
      if (age > staleMs) stale = true;
      if (lock && Number.isInteger(lock.pid)) {
        try {
          process.kill(lock.pid, 0);
        } catch (killError) {
          if (killError.code === 'ESRCH') stale = true;
        }
      }
    } catch {
      stale = true;
    }
    if (!stale) {
      fail(
        'IO',
        `另一个 zcode-sync 进程正在操作该凭据文件（锁：${lockFile}）。若确认没有其他进程，请删除该锁文件后重试。`
      );
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // ignore
    }
    try {
      tryCreate();
    } catch (retryError) {
      fail('IO', `无法获取操作锁：${lockFile}`, { cause: retryError });
    }
  }

  let released = false;
  return {
    path: lockFile,
    release() {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // ignore
      }
    },
  };
}

function backupFile(file, stamp) {
  if (!fs.existsSync(file)) return null;
  const dir = path.dirname(file);
  const base = path.basename(file);
  let candidate = path.join(dir, `${base}${BACKUP_TAG}${stamp}`);
  let counter = 0;
  while (fs.existsSync(candidate)) {
    counter += 1;
    candidate = path.join(dir, `${base}${BACKUP_TAG}${stamp}-${counter}`);
  }
  fs.copyFileSync(file, candidate, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(candidate, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
  return candidate;
}

function pruneBackups(file, keep) {
  if (!Number.isInteger(keep) || keep < 0) return;
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}${BACKUP_TAG}`;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of backups.slice(keep)) {
    try {
      fs.unlinkSync(stale.full);
    } catch {
      // ignore
    }
  }
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${String(now.getMilliseconds()).padStart(3, '0')}`
  );
}

function backupCredentialState(credentialsFile, options = {}) {
  const keep = options.keep ?? 5;
  const stamp = timestamp();
  const files = [
    credentialsFile,
    paths.credentialSourceFile(credentialsFile),
    paths.credentialSecretFile(credentialsFile),
    paths.onboardingFile(credentialsFile),
  ];
  const backups = [];
  for (const file of files) {
    const backup = backupFile(file, stamp);
    if (backup) backups.push(backup);
    pruneBackups(file, keep);
  }
  return backups;
}

function writeCredentialSource(credentialsFile) {
  writeAtomic(paths.credentialSourceFile(credentialsFile), 'os\n', { mode: 0o600 });
}

function removeCredentialSource(credentialsFile) {
  try {
    fs.unlinkSync(paths.credentialSourceFile(credentialsFile));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    fail('IO', `无法删除 credential-source：${error.message}`, { cause: error });
  }
}

function readSecretFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('IO', `无法读取密钥文件：${file}`, { cause: error });
  }
}

function writeSecretFile(file, secret) {
  writeAtomic(file, secret, { mode: 0o600 });
}

function isIdentityKey(key) {
  return key === 'zcodejwttoken' || key.startsWith('oauth:');
}

/**
 * Default merge mode keeps non-identity provider credentials from the target
 * and replaces the whole identity/OAuth set with the bundle's set.
 */
function mergeCredentialMaps(options = {}) {
  const bundleMap = options.bundleMap || {};
  const targetMap = options.targetMap || {};
  const mode = options.mode || 'identity';
  if (mode === 'replace-all') return { ...bundleMap };
  if (mode === 'merge') return { ...targetMap, ...bundleMap };
  if (mode !== 'identity') {
    fail('USAGE', `未知的合并模式：${mode}`);
  }
  const result = {};
  for (const [key, value] of Object.entries(targetMap)) {
    if (!isIdentityKey(key)) result[key] = value;
  }
  for (const [key, value] of Object.entries(bundleMap)) {
    result[key] = value;
  }
  return result;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readUserInfo(info) {
  if (!info || typeof info !== 'object') return {};
  const nested = info.user && typeof info.user === 'object' ? info.user : {};
  const data = info.data && typeof info.data === 'object' ? info.data : {};
  return {
    id: firstString(info.id, info.user_id, info.userId, info.uid, nested.id, nested.user_id, data.id),
    email: firstString(info.email, nested.email, data.email),
    username: firstString(info.username, info.user_name, nested.username, data.username),
    displayName: firstString(
      info.displayName,
      info.display_name,
      info.name,
      info.nickname,
      nested.displayName,
      nested.name,
      data.displayName,
      data.name
    ),
    avatarUrl: firstString(info.avatarUrl, info.avatar_url, nested.avatarUrl, data.avatarUrl),
  };
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function tokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !Number.isFinite(payload.exp)) return null;
  return new Date(payload.exp * 1000).toISOString();
}

function accountSummary(plainMap) {
  const activeRaw = plainMap['oauth:active_provider'];
  const activeParsed = parseMaybeJson(activeRaw);
  let activeProvider = null;
  if (typeof activeRaw === 'string' && activeRaw.trim()) {
    activeProvider = activeRaw.trim();
  }
  if (typeof activeParsed === 'string' && activeParsed.trim()) {
    activeProvider = activeParsed.trim();
  } else if (
    activeParsed &&
    typeof activeParsed === 'object' &&
    typeof activeParsed.provider === 'string' &&
    activeParsed.provider.trim()
  ) {
    activeProvider = activeParsed.provider.trim();
  }

  const users = [];
  for (const [name, value] of Object.entries(plainMap)) {
    const match = /^oauth:([^:]+):user_info$/u.exec(name);
    if (!match) continue;
    const info = parseMaybeJson(value);
    if (!info) continue;
    users.push({ provider: match[1], info: readUserInfo(info) });
  }

  let selected = users.find((entry) => entry.provider === activeProvider) || users[0] || null;
  const provider = activeProvider || selected?.provider || null;

  let accessToken = null;
  if (activeProvider) accessToken = plainMap[`oauth:${activeProvider}:access_token`] || null;
  if (!accessToken) {
    const accessKey = Object.keys(plainMap).find((key) => /^oauth:[^:]+:access_token$/u.test(key));
    if (accessKey) accessToken = plainMap[accessKey];
  }
  if (!accessToken) accessToken = plainMap.zcodejwttoken || null;

  let refreshToken = null;
  if (activeProvider) refreshToken = plainMap[`oauth:${activeProvider}:refresh_token`] || null;
  if (!refreshToken) {
    const refreshKey = Object.keys(plainMap).find((key) =>
      /^oauth:[^:]+:refresh_token$/u.test(key)
    );
    if (refreshKey) refreshToken = plainMap[refreshKey];
  }

  let accessTokenExpiresAt = tokenExpiry(accessToken);
  if (!accessTokenExpiresAt) {
    const jwtPayload = decodeJwtPayload(plainMap.zcodejwttoken);
    if (jwtPayload && Number.isFinite(jwtPayload.exp)) {
      accessTokenExpiresAt = new Date(jwtPayload.exp * 1000).toISOString();
    }
  }

  const identityKeys = Object.keys(plainMap).filter(isIdentityKey);
  return {
    activeProvider: provider,
    user: selected
      ? { provider: selected.provider, ...selected.info }
      : { provider: null, id: null, email: null, username: null, displayName: null, avatarUrl: null },
    accessTokenExpiresAt,
    refreshTokenFingerprint: refreshToken
      ? crypto.sha256(Buffer.from(refreshToken, 'utf8')).toString('hex').slice(0, 8)
      : null,
    identityKeyCount: identityKeys.length,
    otherKeyCount: Object.keys(plainMap).length - identityKeys.length,
    keyCount: Object.keys(plainMap).length,
  };
}

module.exports = {
  readCredentialsFile,
  writeCredentialsFile,
  writeAtomic,
  serializeCredentials,
  validateCredentialMap,
  acquireLock,
  backupCredentialState,
  backupFile,
  pruneBackups,
  writeCredentialSource,
  removeCredentialSource,
  readSecretFile,
  writeSecretFile,
  isIdentityKey,
  mergeCredentialMaps,
  accountSummary,
  sleepSync,
};
