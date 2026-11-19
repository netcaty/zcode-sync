'use strict';

const fs = require('fs');

const { fail } = require('./errors.cjs');

function stripOneTrailingNewline(value) {
  return value.replace(/\r?\n$/u, '');
}

function readHidden(promptText) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(
        Object.assign(new Error('no TTY for hidden input'), {
          code: 'PASSPHRASE_REQUIRED',
        })
      );
      return;
    }

    process.stderr.write(promptText);
    let value = '';
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      try {
        stdin.removeListener('data', onData);
        stdin.removeListener('error', onError);
        stdin.setRawMode(false);
        stdin.pause();
      } catch {
        // ignore
      }
    };

    const finish = (fn, arg) => {
      cleanup();
      process.stderr.write('\n');
      fn(arg);
    };

    const onError = (error) => finish(reject, error);

    const onData = (chunk) => {
      const text = String(chunk);
      for (const ch of text) {
        if (ch === '\u0003') {
          finish(reject, Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          finish(resolve, value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        if (ch === '\u001b') continue;
        if (ch < ' ' || ch === '\u009b') continue;
        value += ch;
        process.stderr.write('*');
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('error', onError);
  });
}

async function getPassphrase(options = {}) {
  if (typeof options.passphrase === 'string') return options.passphrase;

  const envValue = process.env.ZCS_PASSPHRASE;
  if (typeof envValue === 'string' && envValue.length > 0) {
    return envValue;
  }

  if (options.passphraseFile) {
    let raw;
    try {
      raw = fs.readFileSync(options.passphraseFile, 'utf8');
    } catch (error) {
      fail('IO', `无法读取口令文件：${options.passphraseFile}`, { cause: error });
    }
    const value = stripOneTrailingNewline(raw);
    if (!value) fail('PASSPHRASE_REQUIRED', '口令文件为空');
    return value;
  }

  if (!process.stdin.isTTY) {
    fail(
      'PASSPHRASE_REQUIRED',
      '当前不是交互式终端，无法安全读取口令；请使用 --passphrase-file <file> 或 ZCS_PASSPHRASE 环境变量。'
    );
  }

  const first = await readHidden(options.prompt || '迁移包口令: ');
  if (!first) fail('PASSPHRASE_REQUIRED', '口令不能为空');
  if (options.minLength && first.length < options.minLength) {
    fail('PASSPHRASE_REQUIRED', `口令至少需要 ${options.minLength} 个字符`);
  }

  if (options.confirm) {
    const second = await readHidden('确认口令: ');
    if (first !== second) {
      fail('PASSPHRASE_REQUIRED', '两次输入的口令不一致');
    }
  }
  return first;
}

module.exports = {
  getPassphrase,
  readHidden,
};
