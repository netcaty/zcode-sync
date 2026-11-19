'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { fail } = require('./errors.cjs');
const cryptoLib = require('./crypto.cjs');
const credentials = require('./credentials.cjs');

const MAGIC = Buffer.from([0x5a, 0x43, 0x53, 0x59, 0x4e, 0x43, 0x00, 0x00]); // "ZCSYNC\0\0"
const VERSION = 1;
const KDF_SCRYPT = 1;
const KDF_ARGON2ID = 2;
const DEFAULT_SCRYPT = Object.freeze({ N: 1 << 16, r: 8, p: 1, keyLen: 32 });
const TAG_LEN = 16;
const NONCE_LEN = 12;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_KDF_MEMORY = 512 * 1024 * 1024;

function u32be(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function readU32be(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function deriveScryptKey(passphrase, salt, params) {
  const N = params.N;
  const r = params.r;
  const p = params.p;
  const keyLen = params.keyLen;
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0) {
    fail('BUNDLE_INVALID', `迁移包 scrypt N 参数无效：${N}`);
  }
  if (!Number.isInteger(r) || r < 1 || r > 16) {
    fail('BUNDLE_INVALID', `迁移包 scrypt r 参数无效：${r}`);
  }
  if (!Number.isInteger(p) || p < 1 || p > 8) {
    fail('BUNDLE_INVALID', `迁移包 scrypt p 参数无效：${p}`);
  }
  if (keyLen !== 32) {
    fail('BUNDLE_INVALID', `迁移包 scrypt keyLen 参数无效：${keyLen}`);
  }
  const memory = 128 * N * r;
  if (memory > MAX_KDF_MEMORY) {
    fail('BUNDLE_INVALID', '迁移包 KDF 内存参数过大，已拒绝执行');
  }
  const maxmem = Math.max(256 * 1024 * 1024, memory + 1024 * 1024);
  try {
    return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, keyLen, {
      N,
      r,
      p,
      maxmem,
    });
  } catch (error) {
    fail('CRYPTO', `KDF 派生失败：${error.message}`, { cause: error });
  }
}

function deriveArgon2Key(passphrase, salt, params) {
  if (typeof crypto.argon2Sync !== 'function') {
    fail('CRYPTO', '当前 Node/Electron 运行时未启用 Argon2id，无法解密该迁移包');
  }
  try {
    return crypto.argon2Sync('argon2id', {
      message: Buffer.from(passphrase, 'utf8'),
      nonce: salt,
      parallelism: params.parallelism,
      tagLength: 32,
      memory: params.memory,
      passes: params.passes,
    });
  } catch (error) {
    fail('CRYPTO', `Argon2id 派生失败：${error.message}`, { cause: error });
  }
}

function deriveBundleKey(passphrase, salt, kdf) {
  if (!kdf || typeof kdf !== 'object') {
    fail('BUNDLE_INVALID', '迁移包缺少 KDF 参数');
  }
  if (kdf.id === 'scrypt') return deriveScryptKey(passphrase, salt, kdf);
  if (kdf.id === 'argon2id') return deriveArgon2Key(passphrase, salt, kdf);
  fail('BUNDLE_INVALID', `不支持的迁移包 KDF：${kdf.id}`);
}

function encryptWithAad(key, nonce, plaintext, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ciphertext, tag]);
}

function decryptWithAad(key, nonce, ciphertextAndTag, aad) {
  if (ciphertextAndTag.length <= TAG_LEN) {
    fail('CRYPTO', '迁移包内容过短或已损坏');
  }
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - TAG_LEN);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function buildPayload(options = {}) {
  const plainMap = options.plainMap;
  if (!plainMap || typeof plainMap !== 'object' || Array.isArray(plainMap)) {
    fail('USAGE', '内部错误：迁移包缺少 credentials map');
  }
  for (const [name, value] of Object.entries(plainMap)) {
    if (typeof value !== 'string') {
      fail('CORRUPT_CREDENTIALS', `凭据 ${name} 的值不是字符串`);
    }
  }
  const source = options.source || {};
  return {
    format: 1,
    createdAt: new Date().toISOString(),
    source: {
      platform: source.platform || process.platform,
      arch: source.arch || process.arch,
      zcodeVersion: source.zcodeVersion || null,
      credentialsPath: source.credentialsPath || null,
      keySource: source.keySource || null,
      deviceMid: source.deviceMid || null,
    },
    summary: options.summary || null,
    credentials: { ...plainMap },
  };
}

function encryptBundle(payload, passphrase, options = {}) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    fail('PASSPHRASE_REQUIRED', '迁移包口令不能为空');
  }
  if (!payload || typeof payload !== 'object') {
    fail('USAGE', '内部错误：迁移包 payload 无效');
  }
  const kdfParams = options.kdf || DEFAULT_SCRYPT;
  if (kdfParams.id && kdfParams.id !== 'scrypt') {
    fail('USAGE', '当前版本只支持创建 scrypt 迁移包');
  }
  const salt = cryptoLib.randomBytes(16);
  const nonce = cryptoLib.randomBytes(NONCE_LEN);
  const kdf = {
    id: 'scrypt',
    N: kdfParams.N,
    r: kdfParams.r,
    p: kdfParams.p,
    keyLen: 32,
    salt: salt.toString('base64url'),
  };
  const header = {
    v: 1,
    createdAt: new Date().toISOString(),
    kdf,
    aead: {
      id: 'aes-256-gcm',
      nonce: nonce.toString('base64url'),
      tagLen: TAG_LEN,
    },
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.length > MAX_HEADER_BYTES) {
    fail('USAGE', '迁移包 header 过大');
  }
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const prefix = Buffer.concat([
    MAGIC,
    Buffer.from([VERSION, KDF_SCRYPT]),
    u32be(headerBytes.length),
  ]);
  const aad = Buffer.concat([prefix, headerBytes]);
  const key = deriveBundleKey(passphrase, salt, kdf);
  const ciphertext = encryptWithAad(key, nonce, payloadBytes, aad);
  const bundle = Buffer.concat([prefix, headerBytes, ciphertext]);
  if (bundle.length > MAX_BUNDLE_BYTES) {
    fail('USAGE', '迁移包超过大小限制');
  }
  return bundle;
}

function parseHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MAGIC.length + 6) {
    fail('BUNDLE_INVALID', '不是有效的 zcode-sync 迁移包');
  }
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    fail('BUNDLE_INVALID', '不是有效的 zcode-sync 迁移包（magic 不匹配）');
  }
  let offset = MAGIC.length;
  const version = buffer[offset];
  offset += 1;
  const kdfId = buffer[offset];
  offset += 1;
  if (version !== VERSION) {
    fail('BUNDLE_INVALID', `不支持的迁移包版本：${version}`);
  }
  if (kdfId !== KDF_SCRYPT && kdfId !== KDF_ARGON2ID) {
    fail('BUNDLE_INVALID', `不支持的迁移包 KDF id：${kdfId}`);
  }
  const headerLen = readU32be(buffer, offset);
  offset += 4;
  if (headerLen <= 0 || headerLen > MAX_HEADER_BYTES) {
    fail('BUNDLE_INVALID', '迁移包 header 长度无效');
  }
  if (buffer.length < offset + headerLen) {
    fail('BUNDLE_INVALID', '迁移包内容被截断');
  }
  const headerBytes = buffer.subarray(offset, offset + headerLen);
  let header;
  try {
    header = JSON.parse(headerBytes.toString('utf8'));
  } catch (error) {
    fail('BUNDLE_INVALID', '迁移包 header 不是有效 JSON', { cause: error });
  }
  if (!header || header.v !== 1) {
    fail('BUNDLE_INVALID', '不支持的迁移包 header 版本');
  }
  const prefix = buffer.subarray(0, offset);
  return {
    version,
    kdfId,
    header,
    headerBytes,
    aad: Buffer.concat([prefix, headerBytes]),
    payloadOffset: offset + headerLen,
  };
}

function decryptBundle(buffer, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    fail('PASSPHRASE_REQUIRED', '需要迁移包口令');
  }
  if (!Buffer.isBuffer(buffer)) {
    fail('BUNDLE_INVALID', '迁移包必须是二进制数据');
  }
  if (buffer.length > MAX_BUNDLE_BYTES) {
    fail('BUNDLE_INVALID', '迁移包超过大小限制');
  }
  const parsed = parseHeader(buffer);
  const header = parsed.header;
  const kdf = header.kdf;
  const aead = header.aead;
  if (!kdf || typeof kdf !== 'object') {
    fail('BUNDLE_INVALID', '迁移包缺少 KDF 参数');
  }
  if (!aead || aead.id !== 'aes-256-gcm') {
    fail('BUNDLE_INVALID', `不支持的迁移包加密算法：${aead && aead.id}`);
  }
  if (aead.tagLen !== TAG_LEN) {
    fail('BUNDLE_INVALID', '迁移包 GCM tag 长度无效');
  }
  let salt;
  let nonce;
  try {
    salt = cryptoLib.b64urlDecode(kdf.salt);
    nonce = cryptoLib.b64urlDecode(aead.nonce);
  } catch {
    fail('BUNDLE_INVALID', '迁移包 KDF salt/nonce 编码无效');
  }
  if (salt.length < 8 || salt.length > 64) {
    fail('BUNDLE_INVALID', '迁移包 KDF salt 长度无效');
  }
  if (nonce.length !== NONCE_LEN) {
    fail('BUNDLE_INVALID', '迁移包 nonce 长度无效');
  }
  if (parsed.kdfId === KDF_SCRYPT && kdf.id !== 'scrypt') {
    fail('BUNDLE_INVALID', '迁移包 KDF 标识不一致');
  }
  if (parsed.kdfId === KDF_ARGON2ID && kdf.id !== 'argon2id') {
    fail('BUNDLE_INVALID', '迁移包 KDF 标识不一致');
  }
  const key = deriveBundleKey(passphrase, salt, kdf);
  const ciphertext = buffer.subarray(parsed.payloadOffset);
  let plaintext;
  try {
    plaintext = decryptWithAad(key, nonce, ciphertext, parsed.aad);
  } catch (error) {
    if (error.code === 'CRYPTO') throw error;
    fail('CRYPTO', '迁移包口令错误或文件已损坏', { cause: error });
  }
  let payload;
  try {
    payload = JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    fail('BUNDLE_INVALID', '迁移包明文不是有效 JSON（口令可能错误）', { cause: error });
  }
  validatePayload(payload);
  return { payload, header };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('BUNDLE_INVALID', '迁移包 payload 格式无效');
  }
  if (payload.format !== 1) {
    fail('BUNDLE_INVALID', `不支持的 payload 版本：${payload.format}`);
  }
  const map = payload.credentials;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    fail('BUNDLE_INVALID', '迁移包缺少 credentials');
  }
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== 'string') {
      fail('BUNDLE_INVALID', `迁移包凭据 ${name} 的值不是字符串`);
    }
  }
  return payload;
}

function inspectBundle(buffer, passphrase) {
  const { payload, header } = decryptBundle(buffer, passphrase);
  const credentialNames = Object.keys(payload.credentials).sort();
  return {
    bundle: {
      version: VERSION,
      createdAt: header.createdAt,
      kdf: header.kdf.id,
      aead: header.aead.id,
    },
    createdAt: payload.createdAt,
    source: {
      platform: payload.source?.platform || null,
      arch: payload.source?.arch || null,
      zcodeVersion: payload.source?.zcodeVersion || null,
      credentialsPath: payload.source?.credentialsPath || null,
      keySource: payload.source?.keySource || null,
      hasDeviceMid: Boolean(payload.source?.deviceMid),
    },
    summary: payload.summary || null,
    credentialNames,
    credentialCount: credentialNames.length,
  };
}

async function readBundleInput(file) {
  if (file === '-') {
    if (process.stdin.isTTY) {
      fail('USAGE', '没有从标准输入收到迁移包；请用管道或指定文件路径');
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_BUNDLE_BYTES) {
        fail('BUNDLE_INVALID', '从标准输入读取的迁移包超过大小限制');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail('BUNDLE_INVALID', `迁移包不存在：${file}`);
    }
    fail('IO', `无法读取迁移包：${file}`, { cause: error });
  }
  if (!stat.isFile()) fail('BUNDLE_INVALID', `迁移包不是普通文件：${file}`);
  if (stat.size > MAX_BUNDLE_BYTES) fail('BUNDLE_INVALID', '迁移包超过大小限制');
  try {
    return fs.readFileSync(file);
  } catch (error) {
    fail('IO', `无法读取迁移包：${file}`, { cause: error });
  }
}

async function writeBundleOutput(file, buffer, options = {}) {
  if (file === '-') {
    if (process.stdout.isTTY && !options.allowTty) {
      fail('USAGE', '拒绝把二进制迁移包直接写入终端；请重定向到文件或使用 -o FILE');
    }
    await new Promise((resolve, reject) => {
      process.stdout.write(buffer, (error) => (error ? reject(error) : resolve()));
    });
    return null;
  }
  const resolved = require('path').resolve(file);
  if (fs.existsSync(resolved) && !options.force) {
    fail('IO', `输出文件已存在：${resolved}（加 --force 覆盖）`);
  }
  credentials.writeAtomic(resolved, buffer, { mode: 0o600 });
  return resolved;
}

module.exports = {
  MAGIC,
  VERSION,
  DEFAULT_SCRYPT,
  MAX_BUNDLE_BYTES,
  buildPayload,
  encryptBundle,
  decryptBundle,
  inspectBundle,
  readBundleInput,
  writeBundleOutput,
  validatePayload,
  parseHeader,
};
