'use strict';

const { parseArgs } = require('node:util');

const { doctor } = require('./commands/doctor.cjs');
const { status } = require('./commands/status.cjs');
const { exportCommand } = require('./commands/export.cjs');
const { exportJsonCommand } = require('./commands/export-json.cjs');
const { inspectCommand } = require('./commands/inspect.cjs');
const { importCommand } = require('./commands/import.cjs');
const { fixKeyring } = require('./commands/fix-keyring.cjs');
const { EXIT, ZcodeSyncError } = require('./errors.cjs');
const ui = require('./ui.cjs');
const pkg = require('../package.json');

const USAGE = `zcode-sync ${pkg.version} — ZCode 已登录凭据跨机迁移

用法：
  zcode-sync doctor   [--json] [--home DIR] [--credentials-file PATH]
  zcode-sync status   [--json] [--home DIR] [--credentials-file PATH]
  zcode-sync export   [-o FILE|-] [--include-device-id] [--allow-running] [--force]
  zcode-sync export-json [-o FILE|-] [--allow-running] [--force]
                      # 明文 JSON token 文件，供未安装 ZCode 的机器导入
  zcode-sync inspect  FILE|- [--json]
  zcode-sync import   FILE|- [--dry-run] [--mode os|env] [--secret-file PATH]
                      [--device-id keep|clone] [--replace-all|--merge]
                      [--restart] [--force] [--keep-backups N]
  zcode-sync fix-keyring [--dry-run] [--force] [--source DIR] [--install-dir DIR]
                      [--quiet|--auto] [--json]

通用选项：
  --home DIR               ZCode 数据目录（等价 ZCODE_HOME，默认 ~/.zcode）
  --credentials-file PATH  直接指定 credentials.json
  --passphrase-file FILE   从文件读取迁移包口令（0600，适合脚本）
  --json                   机器可读输出
  --verbose                出错时输出堆栈
  -h, --help               显示帮助
  -V, --version            显示版本

安全提示：
  - 迁移包包含完整账号凭据，请只通过可信渠道传输，并使用强口令。
  - export-json 产生的是明文 token 文件（无口令），仅用于未安装 ZCode 的机器；传输后请删除。
  - 仅用于你本人拥有的账号；token 共享可能触发服务端设备限制。
  - import 默认要求 ZCode 已退出，写入前会自动备份目标凭据。

fix-keyring 说明：
  ZCode 自带的 keyring 原生模块动态依赖 VCRUNTIME140.dll；Windows Sandbox 等
  镜像没有 VC++ 运行时，ZCode 就会报 "System credential storage is unavailable"。
  该命令把系统里已有的一份 vcruntime140*.dll（优先取 Edge / WebView2 自带的，
  它们随浏览器安装、版本比 redist 还新）复制到 addon 同目录 —— 不改 System32、
  不需要管理员权限、不装 redist。zcode-sync.cmd 会在检测到环境缺失时自动调用。`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean' },
  home: { type: 'string' },
  'credentials-file': { type: 'string' },
  out: { type: 'string', short: 'o' },
  'include-device-id': { type: 'boolean' },
  'allow-running': { type: 'boolean' },
  'passphrase-file': { type: 'string' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  mode: { type: 'string' },
  'secret-file': { type: 'string' },
  'device-id': { type: 'string' },
  'replace-all': { type: 'boolean' },
  merge: { type: 'boolean' },
  restart: { type: 'boolean' },
  'keep-backups': { type: 'string' },
  quiet: { type: 'boolean' },
  auto: { type: 'boolean' },
  source: { type: 'string' },
  'install-dir': { type: 'string' },
};

function usageError(message) {
  const error = new ZcodeSyncError('USAGE', message);
  error.showUsage = true;
  throw error;
}

function parseKeepBackups(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 50) {
    usageError('--keep-backups 必须是 0–50 的整数');
  }
  return parsed;
}

function commonOptions(values) {
  return {
    home: values.home,
    credentialsFile: values['credentials-file'],
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
    passphraseFile: values['passphrase-file'],
    force: Boolean(values.force),
  };
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    ui.error(error.message);
    console.error('运行 zcode-sync --help 查看用法。');
    return EXIT.USAGE;
  }

  const values = parsed.values || {};
  const positionals = parsed.positionals || [];

  if (values.version) {
    console.log(pkg.version);
    return EXIT.OK;
  }
  if (values.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  if (positionals.length === 0) {
    console.log(USAGE);
    return EXIT.USAGE;
  }

  const command = positionals.shift();
  const common = commonOptions(values);

  try {
    if (command === 'doctor') {
      if (positionals.length > 0) usageError('doctor 不接受位置参数');
      return (await doctor(common)).exitCode;
    }

    if (command === 'status') {
      if (positionals.length > 0) usageError('status 不接受位置参数');
      return (await status(common)).exitCode;
    }

    if (command === 'export') {
      if (positionals.length > 0) usageError('export 不接受位置参数');
      return (
        await exportCommand({
          ...common,
          out: values.out,
          includeDeviceId: Boolean(values['include-device-id']),
          allowRunning: Boolean(values['allow-running']),
        })
      ).exitCode;
    }

    if (command === 'export-json') {
      if (positionals.length > 0) usageError('export-json 不接受位置参数');
      return (
        await exportJsonCommand({
          ...common,
          out: values.out,
          allowRunning: Boolean(values['allow-running']),
        })
      ).exitCode;
    }

    if (command === 'inspect') {
      if (positionals.length !== 1) usageError('inspect 需要且只需要一个迁移包路径（或 -）');
      return (
        await inspectCommand({
          ...common,
          file: positionals[0],
        })
      ).exitCode;
    }

    if (command === 'import') {
      if (positionals.length !== 1) usageError('import 需要且只需要一个迁移包路径（或 -）');
      return (
        await importCommand({
          ...common,
          file: positionals[0],
          dryRun: Boolean(values['dry-run']),
          mode: values.mode,
          secretFile: values['secret-file'],
          deviceId: values['device-id'],
          replaceAll: Boolean(values['replace-all']),
          merge: Boolean(values.merge),
          restart: Boolean(values.restart),
          keepBackups: parseKeepBackups(values['keep-backups']),
        })
      ).exitCode;
    }

    if (command === 'fix-keyring') {
      if (positionals.length > 0) usageError('fix-keyring 不接受位置参数');
      return (
        await fixKeyring({
          ...common,
          dryRun: Boolean(values['dry-run']),
          quiet: Boolean(values.quiet),
          auto: Boolean(values.auto),
          sourceDir: values.source,
          installDir: values['install-dir'],
        })
      ).exitCode;
    }

    usageError(`未知命令：${command}`);
  } catch (error) {
    if (error instanceof ZcodeSyncError) {
      if (common.json) {
        ui.json({ ok: false, ...error.toJSON() });
      } else {
        ui.error(error.message);
        if (error.showUsage) console.error('运行 zcode-sync --help 查看用法。');
      }
      if (common.verbose && error.stack) console.error(error.stack);
      return error.exitCode;
    }
    if (error && error.code === 'CANCELLED') {
      ui.error('已取消');
      return 130;
    }
    ui.error(error && error.message ? error.message : String(error));
    if (common.verbose && error && error.stack) console.error(error.stack);
    return EXIT.GENERIC;
  }

  return EXIT.GENERIC;
}

module.exports = { main, USAGE };
