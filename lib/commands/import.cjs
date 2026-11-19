'use strict';

const path = require('path');

const bundle = require('../bundle.cjs');
const credentials = require('../credentials.cjs');
const cryptoLib = require('../crypto.cjs');
const keyring = require('../keyring.cjs');
const onboarding = require('../onboarding.cjs');
const paths = require('../paths.cjs');
const processLib = require('../process.cjs');
const passphraseLib = require('../passphrase.cjs');
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

function unique(values) {
  return [...new Set(values)];
}

function keyFingerprints(classified, source) {
  return unique(
    classified.keys
      .filter((item) => item.kind === 'v2' && item.source === source)
      .map((item) => item.fingerprint)
  );
}

async function importCommand(options = {}) {
  if (options.replaceAll && options.merge) {
    fail('USAGE', '--replace-all 与 --merge 不能同时使用');
  }
  const mergeMode = options.replaceAll ? 'replace-all' : options.merge ? 'merge' : 'identity';
  const deviceIdMode = options.deviceId || 'keep';
  if (!['keep', 'clone'].includes(deviceIdMode)) {
    fail('USAGE', '--device-id 只能是 keep 或 clone');
  }
  if (options.mode && !['os', 'env'].includes(options.mode)) {
    fail('USAGE', '--mode 只能是 os 或 env');
  }

  const bundleBuffer = await bundle.readBundleInput(options.file);
  const passphrase = await passphraseLib.getPassphrase({
    passphrase: options.passphrase,
    passphraseFile: options.passphraseFile,
    prompt: '迁移包口令: ',
  });
  const { payload } = bundle.decryptBundle(bundleBuffer, passphrase);
  const bundleMap = payload.credentials;

  const targetFile = paths.resolveCredentialsFile(options);
  const allowedTargets = paths.credentialsCandidates(options).map((item) => path.resolve(item));
  if (!allowedTargets.includes(path.resolve(targetFile))) {
    fail(
      'USAGE',
      `内部安全校验失败：解析出的目标凭据路径不在 --home/--credentials-file 指定范围内：${targetFile}`
    );
  }
  const targetDir = path.dirname(targetFile);
  const zcode = options.zcodeInfo || processLib.getZcodeInfo();
  const warnings = [];

  if (zcode.running && !options.force) {
    fail(
      'ZCODE_RUNNING',
      `ZCode 正在运行（PID ${(zcode.processes || []).map((item) => item.pid).join(', ')}）。` +
        '请先退出 ZCode 后重试；import 不允许在运行中写入（可用 --force，但不推荐）。'
    );
  }
  if (zcode.running && options.force) {
    warnings.push('ZCode 仍在运行；写入可能被内存缓存覆盖，建议关闭后重新导入。');
  }

  let targetRecord = null;
  let targetMap = {};
  let targetClassified = {
    counts: { os: 0, env: 0, v1: 0, plain: 0, unknown: 0 },
    keys: [],
  };
  try {
    targetRecord = credentials.readCredentialsFile(targetFile);
  } catch (error) {
    throw error;
  }
  if (targetRecord && Object.keys(targetRecord.map).length > 0) {
    targetMap = targetRecord.map;
    targetClassified = cryptoLib.classifyRawCredentials(targetMap);
  }

  const store = options.keyStore || keyring.createCredentialStore();
  let targetPlain = {};
  if (targetRecord && Object.keys(targetMap).length > 0 && mergeMode !== 'replace-all') {
    try {
      targetPlain = cryptoLib.decryptCredentialMap(targetMap, {
        credentialsFile: targetFile,
        env: process.env,
        keyStore: store,
      }).plain;
    } catch (error) {
      fail(
        'TARGET_KEY_UNAVAILABLE',
        `无法解密目标机现有凭据，因此无法保留其中的 provider key：${error.message}。` +
          '请加 --replace-all 丢弃目标机现有凭据，或先修复目标机凭据/钥匙串。',
        { cause: error }
      );
    }
  }

  const mergedPlain = credentials.mergeCredentialMaps({
    bundleMap,
    targetMap: targetPlain,
    mode: mergeMode,
  });
  if (Object.keys(mergedPlain).length === 0) {
    fail('BUNDLE_INVALID', '合并后的凭据为空，拒绝写入');
  }
  if (!Object.keys(mergedPlain).some((key) => credentials.isIdentityKey(key))) {
    warnings.push('合并后的凭据里没有 OAuth/zcodejwt 身份凭据，ZCode 可能仍显示未登录。');
  }

  let targetMode = options.mode;
  if (!targetMode) {
    if (targetClassified.counts.env > 0 && targetClassified.counts.os === 0) targetMode = 'env';
    else targetMode = 'os';
  }

  const account = paths.pathHash(targetFile);
  let targetKey = null;
  let keyCreated = false;
  let secret = null;
  let secretSource = null;
  let secretWriteFile = null;

  if (targetMode === 'os') {
    if (process.env.ZCODE_CREDENTIAL_SECRET || process.env.ZCODE_CREDENTIAL_SECRET_FILE) {
      fail(
        'CRYPTO',
        '目标机设置了 ZCODE_CREDENTIAL_SECRET / ZCODE_CREDENTIAL_SECRET_FILE。' +
          'env 密钥会覆盖 OS 钥匙串，导致 enc:v2:os 无法解密；请先 unset 或改用 --mode env。'
      );
    }

    let keyString = null;
    try {
      keyString = store.get(account);
    } catch (error) {
      throw error;
    }

    if (keyString) {
      targetKey = cryptoLib.keyFromB64url(keyString);
      const existingFingerprints = keyFingerprints(targetClassified, 'os');
      if (existingFingerprints.length > 0) {
        const actual = cryptoLib.fingerprint(targetKey);
        if (!existingFingerprints.includes(actual)) {
          if (mergeMode !== 'replace-all') {
            fail(
              'TARGET_KEY_UNAVAILABLE',
              '目标机钥匙串中的密钥与现有 enc:v2:os 凭据指纹不匹配，无法安全合并。' +
                '请检查 --credentials-file 是否指向正确 profile，或使用 --replace-all。'
            );
          }
          if (!options.force) {
            fail(
              'TARGET_KEY_UNAVAILABLE',
              '目标机现有 enc:v2:os 凭据与钥匙串密钥不匹配；--replace-all 会让旧备份不可解密。' +
                '确认后加 --force 继续。'
            );
          }
          warnings.push('目标机旧凭据与钥匙串密钥不匹配；旧备份将无法解密。');
        }
      }
    } else {
      const existingFingerprints = keyFingerprints(targetClassified, 'os');
      if (existingFingerprints.length > 0) {
        if (mergeMode !== 'replace-all') {
          fail(
            'TARGET_KEY_UNAVAILABLE',
            '目标机存在 enc:v2:os 凭据，但系统钥匙串中没有对应密钥。' +
              '请重新登录 ZCode 或恢复钥匙串条目；若确认要丢弃旧凭据，使用 --replace-all --force。'
          );
        }
        if (!options.force) {
          fail(
            'TARGET_KEY_UNAVAILABLE',
            '目标机旧凭据的钥匙串密钥缺失；--replace-all 会让旧备份不可解密。确认后加 --force 继续。'
          );
        }
        warnings.push('目标机旧凭据的钥匙串密钥缺失；旧备份将无法解密。');
      }
      targetKey = cryptoLib.randomBytes(32);
      keyCreated = true;
      if (!options.dryRun) {
        store.set(account, targetKey.toString('base64url'));
      }
    }
  } else {
    if (options.secretFile) {
      const raw = credentials.readSecretFile(paths.expandHome(options.secretFile));
      if (raw === null) fail('IO', `--secret-file 指向的文件不存在：${options.secretFile}`);
      secret = raw;
      secretSource = 'secret-file';
    } else if (process.env.ZCODE_CREDENTIAL_SECRET) {
      secret = process.env.ZCODE_CREDENTIAL_SECRET;
      secretSource = 'env-var';
    } else if (process.env.ZCODE_CREDENTIAL_SECRET_FILE) {
      const file = paths.expandHome(process.env.ZCODE_CREDENTIAL_SECRET_FILE);
      secret = credentials.readSecretFile(file);
      if (secret === null) fail('IO', `ZCODE_CREDENTIAL_SECRET_FILE 指向的文件不存在：${file}`);
      secretSource = 'env-file';
    } else {
      const implicit = credentials.readSecretFile(paths.credentialSecretFile(targetFile));
      if (implicit !== null) {
        secret = implicit;
        secretSource = 'existing-secret-file';
      } else {
        secret = cryptoLib.randomBytes(32).toString('base64url');
        secretSource = 'generated';
      }
    }

    if (process.env.ZCODE_CREDENTIAL_SECRET && process.env.ZCODE_CREDENTIAL_SECRET_FILE) {
      fail(
        'CRYPTO',
        'ZCODE_CREDENTIAL_SECRET 与 ZCODE_CREDENTIAL_SECRET_FILE 同时设置；ZCode 会拒绝凭据存储。'
      );
    }
    if (
      process.env.ZCODE_CREDENTIAL_SECRET &&
      secret !== process.env.ZCODE_CREDENTIAL_SECRET
    ) {
      fail(
        'CRYPTO',
        '选择的 secret 与 ZCODE_CREDENTIAL_SECRET 不一致；ZCode 会使用环境变量，导致密文无法解密。'
      );
    }
    if (process.env.ZCODE_CREDENTIAL_SECRET_FILE) {
      const envSecretFile = paths.expandHome(process.env.ZCODE_CREDENTIAL_SECRET_FILE);
      const envSecret = credentials.readSecretFile(envSecretFile);
      if (envSecret !== null && envSecret !== secret) {
        fail(
          'CRYPTO',
          '选择的 secret 与 ZCODE_CREDENTIAL_SECRET_FILE 内容不一致；ZCode 会使用该文件，导致密文无法解密。'
        );
      }
    }
    const secretBytes = Buffer.byteLength(secret, 'utf8');
    if (secretBytes < 32 || secretBytes > 4096) {
      fail('CRYPTO', `secret 长度必须在 32–4096 字节之间（当前 ${secretBytes}）`);
    }
    secretWriteFile = paths.credentialSecretFile(targetFile);
    targetKey = cryptoLib.deriveEnvKey(secret);
  }

  let zcodeKeyringAddon = null;
  if (targetMode === 'os') {
    zcodeKeyringAddon = options.zcodeKeyringAddon || processLib.probeZcodeKeyringAddon();
    if (zcodeKeyringAddon.supported && !zcodeKeyringAddon.available) {
      warnings.push(
        `目标机 ZCode 自带的 keyring 原生模块无法加载：${zcodeKeyringAddon.message || zcodeKeyringAddon.reason}。` +
          '导入本身会成功，但 ZCode 仍会报 "System credential storage is unavailable" 并无法登录。' +
          '请安装 Microsoft Visual C++ Redistributable (x64)，或使用 --mode env 重新导入。'
      );
    }
  }

  const encrypted = cryptoLib.encryptCredentialMap(mergedPlain, {
    source: targetMode,
    key: targetKey,
  });
  cryptoLib.verifyEncryptedMap(encrypted, { key: targetKey, plainMap: mergedPlain });

  const plan = {
    target: {
      file: targetFile,
      mode: targetMode,
      mergeMode,
      previousStorage: storageMode(targetClassified.counts),
      key: {
        mode: targetMode,
        account: targetMode === 'os' ? account : null,
        fingerprint: cryptoLib.fingerprint(targetKey),
        created: keyCreated,
        ...(targetMode === 'env' ? { secretSource, secretFile: secretWriteFile } : {}),
        ...(zcodeKeyringAddon ? { zcodeKeyringAddon } : {}),
      },
    },
    counts: {
      bundle: Object.keys(bundleMap).length,
      target: Object.keys(targetPlain).length,
      merged: Object.keys(mergedPlain).length,
    },
    deviceId: {
      mode: deviceIdMode,
      sourceDeviceMid: payload.source?.deviceMid || null,
    },
    warnings,
  };

  if (options.dryRun) {
    plan.dryRun = true;
    if (options.json) {
      ui.json({ ok: true, ...plan });
    } else {
      printPlan(plan, true);
      ui.ok('dry-run 完成：没有写入任何文件或钥匙串');
    }
    return { exitCode: 0 };
  }

  paths.ensureDir(targetDir);

  let killed = false;
  if (zcode.running && options.force && options.restart) {
    warnings.push('按 --restart 要求，正在关闭 ZCode 主进程。');
    processLib.killZcode(zcode.processes);
    killed = processLib.waitForNoZcode(8000);
    if (!killed) warnings.push('等待 ZCode 退出超时；仍继续写入。');
  }

  const lock = credentials.acquireLock(targetFile);
  let backups = [];
  try {
    backups = credentials.backupCredentialState(targetFile, {
      keep: Number.isInteger(options.keepBackups) ? options.keepBackups : 5,
    });

    if (targetMode === 'env') {
      credentials.removeCredentialSource(targetFile);
      credentials.writeSecretFile(secretWriteFile, secret);
    }

    credentials.writeCredentialsFile(targetFile, encrypted);

    if (targetMode === 'os') {
      credentials.writeCredentialSource(targetFile);
    }

    if (deviceIdMode === 'clone') {
      const sourceDeviceMid = payload.source?.deviceMid;
      if (sourceDeviceMid) {
        onboarding.setDeviceMid(targetFile, sourceDeviceMid);
      } else {
        warnings.push('迁移包没有包含 deviceMid，已跳过 --device-id clone。');
      }
    }
  } finally {
    lock.release();
  }

  let restarted = false;
  if (options.restart) {
    const exe = zcode.exe || processLib.getZcodeExePath();
    if (exe) {
      restarted = processLib.startZcode(exe);
      if (!restarted) warnings.push(`无法启动 ZCode：${exe}`);
    } else {
      warnings.push('未找到 ZCode.exe，无法自动重启。');
    }
  }

  const result = {
    ok: true,
    ...plan,
    backups,
    zcode: {
      wasRunning: zcode.running,
      killed,
      restarted,
    },
    warnings,
  };

  if (options.json) {
    ui.json(result);
  } else {
    printPlan(plan, false);
    if (backups.length > 0) {
      ui.heading('备份');
      for (const backup of backups) console.log(`  - ${backup}`);
    }
    for (const warning of warnings) ui.warn(warning);
    console.log('');
    ui.ok('导入完成');
    if (restarted) {
      ui.field('ZCode', '已重新启动');
    } else {
      ui.field('下一步', '请重启 ZCode 以加载新凭据');
    }
  }

  return { exitCode: 0 };
}

function printPlan(plan, dryRun) {
  ui.heading(dryRun ? 'zcode-sync import（dry-run）' : 'zcode-sync import');
  ui.field('目标凭据', plan.target.file);
  ui.field('目标模式', `${plan.target.mode}${plan.target.key.created ? '（将生成新密钥）' : '（复用现有密钥）'}`);
  ui.field('合并方式', plan.target.mergeMode);
  ui.field('原存储模式', plan.target.previousStorage);
  ui.field(
    '密钥指纹',
    `${plan.target.key.fingerprint.slice(0, 8)}…${plan.target.key.account ? `（account ${plan.target.key.account}）` : ''}`
  );
  if (plan.target.key.secretSource) {
    ui.field('env secret', `${plan.target.key.secretSource} → ${plan.target.key.secretFile}`);
  }
  ui.field(
    '凭据 key 数',
    `bundle ${plan.counts.bundle}，target 保留 ${plan.counts.target}，result ${plan.counts.merged}`
  );
  ui.field('deviceMid', plan.deviceId.mode);
  if (plan.deviceId.sourceDeviceMid) {
    ui.field('源 deviceMid', plan.deviceId.sourceDeviceMid);
  }
}

module.exports = { importCommand };
