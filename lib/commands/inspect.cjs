'use strict';

const bundle = require('../bundle.cjs');
const passphraseLib = require('../passphrase.cjs');
const ui = require('../ui.cjs');

function buildMetadata(file, payload, header) {
  const names = Object.keys(payload.credentials).sort();
  return {
    ok: true,
    bundle: {
      file: file === '-' ? '-' : require('path').resolve(file),
      version: header.v,
      createdAt: header.createdAt,
      kdf: { id: header.kdf.id, N: header.kdf.N, r: header.kdf.r, p: header.kdf.p },
      aead: header.aead.id,
    },
    payloadCreatedAt: payload.createdAt,
    source: {
      platform: payload.source?.platform || null,
      arch: payload.source?.arch || null,
      zcodeVersion: payload.source?.zcodeVersion || null,
      credentialsPath: payload.source?.credentialsPath || null,
      keySource: payload.source?.keySource || null,
      deviceMid: payload.source?.deviceMid || null,
    },
    account: payload.summary || null,
    credentialNames: names,
    credentialCount: names.length,
  };
}

async function inspectCommand(options = {}) {
  const file = options.file;
  const buffer = await bundle.readBundleInput(file);
  const passphrase = await passphraseLib.getPassphrase({
    passphrase: options.passphrase,
    passphraseFile: options.passphraseFile,
    prompt: '迁移包口令: ',
  });
  const { payload, header } = bundle.decryptBundle(buffer, passphrase);
  const result = buildMetadata(file, payload, header);

  if (options.json) {
    ui.json(result);
    return { exitCode: 0 };
  }

  ui.heading('zcode-sync inspect');
  ui.field('迁移包', result.bundle.file);
  ui.field('创建时间', result.bundle.createdAt);
  ui.field('KDF', `${result.bundle.kdf.id} (N=${result.bundle.kdf.N}, r=${result.bundle.kdf.r}, p=${result.bundle.kdf.p})`);
  ui.field('加密', result.bundle.aead);
  ui.field('源平台', `${result.source.platform || 'unknown'} ${result.source.arch || ''}`.trim());
  ui.field('源 ZCode', result.source.zcodeVersion || 'unknown');
  ui.field('源凭据文件', result.source.credentialsPath || 'unknown');
  ui.field('源存储模式', result.source.keySource || 'unknown');
  ui.field('deviceMid', result.source.deviceMid || '未包含');

  if (result.account) {
    const user = result.account.user || {};
    const account = user.email || user.username || user.displayName || user.id;
    ui.heading('账号');
    if (account) ui.field('账号', `${account}（${user.provider || result.account.activeProvider || 'unknown'}）`);
    ui.field('Active provider', result.account.activeProvider || '未知');
    ui.field('Access token 过期', result.account.accessTokenExpiresAt || '未知');
    ui.field('Refresh token 指纹', result.account.refreshTokenFingerprint || '无');
    ui.field('凭据 key 数', String(result.account.keyCount));
  }

  ui.heading('包含的凭据 key');
  for (const name of result.credentialNames) {
    console.log(`  - ${name}`);
  }
  console.log('');
  ui.ok('迁移包可解密，内容未在终端输出');
  return { exitCode: 0 };
}

module.exports = { inspectCommand };
