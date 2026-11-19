'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const { fail } = require('./errors.cjs');
const crypto = require('./crypto.cjs');

const KEY_STRING_RE = /^[A-Za-z0-9_-]{43}$/;

class WindowsCredentialStore {
  constructor(options = {}) {
    this.service = options.service || crypto.KEYRING_SERVICE;
    this.scriptPath = options.scriptPath || path.join(__dirname, 'credential-manager.ps1');
    this.timeout = options.timeout || 30000;
    this.platform = options.platform || process.platform;
  }

  /**
   * keyring-core / @napi-rs/keyring on Windows stores generic credentials
   * under the target name "<user>.<service>", with UserName = user and the
   * password blob as UTF-16LE. This was verified against ZCode's bundled
   * keyring.win32-x64-msvc.node.
   */
  targetFor(account) {
    return `${account}.${this.service}`;
  }

  _run(request) {
    if (this.platform !== 'win32') {
      fail('UNSUPPORTED_PLATFORM', 'Windows Credential Manager 后端只能在 Windows 上使用');
    }
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.scriptPath,
      ],
      {
        input: JSON.stringify(request),
        encoding: 'utf8',
        timeout: this.timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }
    );

    if (result.error) {
      fail('KEYRING_UNAVAILABLE', `无法启动 PowerShell 访问系统钥匙串：${result.error.message}`, {
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      fail(
        'KEYRING_UNAVAILABLE',
        `PowerShell 访问系统钥匙串失败（exit=${result.status}）：${(result.stderr || '').trim()}`
      );
    }

    const stdout = (result.stdout || '').trim();
    if (!stdout) {
      fail('KEYRING_UNAVAILABLE', 'PowerShell 没有返回钥匙串结果');
    }
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    let response;
    try {
      response = JSON.parse(lines[lines.length - 1]);
    } catch (error) {
      fail('KEYRING_UNAVAILABLE', `无法解析钥匙串返回结果：${stdout.slice(0, 300)}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = response.error || {};
      fail('KEYRING_UNAVAILABLE', `系统钥匙串操作失败：${detail.message || 'unknown error'}`, {
        details: detail,
      });
    }
    return response;
  }

  get(account) {
    const response = this._run({
      action: 'read',
      target: this.targetFor(account),
      user: account,
    });
    if (!response.found) return null;
    const blob = Buffer.from(response.blobB64 || '', 'base64');
    return crypto.keyFromKeyringBlob(blob).toString('base64url');
  }

  set(account, keyString) {
    if (!KEY_STRING_RE.test(keyString)) {
      fail('KEYRING_UNAVAILABLE', '内部错误：要写入系统钥匙串的密钥格式无效');
    }
    const blob = crypto.keyToKeyringBlob(keyString);
    this._run({
      action: 'write',
      target: this.targetFor(account),
      user: account,
      blobB64: blob.toString('base64'),
    });
    const readBack = this.get(account);
    if (readBack !== keyString) {
      fail('KEYRING_UNAVAILABLE', '写入系统钥匙串后读回校验失败');
    }
    return true;
  }

  delete(account) {
    return this._run({
      action: 'delete',
      target: this.targetFor(account),
      user: account,
    }).deleted;
  }

  available() {
    try {
      const probeUser = 'probe';
      const probeService = `zcode-sync-probe-${process.pid}`;
      this._run({
        action: 'read',
        target: `${probeUser}.${probeService}`,
        user: probeUser,
      });
      return true;
    } catch {
      return false;
    }
  }
}

class UnsupportedCredentialStore {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
  }

  _fail() {
    fail(
      'UNSUPPORTED_PLATFORM',
      `当前平台 ${this.platform} 的钥匙串后端尚未实现；Windows 第一版已完成，macOS/Linux 请使用 --mode env 或等待后续版本。`
    );
  }

  get() {
    this._fail();
  }

  set() {
    this._fail();
  }

  delete() {
    this._fail();
  }

  available() {
    return false;
  }
}

class MemoryCredentialStore {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }

  get(account) {
    return this.map.has(account) ? this.map.get(account) : null;
  }

  set(account, keyString) {
    this.map.set(account, keyString);
    return true;
  }

  delete(account) {
    return this.map.delete(account);
  }

  available() {
    return true;
  }
}

function createCredentialStore(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return new WindowsCredentialStore({ ...options, platform });
  return new UnsupportedCredentialStore({ ...options, platform });
}

module.exports = {
  WindowsCredentialStore,
  UnsupportedCredentialStore,
  MemoryCredentialStore,
  createCredentialStore,
};
