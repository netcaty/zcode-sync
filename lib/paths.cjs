'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fail } = require('./errors.cjs');

function expandHome(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * ZCODE_HOME points at the ZCode data directory itself (typically ~/.zcode),
 * matching ZCode's own resolveZcodeHome(). --home uses the same convention.
 */
function zcodeHome(options = {}) {
  if (options.home) return path.resolve(expandHome(options.home));
  const fromEnv = (process.env.ZCODE_HOME || '').trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return path.join(os.homedir(), '.zcode');
}

function credentialsCandidates(options = {}) {
  if (options.credentialsFile) {
    return [path.resolve(expandHome(options.credentialsFile))];
  }
  // zcodeHome() already resolves --home, ZCODE_HOME, or ~/.zcode. Do not add
  // a ~/.zcode fallback here: an explicit --home pointing at a not-yet-created
  // profile must never resolve to (and overwrite) the user's live profile.
  const home = zcodeHome(options);
  const candidates = [
    path.join(home, 'v2', 'credentials.json'),
    path.join(home, 'credentials.json'),
  ];
  return [...new Set(candidates.map((p) => path.resolve(p)))];
}

function resolveCredentialsFile(options = {}) {
  const candidates = credentialsCandidates(options);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function credentialsDir(credentialsFile) {
  return path.dirname(path.resolve(credentialsFile));
}

function credentialSourceFile(credentialsFile) {
  return path.join(credentialsDir(credentialsFile), 'credential-source');
}

function credentialSecretFile(credentialsFile) {
  return path.join(credentialsDir(credentialsFile), 'credential-secret');
}

function onboardingFile(credentialsFile) {
  return path.join(credentialsDir(credentialsFile), 'onboarding-record.json');
}

/**
 * ZCode uses Node's path.resolve() before hashing, so we can match it exactly
 * by running inside Node.
 */
function pathHash(credentialsFile) {
  return crypto.createHash('sha256').update(path.resolve(credentialsFile)).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

function isReadableFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultBundlePath(prefix = 'zcode-credentials') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return path.resolve(`${prefix}-${stamp}.zcs`);
}

function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail('CORRUPT_CREDENTIALS', `无法解析 JSON 文件：${file}`, { cause: error });
  }
}

module.exports = {
  expandHome,
  zcodeHome,
  credentialsCandidates,
  resolveCredentialsFile,
  credentialsDir,
  credentialSourceFile,
  credentialSecretFile,
  onboardingFile,
  pathHash,
  ensureDir,
  fileMode,
  isReadableFile,
  defaultBundlePath,
  readJsonFile,
};
