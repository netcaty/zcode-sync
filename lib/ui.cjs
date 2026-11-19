'use strict';

const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(code, text) {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const ui = {
  bold: (text) => wrap('1', text),
  dim: (text) => wrap('2', text),
  red: (text) => wrap('31', text),
  green: (text) => wrap('32', text),
  yellow: (text) => wrap('33', text),
  cyan: (text) => wrap('36', text),

  heading(text, stream = console.log) {
    stream(`\n${ui.bold(text)}`);
  },

  field(label, value, stream = console.log) {
    stream(`  ${ui.dim(`${label}:`)} ${value}`);
  },

  ok(text, stream = console.log) {
    stream(`${ui.green('✓')} ${text}`);
  },

  warn(text) {
    console.error(`${ui.yellow('warning:')} ${text}`);
  },

  error(text) {
    console.error(`${ui.red('error:')} ${text}`);
  },

  check(status, text, hint) {
    if (status === 'ok') console.log(`  ${ui.green('[ok]')}   ${text}`);
    else if (status === 'warn') console.log(`  ${ui.yellow('[warn]')} ${text}`);
    else console.log(`  ${ui.red('[fail]')} ${text}`);
    if (hint) console.log(`         ${ui.dim(hint)}`);
  },

  json(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  },

  bytes(value) {
    if (!Number.isFinite(value)) return 'unknown';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  },
};

module.exports = ui;
