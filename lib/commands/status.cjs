'use strict';

const credentials = require('../credentials.cjs');
const cryptoLib = require('../crypto.cjs');
const keyring = require('../keyring.cjs');
const onboarding = require('../onboarding.cjs');
const paths = require('../paths.cjs');
const processLib = require('../process.cjs');
const ui = require('../ui.cjs');
const { fail } = require('../errors.cjs');

function storageMode(counts) {
  const active = [];
  if (counts.os > 0) active.push('os');
  if (counts.env > 0) active.push('env');
  if (counts.v1 > 0) active.push('legacy-v1');
  if (counts.plain > 0) active.push('plaintext');
  if (active.length === 0) return 'empty';
  return active.length === 1 ? active[0] : `mixed(${active.join('+')})`;
}

async function status(options = {}) {
  const credentialsFile = paths.resolveCredentialsFile(options);
  const record = credentials.readCredentialsFile(credentialsFile);
  if (!record) {
    fail(
      'NOT_LOGGED_IN',
      `未找到 ZCode 登录凭据：${credentialsFile}。请先在 ZCode 中登录。`
    );
  }

  const store = options.keyStore || keyring.createCredentialStore();
  const decrypted = cryptoLib.decryptCredentialMap(record.map, {
    credentialsFile,
    env: process.env,
    keyStore: store,
  });
  const summary = credentials.accountSummary(decrypted.plain);
  const classified = cryptoLib.classifyRawCredentials(record.map);
  const marker = cryptoLib.readCredentialSource(credentialsFile);
  const zcode = options.zcodeInfo || processLib.getZcodeInfo();
  const deviceMid = onboarding.getDeviceMid(credentialsFile);

  let keyInfo = null;
  try {
    if (classified.counts.os > 0) {
      const account = paths.pathHash(credentialsFile);
      const keyString = store.get(account);
      if (keyString) {
        keyInfo = {
          mode: 'os',
          service: cryptoLib.KEYRING_SERVICE,
          account,
          target: `${account}.${cryptoLib.KEYRING_SERVICE}`,
          fingerprint: cryptoLib.fingerprint(cryptoLib.keyFromB64url(keyString)),
        };
      }
    } else if (classified.counts.env > 0) {
      const secret = cryptoLib.resolveManagedSecret({
        credentialsFile,
        env: process.env,
        force: true,
      });
      if (secret) {
        keyInfo = {
          mode: 'env',
          secretSource: secret.source,
          fingerprint: cryptoLib.fingerprint(cryptoLib.deriveEnvKey(secret.secret)),
        };
      }
    }
  } catch {
    keyInfo = null;
  }

  const result = {
    ok: true,
    zcode: {
      exe: zcode.exe,
      version: zcode.version,
      running: zcode.running,
      pids: zcode.processes.map((item) => item.pid),
    },
    credentials: {
      file: credentialsFile,
      storage: storageMode(classified.counts),
      counts: classified.counts,
      keyCount: Object.keys(record.map).length,
      credentialSource: {
        exists: marker.exists,
        valid: marker.valid,
      },
      key: keyInfo,
    },
    account: summary,
    deviceMid,
  };

  if (options.json) {
    ui.json(result);
    return { exitCode: 0 };
  }

  ui.heading('zcode-sync status');
  ui.field(
    'ZCode',
    zcode.exe
      ? `${zcode.version || 'unknown'}${zcode.running ? `（运行中，PID ${zcode.processes.map((p) => p.pid).join(', ')}）` : '（未运行）'}`
      : '未找到'
  );
  ui.field('凭据文件', credentialsFile);
  ui.field('存储模式', result.credentials.storage);
  if (keyInfo) {
    ui.field(
      '密钥',
      keyInfo.mode === 'os'
        ? `系统钥匙串（fingerprint ${keyInfo.fingerprint.slice(0, 8)}…）`
        : `env（${keyInfo.secretSource}，fingerprint ${keyInfo.fingerprint.slice(0, 8)}…）`
    );
  } else {
    ui.field('密钥', '未知');
  }

  const user = summary.user;
  const account = user.email || user.username || user.displayName || user.id;
  ui.heading('登录状态');
  if (account) {
    ui.field('账号', `${account}（${user.provider || summary.activeProvider || 'unknown'}）`);
  } else {
    ui.field('账号', '未从 user_info 解析到账号名');
  }
  ui.field('Active provider', summary.activeProvider || '未知');
  ui.field('Access token 过期', summary.accessTokenExpiresAt || '未知（非 JWT 或没有 exp）');
  ui.field('Refresh token 指纹', summary.refreshTokenFingerprint || '无');
  ui.field('凭据 key 数', `${summary.keyCount}（身份 ${summary.identityKeyCount}，其他 ${summary.otherKeyCount}）`);
  ui.field('deviceMid', deviceMid || '未找到');

  console.log('');
  ui.ok('已登录（凭据可解密）');
  return { exitCode: 0 };
}

module.exports = { status };
