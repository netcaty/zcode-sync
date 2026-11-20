'use strict';

/**
 * `zcode-sync fix-keyring` — repair ZCode's keyring native addon by supplying
 * the VC++ runtime DLL it imports. See lib/keyring-addon.cjs for the why.
 *
 * Runs automatically from zcode-sync.cmd when the environment looks broken,
 * and can be called by hand for diagnosis (--dry-run / --json).
 */

const path = require('path');

const addon = require('../keyring-addon.cjs');
const processLib = require('../process.cjs');
const ui = require('../ui.cjs');
const { EXIT } = require('../errors.cjs');

function fail(result, options, message, extra) {
  result.ok = false;
  result.reason = extra && extra.reason ? extra.reason : 'failed';
  if (extra && extra.hint) result.hint = extra.hint;
  if (options.json) {
    ui.json(result);
  } else if (options.quiet || options.auto) {
    ui.warn(message);
    if (extra && extra.hint) console.error(`         ${ui.dim(extra.hint)}`);
  } else {
    ui.error(message);
    if (extra && extra.hint) console.error(`         ${ui.dim(extra.hint)}`);
  }
  return {
    exitCode: extra && extra.exitCode !== undefined ? extra.exitCode : EXIT.GENERIC,
    result,
  };
}

function report(result, options) {
  if (options.json) {
    ui.json(result);
    return;
  }
  if (options.quiet || options.auto) {
    if (result.copied.length > 0) {
      console.log(
        `[zcode-sync] 已补齐 vcruntime140*.dll（源：${result.sourceLabel}），重启 ZCode 后生效`
      );
    }
    return;
  }

  ui.heading('zcode-sync fix-keyring');
  ui.field('ZCode 目录', result.installDir || '未找到');
  ui.field('keyring addon', result.addon.path || '未找到');
  ui.field(
    '系统 VC 运行时',
    result.systemRuntime.present ? `存在（${result.systemRuntime.dir}）` : '缺失'
  );
  ui.field(
    'addon 旁的运行时',
    result.local.dlls.length > 0 ? result.local.dlls.join(', ') : '无'
  );
  if (result.sourceDir) ui.field('运行时来源', result.sourceLabel);
  ui.heading('处理结果');
  for (const line of result.steps) {
    ui.check(line.status, line.message, line.hint);
  }
  console.log('');
  if (!result.ok) ui.error('keyring 原生模块仍不可用');
  else if (result.reason === 'dry-run') console.log('dry-run：未做任何修改');
  else ui.ok('keyring 原生模块可用');
}

async function fixKeyring(options = {}) {
  const result = {
    ok: true,
    platform: process.platform,
    installDir: null,
    addon: { dir: null, path: null, exists: false },
    systemRuntime: { dir: options.systemDir || addon.systemRuntimeDir(), present: false },
    local: { dlls: [] },
    sourceDir: null,
    sourceLabel: null,
    copied: [],
    probe: null,
    reason: 'ok',
    steps: [],
  };
  const step = (status, message, hint) => {
    result.steps.push({ status, message, ...(hint ? { hint } : {}) });
  };

  if (process.platform !== 'win32') {
    step('warn', `当前平台 ${process.platform} 不需要该修复`);
    result.reason = 'not-windows';
    report(result, options);
    return { exitCode: EXIT.OK, result };
  }

  const installDir = options.installDir
    ? path.resolve(options.installDir)
    : processLib.getZcodeInstallDir();
  result.installDir = installDir;
  if (!installDir) {
    return fail(result, options, '未找到 ZCode 安装目录，无法定位 keyring 原生模块', {
      reason: 'no-zcode',
      hint: '用 --install-dir 指定 ZCode 安装目录，或设置 ZCODE_WINDOWS_APP_INSTALL_DIR',
    });
  }

  const addonPath = addon.addonPathFor(installDir);
  const addonDir = path.dirname(addonPath);
  result.addon = { dir: addonDir, path: addonPath, exists: addon.isFile(addonPath) };
  if (!addon.isFile(addonPath)) {
    return fail(result, options, `keyring 原生模块不存在：${addonPath}`, {
      reason: 'addon-not-found',
      hint: '这个 ZCode 版本可能不带 @napi-rs/keyring；用 --mode env 导入即可',
    });
  }

  result.systemRuntime.present = addon.hasRuntimeDll(result.systemRuntime.dir);
  result.local.dlls = addon.localRuntimeDlls(addonDir);

  const localComplete = addon.RUNTIME_DLLS.every((name) => result.local.dlls.includes(name));
  if (localComplete && !options.force) {
    step('ok', `addon 目录已有 ${addon.RUNTIME_DLLS.join(', ')}`);
    result.reason = 'already-patched';
    return verify(result, options, { forceProbe: true });
  }
  if (result.systemRuntime.present && !options.force) {
    step('ok', `系统已有 VC 运行时（${result.systemRuntime.dir}），无需修补`);
    result.reason = 'system-runtime-present';
    return verify(result, options, { forceProbe: false });
  }

  const source = options.sourceDir
    ? { dir: path.resolve(options.sourceDir), version: path.basename(path.resolve(options.sourceDir)) }
    : addon.findRuntimeSource(options.runtimeRoots ? { roots: options.runtimeRoots } : {});
  if (!source || !addon.hasRuntimeDll(source.dir)) {
    step('fail', '没有可用的 vcruntime140.dll 来源');
    return fail(result, options, '找不到可用的 vcruntime140.dll，无法自动修复', {
      reason: 'no-source',
      hint:
        '确认系统里装了 Edge/WebView2，或用 --source 指定含 vcruntime140.dll 的目录；' +
        '也可以安装 Microsoft Visual C++ Redistributable (x64)，或改用 --mode env 导入',
    });
  }
  result.sourceDir = source.dir;
  result.sourceLabel = addon.describeSource(source);
  step('ok', `运行时来源：${result.sourceLabel}`, source.dir);

  if (options.dryRun) {
    step('warn', `--dry-run：将复制 ${addon.RUNTIME_DLLS.join(', ')} 到 ${addonDir}`);
    result.reason = 'dry-run';
    report(result, options);
    return { exitCode: EXIT.OK, result };
  }

  try {
    result.copied = addon.patchRuntime(addonDir, source.dir, {});
  } catch (error) {
    step('fail', error.message);
    return fail(result, options, error.message, { reason: 'copy-failed' });
  }
  step('ok', `已复制 ${result.copied.map((item) => path.basename(item)).join(', ')}`);
  result.reason = 'patched';

  return verify(result, options, { forceProbe: true });
}

function verify(result, options, flags) {
  if (options.verify === false) {
    result.steps.push({ status: 'warn', message: '已跳过验证（verify=false）' });
    report(result, options);
    return { exitCode: EXIT.OK, result };
  }
  const shouldProbe = flags.forceProbe || !(options.quiet || options.auto);
  if (!shouldProbe) {
    report(result, options);
    return { exitCode: EXIT.OK, result };
  }

  const probe = addon.probeAddonInChild(result.addon.path);
  result.probe = probe;
  if (probe.ok === true) {
    result.steps.push({ status: 'ok', message: '在独立进程中成功加载 keyring 原生模块' });
  } else if (probe.ok === false) {
    result.steps.push({
      status: 'fail',
      message: `独立进程加载仍失败：${probe.reason}`,
      hint: '可能还缺其它运行时；安装 Microsoft Visual C++ Redistributable (x64) 后再试',
    });
  } else {
    result.steps.push({
      status: 'warn',
      message: `无法验证（${probe.reason}）`,
      hint: '启动 ZCode 后用 zcode-sync doctor 确认 zcode-keyring-addon',
    });
  }

  if (probe.ok === false) {
    result.ok = false;
    result.reason = 'still-broken';
    report(result, options);
    return { exitCode: EXIT.KEYRING_UNAVAILABLE, result };
  }

  if (result.copied.length > 0) {
    result.steps.push({
      status: 'warn',
      message: '需要完整退出并重启 ZCode 才会生效',
      hint: 'native 模块加载失败不会被热重载',
    });
  }
  report(result, options);
  return { exitCode: EXIT.OK, result };
}

module.exports = { fixKeyring };
