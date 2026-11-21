'use strict';

// Exports the decrypted credential map as a plain JSON token file. Unlike
// `export`, the output is NOT encrypted: it is meant for a machine that has no
// ZCode installed and therefore no keyring to unseal a .zcs bundle. The
// wrapper plugin's "import JSON token" login method reads this file directly.

const fs = require('fs');
const path = require('path');

const bundle = require('../bundle.cjs');
const credentials = require('../credentials.cjs');
const cryptoLib = require('../crypto.cjs');
const keyring = require('../keyring.cjs');
const onboarding = require('../onboarding.cjs');
const paths = require('../paths.cjs');
const processLib = require('../process.cjs');
const ui = require('../ui.cjs');
const { fail } = require('../errors.cjs');

const DEFAULT_OUT = 'zcode-token.json';

function storageMode(counts) {
  const active = [];
  if (counts.os > 0) active.push('os');
  if (counts.env > 0) active.push('env');
  if (counts.v1 > 0) active.push('legacy-v1');
  if (counts.plain > 0) active.push('plaintext');
  return active.length === 0 ? 'empty' : active.length === 1 ? active[0] : `mixed(${active.join('+')})`;
}

async function exportJsonCommand(options = {}) {
  if (options.json && options.out === '-') {
    fail('USAGE', '--json 不能与 -o - 同时使用（stdout 只能承载一种格式）');
  }

  const credentialsFile = paths.resolveCredentialsFile(options);
  const record = credentials.readCredentialsFile(credentialsFile);
  if (!record) {
    fail('NOT_LOGGED_IN', `未找到 ZCode 登录凭据：${credentialsFile}。请先在 ZCode 中登录。`);
  }

  const warnings = [];
  const zcode = options.zcodeInfo || processLib.getZcodeInfo();
  if (zcode.running && !options.allowRunning) {
    warnings.push(
      `ZCode 正在运行（PID ${(zcode.processes || []).map((item) => item.pid).join(', ')}）。` +
        '建议关闭后重新导出，避免捕获到刷新中的 token；确认可以继续时加 --allow-running。'
    );
  }

  const store = options.keyStore || keyring.createCredentialStore();
  const decrypted = cryptoLib.decryptCredentialMap(record.map, {
    credentialsFile,
    env: process.env,
    keyStore: store,
  });
  const summary = credentials.accountSummary(decrypted.plain);
  const storage = storageMode(decrypted.counts);
  if (summary.identityKeyCount === 0) {
    warnings.push('未发现 OAuth/zcodejwttoken 身份凭据；导入后可能仍处于未登录状态。');
  }

  // The token file is self-contained: it always carries deviceMid so a
  // machine without ZCode has no need for onboarding-record.json.
  const deviceMid = onboarding.getDeviceMid(credentialsFile);
  if (!deviceMid) warnings.push('onboarding-record.json 中没有 deviceMid；目标机会生成新的。');

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
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const sha256 = cryptoLib.sha256(Buffer.from(text, 'utf8')).toString('hex');

  let writtenPath = '-';
  if (options.out === '-') {
    process.stdout.write(text);
  } else {
    const raw = options.out || DEFAULT_OUT;
    const output = path.resolve(paths.expandHome(raw));
    if (fs.existsSync(output) && !options.force) {
      fail('FILE_EXISTS', `文件已存在：${output}。确认覆盖请加 --force。`);
    }
    credentials.writeAtomic(output, text, { mode: 0o600 });
    writtenPath = output;
  }

  const result = {
    ok: true,
    tokenFile: { file: writtenPath, size: Buffer.byteLength(text), sha256, createdAt: payload.createdAt },
    source: {
      credentialsFile,
      platform: process.platform,
      arch: process.arch,
      zcodeVersion: zcode.version,
      storage,
      hasDeviceMid: Boolean(deviceMid),
    },
    account: summary,
    keyNames: Object.keys(decrypted.plain).sort(),
    warning: '此文件含明文 token：请只通过可信渠道传输，用完及时删除，不要提交到版本库。',
    warnings,
  };

  if (options.json) {
    ui.json(result);
  } else {
    const out = writtenPath === '-' ? console.error : console.log;
    out('');
    ui.heading('zcode-sync export-json', out);
    ui.field('Token 文件', writtenPath === '-' ? '已写入 stdout' : writtenPath, out);
    ui.field('大小', ui.bytes(Buffer.byteLength(text)), out);
    ui.field('SHA-256', sha256, out);
    ui.field('凭据文件', credentialsFile, out);
    ui.field('存储模式', storage, out);
    ui.field('deviceMid', deviceMid || '未包含', out);
    const user = summary.user;
    const account = user.email || user.username || user.displayName || user.id;
    if (account) ui.field('账号', `${account}（${user.provider || summary.activeProvider || 'unknown'}）`, out);
    ui.field('凭据 key 数', String(summary.keyCount), out);
    for (const warning of warnings) ui.warn(warning);
    ui.warn('此文件含明文 token：请只通过可信渠道传输，用完及时删除。');
    ui.ok('Token 文件已生成；把它拷到未安装 ZCode 的机器，用插件的「导入 JSON token」登录', out);
  }

  return { exitCode: 0 };
}

module.exports = { exportJsonCommand };
