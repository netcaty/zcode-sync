'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const { fail } = require('./errors.cjs');
const paths = require('./paths.cjs');

const V1_PREFIX = 'enc:v1:';
const V2_PREFIX = 'enc:v2:';
const KEYRING_SERVICE = 'ZCode Credential Encryption';
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const KEY_STRING_RE = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_RE = /^[a-f0-9]{24}$/;

function randomBytes(size) {
  if (typeof crypto.randomBytes === 'function') return crypto.randomBytes(size);
  const buffer = Buffer.alloc(size);
  if (typeof crypto.randomFillSync === 'function') {
    crypto.randomFillSync(buffer);
    return buffer;
  }
  crypto.getRandomValues(buffer);
  return buffer;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function fingerprint(key) {
  return sha256(Buffer.from(key)).toString('hex').slice(0, 24);
}

function b64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function b64urlDecode(value) {
  return Buffer.from(value, 'base64url');
}

function isBufferKey(key) {
  return Buffer.isBuffer(key) && key.length === KEY_LEN;
}

function assertKey(key) {
  if (!isBufferKey(key)) {
    fail('CRYPTO', '内部错误：密钥必须是 32 字节');
  }
  return key;
}

function keyToB64url(key) {
  return assertKey(key).toString('base64url');
}

function keyFromB64url(value) {
  if (typeof value !== 'string' || !KEY_STRING_RE.test(value)) {
    fail('KEYRING_UNAVAILABLE', '系统钥匙串中的 ZCode 密钥格式无效');
  }
  const key = b64urlDecode(value);
  if (key.length !== KEY_LEN) {
    fail('KEYRING_UNAVAILABLE', '系统钥匙串中的 ZCode 密钥长度无效');
  }
  return key;
}

function stripTrailingNuls(value) {
  return value.replace(/\u0000+$/u, '');
}

/**
 * ZCode stores the 43-char base64url key as a UTF-16LE credential blob on
 * Windows. Be tolerant of UTF-8 and raw-32-byte stores for other platforms.
 */
function keyFromKeyringBlob(blob) {
  const buffer = Buffer.from(blob);
  if (buffer.length === 0) {
    fail('KEYRING_UNAVAILABLE', '系统钥匙串中的 ZCode 密钥为空');
  }

  const candidates = [];
  if (buffer.length % 2 === 0) candidates.push(stripTrailingNuls(buffer.toString('utf16le')));
  candidates.push(stripTrailingNuls(buffer.toString('utf8')));

  for (const candidate of candidates) {
    if (KEY_STRING_RE.test(candidate)) return keyFromB64url(candidate);
  }

  if (buffer.length === KEY_LEN) return Buffer.from(buffer);

  fail('KEYRING_UNAVAILABLE', '无法识别系统钥匙串中的 ZCode 密钥编码');
}

function keyToKeyringBlob(keyString) {
  if (typeof keyString !== 'string' || !KEY_STRING_RE.test(keyString)) {
    fail('KEYRING_UNAVAILABLE', '内部错误：要写入钥匙串的密钥格式无效');
  }
  return Buffer.from(keyString, 'utf16le');
}

function sealV2(plaintext, key) {
  assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, tag, ciphertext].map(b64urlEncode).join('.');
}

function openV2(payload, key) {
  assertKey(key);
  if (typeof payload !== 'string') {
    fail('CRYPTO', '加密凭据内容格式无效');
  }
  const parts = payload.split('.');
  if (parts.length !== 3 || parts.some((part) => !B64URL_RE.test(part))) {
    fail('CRYPTO', '加密凭据内容格式无效');
  }
  let nonce;
  let tag;
  let ciphertext;
  try {
    [nonce, tag, ciphertext] = parts.map(b64urlDecode);
  } catch {
    fail('CRYPTO', '加密凭据内容格式无效');
  }
  if (nonce.length !== NONCE_LEN || tag.length !== TAG_LEN) {
    fail('CRYPTO', '加密凭据 nonce/tag 长度无效');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    fail('CRYPTO', '无法解密凭据：密钥不匹配或数据已损坏', { cause: error });
  }
}

function parseCredentialValue(value) {
  if (typeof value !== 'string') {
    fail('CORRUPT_CREDENTIALS', 'credentials.json 的值必须是字符串');
  }
  if (value.startsWith(V2_PREFIX)) {
    const rest = value.slice(V2_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 3) {
      fail('CRYPTO', 'enc:v2 凭据格式无效');
    }
    const [source, fp, payload] = parts;
    if (source !== 'os' && source !== 'env') {
      fail('CRYPTO', `不支持的 enc:v2 密钥来源：${source}`);
    }
    if (!FINGERPRINT_RE.test(fp)) {
      fail('CRYPTO', 'enc:v2 凭据指纹格式无效');
    }
    if (payload.split('.').length !== 3) {
      fail('CRYPTO', 'enc:v2 凭据载荷格式无效');
    }
    return { kind: 'v2', source, fingerprint: fp, payload };
  }
  if (value.startsWith(V1_PREFIX)) {
    return { kind: 'v1', payload: value.slice(V1_PREFIX.length) };
  }
  if (value.startsWith('enc:')) {
    return { kind: 'unknown', prefix: value.slice(0, 12) };
  }
  return { kind: 'plain', value };
}

function formatV2Value(source, key, plaintext) {
  if (source !== 'os' && source !== 'env') {
    fail('CRYPTO', `不支持的密钥来源：${source}`);
  }
  return `${V2_PREFIX}${source}:${fingerprint(key)}:${sealV2(plaintext, key)}`;
}

function deriveEnvKey(secret) {
  return sha256(Buffer.from(secret, 'utf8'));
}

function legacyKeyCandidates(env = process.env, options = {}) {
  let username = 'unknown';
  try {
    username = options.username || os.userInfo().username;
  } catch {
    username = 'unknown';
  }
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const fallback = `zcode-credential-fallback:${platform}:${homedir}:${username}`;
  const explicit = env.ZCODE_CREDENTIAL_SECRET;
  const values = [
    explicit || fallback,
    explicit ? explicit.trim() || fallback : fallback,
    fallback,
  ];
  const seen = new Set();
  const keys = [];
  for (const value of values) {
    const key = deriveEnvKey(value);
    const hex = key.toString('hex');
    if (!seen.has(hex)) {
      seen.add(hex);
      keys.push(key);
    }
  }
  return keys;
}

function openV1(payload, env = process.env, options = {}) {
  let lastError;
  for (const key of legacyKeyCandidates(env, options)) {
    try {
      return openV2(payload, key);
    } catch (error) {
      lastError = error;
    }
  }
  fail('CRYPTO', '无法解密 enc:v1 凭据：旧密钥不匹配', { cause: lastError });
}

function readFileStrict(file, label) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('IO', `无法读取${label}：${file}`, { cause: error });
  }
}

function validateSecret(secret, label) {
  const size = Buffer.byteLength(secret, 'utf8');
  if (size < 32 || size > 4096) {
    fail('CRYPTO', `${label} 长度必须在 32–4096 字节之间`);
  }
  return secret;
}

/**
 * Mirrors ZCode's resolveManagedSecret():
 *   ZCODE_CREDENTIAL_SECRET > ZCODE_CREDENTIAL_SECRET_FILE > implicit credential-secret
 * The implicit file is only considered when force = true (i.e. not OS-pinned).
 */
function resolveManagedSecret(options = {}) {
  const env = options.env || process.env;
  const credentialsFile = options.credentialsFile;
  if (!credentialsFile) fail('USAGE', '内部错误：缺少 credentialsFile');
  const hasSecret = Boolean(env.ZCODE_CREDENTIAL_SECRET);
  const hasSecretFile = Boolean(env.ZCODE_CREDENTIAL_SECRET_FILE);
  if (hasSecret && hasSecretFile) {
    fail(
      'CRYPTO',
      'ZCODE_CREDENTIAL_SECRET 与 ZCODE_CREDENTIAL_SECRET_FILE 不能同时设置；ZCode 会拒绝启动凭据存储。'
    );
  }
  if (hasSecret) {
    return { secret: env.ZCODE_CREDENTIAL_SECRET, source: 'env-var' };
  }

  if (hasSecretFile) {
    const file = paths.expandHome(env.ZCODE_CREDENTIAL_SECRET_FILE.trim());
    const raw = readFileStrict(file, 'ZCODE_CREDENTIAL_SECRET_FILE');
    if (raw === null) {
      fail('CRYPTO', `ZCODE_CREDENTIAL_SECRET_FILE 指向的文件不存在：${file}`);
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      fail('CRYPTO', `无法读取 ZCODE_CREDENTIAL_SECRET_FILE：${file}`, { cause: error });
    }
    if (!stat.isFile()) {
      fail('CRYPTO', `ZCODE_CREDENTIAL_SECRET_FILE 不是普通文件：${file}`);
    }
    return {
      secret: validateSecret(raw.toString('utf8'), 'ZCODE_CREDENTIAL_SECRET_FILE'),
      source: 'env-file',
      file,
    };
  }

  if (!options.force) return null;

  const implicit = paths.credentialSecretFile(credentialsFile);
  let raw;
  try {
    raw = fs.readFileSync(implicit);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('CRYPTO', `无法读取凭据密钥文件：${implicit}`, { cause: error });
  }
  let stat;
  try {
    stat = fs.statSync(implicit);
  } catch (error) {
    fail('CRYPTO', `无法读取凭据密钥文件：${implicit}`, { cause: error });
  }
  if (!stat.isFile()) {
    fail('CRYPTO', `凭据密钥路径不是普通文件：${implicit}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail('CRYPTO', `凭据密钥文件权限过宽：${implicit}（需要 0600）`);
  }
  return {
    secret: validateSecret(raw.toString('utf8'), 'credential-secret'),
    source: 'secret-file',
    file: implicit,
  };
}

function readCredentialSource(credentialsFile) {
  const file = paths.credentialSourceFile(credentialsFile);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, raw: null, valid: true, file };
    fail('IO', `无法读取 credential-source：${file}`, { cause: error });
  }
  const text = raw.toString('utf8');
  return { exists: true, raw: text, valid: text === 'os\n', file };
}

function isPinnedToOs(credentialsFile, rawMap) {
  const marker = readCredentialSource(credentialsFile);
  if (marker.exists) return true;
  return Object.values(rawMap || {}).some(
    (value) => typeof value === 'string' && value.startsWith(`${V2_PREFIX}os:`)
  );
}

/**
 * Resolve the active key using ZCode's precedence rules.
 * allowCreate is only for commands that are allowed to initialize a key.
 */
function resolveActiveKey(options = {}) {
  const credentialsFile = options.credentialsFile;
  const env = options.env || process.env;
  const rawMap = options.rawMap || {};
  const keyStore = options.keyStore;
  const allowCreate = Boolean(options.allowCreate);
  const keyringAccount = options.keyringAccount || paths.pathHash(credentialsFile);

  const explicitSecret = resolveManagedSecret({ credentialsFile, env, force: false });
  if (explicitSecret) {
    return {
      key: deriveEnvKey(explicitSecret.secret),
      source: 'env',
      legacySecret: explicitSecret.secret,
      details: { secretSource: explicitSecret.source, secretFile: explicitSecret.file },
    };
  }

  const pinned = isPinnedToOs(credentialsFile, rawMap);
  if (!pinned) {
    const implicitSecret = resolveManagedSecret({ credentialsFile, env, force: true });
    if (implicitSecret) {
      return {
        key: deriveEnvKey(implicitSecret.secret),
        source: 'env',
        legacySecret: implicitSecret.secret,
        details: { secretSource: implicitSecret.source, secretFile: implicitSecret.file },
      };
    }
  }

  if (!keyStore) {
    fail('KEYRING_UNAVAILABLE', '需要访问系统钥匙串，但当前命令没有提供 keyStore');
  }

  let keyString = keyStore.get(keyringAccount);
  if (keyString === null || keyString === undefined) {
    if (!allowCreate) {
      fail(
        'KEYRING_UNAVAILABLE',
        `系统钥匙串中没有 ZCode 密钥（service=${KEYRING_SERVICE}, account=${keyringAccount}）。` +
          '请确认已登录 ZCode，或使用 --mode env。'
      );
    }
    keyString = randomBytes(KEY_LEN).toString('base64url');
    keyStore.set(keyringAccount, keyString);
    const readBack = keyStore.get(keyringAccount);
    if (readBack !== keyString) {
      fail('KEYRING_UNAVAILABLE', '写入系统钥匙串后读回校验失败');
    }
  }

  return {
    key: keyFromB64url(keyString),
    source: 'os',
    legacySecret: undefined,
    details: { keyringService: KEYRING_SERVICE, keyringAccount, keyringString: keyString },
  };
}

function classifyRawCredentials(rawMap) {
  const counts = { os: 0, env: 0, v1: 0, plain: 0, unknown: 0 };
  const keys = [];
  for (const [name, value] of Object.entries(rawMap)) {
    const parsed = parseCredentialValue(value);
    if (parsed.kind === 'v2') counts[parsed.source] += 1;
    else counts[parsed.kind] += 1;
    keys.push({
      name,
      kind: parsed.kind,
      ...(parsed.kind === 'v2' ? { source: parsed.source, fingerprint: parsed.fingerprint } : {}),
    });
  }
  return { counts, keys };
}

function decryptCredentialMap(rawMap, options = {}) {
  const credentialsFile = options.credentialsFile;
  const env = options.env || process.env;
  const keyStore = options.keyStore;
  const keyringAccount = options.keyringAccount || paths.pathHash(credentialsFile);
  const plain = {};
  const kinds = {};
  const counts = { os: 0, env: 0, v1: 0, plain: 0, unknown: 0 };

  let osKey = null;
  let envSecret = null;
  let osKeyError = null;

  for (const [name, value] of Object.entries(rawMap)) {
    const parsed = parseCredentialValue(value);
    kinds[name] = parsed.kind;
    if (parsed.kind === 'plain') {
      plain[name] = value;
      counts.plain += 1;
      continue;
    }
    if (parsed.kind === 'v1') {
      plain[name] = openV1(parsed.payload, env, options);
      counts.v1 += 1;
      continue;
    }
    if (parsed.kind !== 'v2') {
      fail('CRYPTO', `凭据 ${name} 使用了未知的加密格式`);
    }

    if (parsed.source === 'os') {
      if (!osKey) {
        if (osKeyError) throw osKeyError;
        try {
          if (!keyStore) {
            fail('KEYRING_UNAVAILABLE', '需要访问系统钥匙串才能解密 enc:v2:os 凭据');
          }
          const keyString = keyStore.get(keyringAccount);
          if (!keyString) {
            fail(
              'KEYRING_UNAVAILABLE',
              `系统钥匙串中没有 ZCode 密钥（account=${keyringAccount}）`
            );
          }
          osKey = keyFromB64url(keyString);
        } catch (error) {
          osKeyError = error;
          throw error;
        }
      }
      if (fingerprint(osKey) !== parsed.fingerprint) {
        fail(
          'CRYPTO',
          `凭据 ${name} 的指纹与系统钥匙串密钥不匹配；可能读取了另一个 ZCode profile 的密钥`
        );
      }
      plain[name] = openV2(parsed.payload, osKey);
      counts.os += 1;
      continue;
    }

    if (parsed.source === 'env') {
      if (!envSecret) {
        const resolved = resolveManagedSecret({ credentialsFile, env, force: true });
        if (!resolved) {
          fail(
            'CRYPTO',
            '凭据使用 enc:v2:env，但未找到 ZCODE_CREDENTIAL_SECRET、ZCODE_CREDENTIAL_SECRET_FILE 或 credential-secret'
          );
        }
        envSecret = resolved;
      }
      const key = deriveEnvKey(envSecret.secret);
      if (fingerprint(key) !== parsed.fingerprint) {
        fail('CRYPTO', `凭据 ${name} 的指纹与 env 密钥不匹配`);
      }
      plain[name] = openV2(parsed.payload, key);
      counts.env += 1;
      continue;
    }

    fail('CRYPTO', `凭据 ${name} 的密钥来源无效`);
  }

  return { plain, kinds, counts };
}

function encryptCredentialMap(plainMap, options = {}) {
  const source = options.source;
  const key = options.key;
  assertKey(key);
  const encrypted = {};
  for (const [name, value] of Object.entries(plainMap)) {
    if (typeof value !== 'string') {
      fail('CORRUPT_CREDENTIALS', `凭据 ${name} 的值不是字符串`);
    }
    encrypted[name] = formatV2Value(source, key, value);
  }
  return encrypted;
}

function verifyEncryptedMap(encryptedMap, options = {}) {
  const key = options.key;
  const plainMap = options.plainMap;
  assertKey(key);
  for (const [name, value] of Object.entries(encryptedMap)) {
    const parsed = parseCredentialValue(value);
    if (parsed.kind !== 'v2') {
      fail('CRYPTO', `回环校验失败：${name} 不是 v2 凭据`);
    }
    if (fingerprint(key) !== parsed.fingerprint) {
      fail('CRYPTO', `回环校验失败：${name} 指纹不匹配`);
    }
    const plaintext = openV2(parsed.payload, key);
    if (
      plainMap &&
      Object.prototype.hasOwnProperty.call(plainMap, name) &&
      plainMap[name] !== plaintext
    ) {
      fail('CRYPTO', `回环校验失败：${name} 明文不一致`);
    }
  }
  return true;
}

function keyId(key) {
  return fingerprint(key).slice(0, 8);
}

module.exports = {
  V1_PREFIX,
  V2_PREFIX,
  KEYRING_SERVICE,
  KEY_LEN,
  NONCE_LEN,
  TAG_LEN,
  randomBytes,
  sha256,
  fingerprint,
  b64urlEncode,
  b64urlDecode,
  keyToB64url,
  keyFromB64url,
  keyFromKeyringBlob,
  keyToKeyringBlob,
  sealV2,
  openV2,
  parseCredentialValue,
  formatV2Value,
  deriveEnvKey,
  legacyKeyCandidates,
  openV1,
  resolveManagedSecret,
  readCredentialSource,
  isPinnedToOs,
  resolveActiveKey,
  classifyRawCredentials,
  decryptCredentialMap,
  encryptCredentialMap,
  verifyEncryptedMap,
  keyId,
};
