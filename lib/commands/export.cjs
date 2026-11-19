'use strict';

const fs = require('fs');

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

async function exportCommand(options = {}) {
  if (options.json && options.out === '-') {
    fail('USAGE', '--json 不能与 -o - 同时使用（stdout 只能承载一种格式）');
  }

  const credentialsFile = paths.resolveCredentialsFile(options);
  const record = credentials.readCredentialsFile(credentialsFile);
  if (!record) {
    fail(
      'NOT_LOGGED_IN',
      `未找到 ZCode 登录凭据：${credentialsFile}。请先在 ZCode 中登录。`
    );
  }

  const warnings = [];
  const zcode = options.zcodeInfo || processLib.getZcodeInfo();
  if (zcode.running && !options.allowRunning) {
    warnings.push(
      `ZCode 正在运行（PID ${(zcode.processes || []).map((item) => item.pid).join(', ')}）。` +
        '读取是原子的，但建议关闭 ZCode 后重新导出，避免捕获到刷新中的 token；' +
        '确认可以继续时加 --allow-running 可跳过此提示。'
    );
  }
  if (process.env.ZCS_PASSPHRASE) {
    warnings.push('使用了 ZCS_PASSPHRASE 环境变量；环境变量可能被同用户进程读取。');
  }

  const store = options.keyStore || keyring.createCredentialStore();
  const decrypted = cryptoLib.decryptCredentialMap(record.map, {
    credentialsFile,
    env: process.env,
    keyStore: store,
  });
  const summary = credentials.accountSummary(decrypted.plain);
  const storage = storageMode(decrypted.counts);
  const classified = cryptoLib.classifyRawCredentials(record.map);

  if (summary.identityKeyCount === 0) {
    warnings.push('未发现 OAuth/zcodejwttoken 身份凭据；导入后可能仍处于未登录状态。');
  }

  let deviceMid = null;
  if (options.includeDeviceId) {
    deviceMid = onboarding.getDeviceMid(credentialsFile);
    if (!deviceMid) warnings.push('请求包含 deviceMid，但 onboarding-record.json 中没有该字段。');
  }

  const payload = bundle.buildPayload({
    plainMap: decrypted.plain,
    source: {
      platform: process.platform,
      arch: process.arch,
      zcodeVersion: zcode.version,
      credentialsPath: credentialsFile,
      keySource: storage,
      deviceMid,
    },
    summary,
  });

  const passphrase = await passphraseLib.getPassphrase({
    passphrase: options.passphrase,
    passphraseFile: options.passphraseFile,
    confirm: true,
    prompt: '设置迁移包口令: ',
  });

  const encryptedBundle = bundle.encryptBundle(payload, passphrase);
  const bundleSha256 = cryptoLib.sha256(encryptedBundle).toString('hex');
  const output = options.out || paths.defaultBundlePath();
  const writtenPath = await bundle.writeBundleOutput(output, encryptedBundle, {
    force: Boolean(options.force),
  });

  const result = {
    ok: true,
    bundle: {
      file: writtenPath || '-',
      size: encryptedBundle.length,
      sha256: bundleSha256,
      createdAt: payload.createdAt,
    },
    source: {
      credentialsFile,
      platform: process.platform,
      arch: process.arch,
      zcodeVersion: zcode.version,
      storage,
      keyFingerprints: [
        ...new Set(
          classified.keys
            .filter((item) => item.kind === 'v2')
            .map((item) => item.fingerprint)
        ),
      ],
      hasDeviceMid: Boolean(deviceMid),
    },
    account: summary,
    keyNames: Object.keys(decrypted.plain).sort(),
    warnings,
  };

  if (options.json) {
    ui.json(result);
  } else {
    const out = writtenPath ? console.log : console.error;
    out('');
    ui.heading('zcode-sync export', out);
    ui.field('迁移包', writtenPath || '已写入 stdout', out);
    ui.field('大小', ui.bytes(encryptedBundle.length), out);
    ui.field('SHA-256', bundleSha256, out);
    ui.field('凭据文件', credentialsFile, out);
    ui.field('存储模式', storage, out);
    const user = summary.user;
    const account = user.email || user.username || user.displayName || user.id;
    if (account) {
      ui.field('账号', `${account}（${user.provider || summary.activeProvider || 'unknown'}）`, out);
    }
    ui.field('凭据 key 数', String(summary.keyCount), out);
    ui.field('deviceMid', deviceMid || '未包含', out);
    for (const warning of warnings) ui.warn(warning);
    ui.ok('迁移包已生成；请通过安全渠道拷贝到目标机，并牢记口令', out);
  }

  return { exitCode: 0 };
}

module.exports = { exportCommand };
