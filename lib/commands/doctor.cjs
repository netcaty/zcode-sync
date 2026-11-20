'use strict';

const fs = require('fs');
const path = require('path');

const credentials = require('../credentials.cjs');
const cryptoLib = require('../crypto.cjs');
const keyring = require('../keyring.cjs');
const onboarding = require('../onboarding.cjs');
const paths = require('../paths.cjs');
const processLib = require('../process.cjs');
const ui = require('../ui.cjs');

function storageMode(counts) {
  const active = [];
  if (counts.os > 0) active.push('os');
  if (counts.env > 0) active.push('env');
  if (counts.v1 > 0) active.push('legacy-v1');
  if (counts.plain > 0) active.push('plaintext');
  if (active.length === 0) return 'empty';
  return active.length === 1 ? active[0] : `mixed(${active.join('+')})`;
}

async function doctor(options = {}) {
  const checks = [];
  const add = (id, status, message, hint) => {
    checks.push({ id, status, message, ...(hint ? { hint } : {}) });
  };

  const zcodeInfo = options.zcodeInfo || processLib.getZcodeInfo();
  const credentialsFile = paths.resolveCredentialsFile(options);
  const exists = fs.existsSync(credentialsFile);

  const result = {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    zcode: {
      exe: zcodeInfo.exe,
      version: zcodeInfo.version,
      running: zcodeInfo.running,
      pids: zcodeInfo.processes.map((item) => item.pid),
    },
    credentials: {
      file: credentialsFile,
      exists,
    },
    checks,
  };

  if (process.platform === 'win32') {
    add('platform', 'ok', `Windows 钥匙串后端可用（${process.arch}）`);
  } else {
    add(
      'platform',
      'warn',
      `当前平台 ${process.platform} 的钥匙串后端尚未实现，只能用 --mode env 或等后续版本`,
      'Windows 第一版已完成；macOS/Linux 计划使用 Keychain / Secret Service'
    );
  }

  if (zcodeInfo.exe) {
    add(
      'zcode-install',
      'ok',
      `ZCode：${zcodeInfo.exe}${zcodeInfo.version ? `（${zcodeInfo.version}）` : ''}`
    );
  } else {
    add('zcode-install', 'warn', '未找到 ZCode.exe，无法确定 ZCode 版本');
  }

  if (zcodeInfo.running) {
    add(
      'zcode-running',
      'warn',
      `ZCode 正在运行（PID ${zcodeInfo.processes.map((item) => item.pid).join(', ')}）`,
      'import 前应退出 ZCode；运行中写入可能被内存缓存覆盖'
    );
  } else {
    add('zcode-running', 'ok', 'ZCode 当前未运行');
  }

  if (!exists) {
    add(
      'credentials-file',
      'fail',
      `未找到登录凭据：${credentialsFile}`,
      '请先在 ZCode 中登录；或用 --home / --credentials-file 指定其它 profile'
    );
    result.ok = false;
    return finish(result, options);
  }

  let record;
  try {
    record = credentials.readCredentialsFile(credentialsFile);
  } catch (error) {
    add('credentials-parse', 'fail', error.message);
    result.ok = false;
    return finish(result, options);
  }
  if (!record) {
    add('credentials-file', 'fail', `凭据文件在检查期间消失：${credentialsFile}`);
    result.ok = false;
    return finish(result, options);
  }

  add('credentials-file', 'ok', `凭据文件存在（${Object.keys(record.map).length} 个 key）`);

  let classified;
  try {
    classified = cryptoLib.classifyRawCredentials(record.map);
  } catch (error) {
    add('credentials-format', 'fail', error.message);
    result.ok = false;
    return finish(result, options);
  }
  const counts = classified.counts;
  result.credentials.counts = counts;
  result.credentials.storage = storageMode(counts);

  if (counts.unknown > 0) {
    add(
      'credentials-format',
      'fail',
      `存在 ${counts.unknown} 个未知 enc: 格式凭据`,
      '该版本可能比当前工具新；请升级 zcode-sync'
    );
  } else if (counts.os > 0 && counts.env > 0) {
    add(
      'credentials-format',
      'fail',
      '凭据同时包含 enc:v2:os 与 enc:v2:env 值',
      'ZCode 一次只能使用一种密钥来源，混合值会有一部分无法解密；请重新登录或重新导入'
    );
  } else {
    add('credentials-format', 'ok', `凭据格式：${storageMode(counts)}`);
  }

  const marker = cryptoLib.readCredentialSource(credentialsFile);
  result.credentials.credentialSource = {
    file: marker.file,
    exists: marker.exists,
    valid: marker.valid,
  };
  if (marker.exists && marker.valid && counts.env > 0) {
    add(
      'credential-source',
      'fail',
      'credential-source 锁定 os，但凭据中存在 enc:v2:env 值',
      'ZCode 会走钥匙串，导致 env 值无法解密；请移除 credential-source 或改用 --mode os 重新导入'
    );
  } else if (marker.exists && marker.valid) {
    add('credential-source', 'ok', 'credential-source = os\\n', `路径：${marker.file}`);
  } else if (marker.exists && !marker.valid) {
    add(
      'credential-source',
      'fail',
      `credential-source 内容异常：${JSON.stringify(marker.raw)}`,
      'ZCode 只接受 "os\\n"；否则会报 CREDENTIAL_SECURE_STORAGE_UNAVAILABLE'
    );
  } else if (counts.os > 0) {
    add(
      'credential-source',
      'warn',
      '缺少 credential-source，但存在 enc:v2:os 凭据',
      'ZCode 会根据值内容锁定钥匙串，并在成功后补写标记；建议让 ZCode 正常启动一次'
    );
  } else {
    add('credential-source', 'ok', '未设置 credential-source（非 OS 固定模式）');
  }

  const envSecret = Boolean(process.env.ZCODE_CREDENTIAL_SECRET);
  const envSecretFile = Boolean(process.env.ZCODE_CREDENTIAL_SECRET_FILE);
  if (envSecret && envSecretFile) {
    add(
      'env-secret',
      'fail',
      'ZCODE_CREDENTIAL_SECRET 与 ZCODE_CREDENTIAL_SECRET_FILE 同时设置',
      'ZCode 会拒绝启动凭据存储；请只保留一个'
    );
  } else if (envSecret) {
    add(
      'env-secret',
      counts.os > 0 ? 'fail' : 'warn',
      'ZCODE_CREDENTIAL_SECRET 环境变量已设置',
      counts.os > 0
        ? 'env 密钥会覆盖 OS 钥匙串，导致 enc:v2:os 无法解密；请 unset 该变量'
        : 'ZCode 将使用 env 模式密钥'
    );
  } else if (envSecretFile) {
    add('env-secret', 'ok', 'ZCODE_CREDENTIAL_SECRET_FILE 已设置');
  }

  const secretFile = paths.credentialSecretFile(credentialsFile);
  let secretStat = null;
  try {
    secretStat = fs.statSync(secretFile);
  } catch {
    secretStat = null;
  }
  if (secretStat) {
    const size = secretStat.size;
    const mode = secretStat.mode & 0o777;
    result.credentials.credentialSecret = { file: secretFile, size, mode: mode.toString(8) };
    if (!secretStat.isFile()) {
      add('credential-secret', 'fail', `credential-secret 不是普通文件：${secretFile}`);
    } else if (size < 32 || size > 4096) {
      add(
        'credential-secret',
        'fail',
        `credential-secret 大小异常：${size} 字节（要求 32–4096）`
      );
    } else if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      add(
        'credential-secret',
        'fail',
        `credential-secret 权限过宽：${mode.toString(8)}（要求 0600）`
      );
    } else if (counts.os > 0) {
      add(
        'credential-secret',
        'warn',
        '存在 credential-secret，但 OS 模式会忽略它',
        '若不再需要 env 模式，可手动删除该文件；工具不会自动删除'
      );
    } else {
      add('credential-secret', 'ok', `credential-secret 可用（${size} 字节，mode ${mode.toString(8)}）`);
    }
  }

  const store = options.keyStore || keyring.createCredentialStore();
  const keyringAvailable = store.available();
  const account = paths.pathHash(credentialsFile);
  const keyringTarget = `${account}.${cryptoLib.KEYRING_SERVICE}`;
  result.credentials.keyring = {
    service: cryptoLib.KEYRING_SERVICE,
    account,
    target: keyringTarget,
    available: keyringAvailable,
    hasKey: false,
    fingerprint: null,
  };

  let keyString = null;
  if (keyringAvailable) {
    try {
      keyString = store.get(account);
    } catch (error) {
      add('keyring-read', 'fail', error.message);
    }
  } else {
    add(
      'keyring-availability',
      counts.os > 0 ? 'fail' : 'warn',
      '无法访问 Windows Credential Manager',
      '若是 headless/服务环境，请改用 --mode env 或 ZCODE_CREDENTIAL_SECRET'
    );
  }

  if (keyringAvailable) {
    if (keyString) {
      try {
        const key = cryptoLib.keyFromB64url(keyString);
        const fp = cryptoLib.fingerprint(key);
        result.credentials.keyring.hasKey = true;
        result.credentials.keyring.fingerprint = fp;
        add(
          'keyring-key',
          'ok',
          `找到 ZCode 密钥（fingerprint ${fp.slice(0, 8)}…）`,
          `target=${keyringTarget}`
        );
        const osFingerprints = [
          ...new Set(
            classified.keys
              .filter((item) => item.kind === 'v2' && item.source === 'os')
              .map((item) => item.fingerprint)
          ),
        ];
        if (osFingerprints.length > 0 && !osFingerprints.includes(fp)) {
          add(
            'keyring-fingerprint',
            'fail',
            '钥匙串密钥指纹与 enc:v2:os 凭据不匹配',
            '可能读到了另一个 profile 的密钥；检查 --credentials-file 路径'
          );
        } else if (osFingerprints.length > 0) {
          add('keyring-fingerprint', 'ok', '钥匙串密钥指纹与凭据一致');
        }
      } catch (error) {
        add('keyring-key', 'fail', error.message);
      }
    } else if (counts.os > 0) {
      add(
        'keyring-key',
        'fail',
        '系统钥匙串中没有该凭据文件的 ZCode 密钥',
        `期望 account=${account}；请重新登录 ZCode 或恢复 keyring 条目`
      );
    } else {
      add('keyring-key', 'warn', '系统钥匙串中没有 ZCode 密钥（当前凭据不需要）');
    }
  }

  const addonProbe = options.zcodeKeyringAddon || processLib.probeZcodeKeyringAddon();
  result.zcode.keyringAddon = addonProbe;
  if (addonProbe.supported) {
    if (addonProbe.available) {
      add('zcode-keyring-addon', 'ok', 'ZCode 自带 keyring 原生模块可加载');
    } else {
      const addonStatus = counts.os > 0 ? 'fail' : 'warn';
      add(
        'zcode-keyring-addon',
        addonStatus,
        `ZCode 自带 keyring 原生模块加载失败：${addonProbe.message || addonProbe.reason}`,
        counts.os > 0
          ? 'ZCode 会报 System credential storage is unavailable；先跑 zcode-sync fix-keyring（复用 Edge 自带的运行时），不行再装 Microsoft Visual C++ Redistributable (x64)，或改用 --mode env 重新导入'
          : '当前凭据不需要 OS 钥匙串；env 模式不受影响'
      );
    }
  }

  let plain = null;
  try {
    const decrypted = cryptoLib.decryptCredentialMap(record.map, {
      credentialsFile,
      env: process.env,
      keyStore: store,
    });
    plain = decrypted.plain;
    const summary = credentials.accountSummary(plain);
    result.summary = summary;
    add(
      'decrypt',
      'ok',
      `所有凭据解密成功（${summary.keyCount} 个 key）`
    );
  } catch (error) {
    add('decrypt', 'fail', `凭据解密失败：${error.message}`);
  }

  try {
    fs.accessSync(path.dirname(credentialsFile), fs.constants.W_OK);
    add('writable', 'ok', '凭据目录可写');
  } catch {
    add('writable', 'fail', `凭据目录不可写：${path.dirname(credentialsFile)}`);
  }

  const deviceMid = onboarding.getDeviceMid(credentialsFile);
  result.deviceMid = deviceMid;
  if (deviceMid) {
    add('device-mid', 'ok', `deviceMid：${deviceMid}`);
  } else {
    add('device-mid', 'warn', '未找到 onboarding-record.json 的 deviceMid');
  }

  result.ok = !checks.some((check) => check.status === 'fail');
  return finish(result, options);
}

function finish(result, options) {
  if (options.json) {
    ui.json(result);
  } else {
    ui.heading('zcode-sync doctor');
    ui.field('平台', `${result.platform} ${result.arch}`);
    ui.field(
      'ZCode',
      result.zcode.exe
        ? `${result.zcode.exe}${result.zcode.version ? ` (${result.zcode.version})` : ''}`
        : '未找到'
    );
    ui.field('ZCode 运行中', result.zcode.running ? `是 (PID ${result.zcode.pids.join(', ')})` : '否');
    ui.field('凭据文件', result.credentials.file);
    if (result.credentials.storage) ui.field('存储模式', result.credentials.storage);
    ui.heading('检查结果');
    for (const check of result.checks) {
      ui.check(check.status, check.message, check.hint);
    }
    if (result.summary) {
      const user = result.summary.user;
      const account = user.email || user.username || user.displayName || user.id;
      ui.heading('账号');
      if (account) ui.field('账号', `${account}（${user.provider || 'unknown'}）`);
      ui.field('Access token 过期', result.summary.accessTokenExpiresAt || '未知');
      ui.field(
        'Refresh token 指纹',
        result.summary.refreshTokenFingerprint || '无'
      );
    }
    console.log('');
    if (result.ok) ui.ok('doctor 未发现阻塞问题');
    else ui.error('doctor 发现需要修复的问题');
  }
  return { exitCode: result.ok ? 0 : 1 };
}

module.exports = { doctor };
