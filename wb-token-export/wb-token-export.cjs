#!/usr/bin/env node
/**
 * wb-token-export.cjs —— 把 WorkBuddy 桌面端已加密的登录凭据解出来，导出成
 * magpie 的 workbuddy 插件（@magpie-community/opencode-workbuddy-auth）里
 * 「Import accounts from a file…」能直接吃的 JSON。
 *
 * 为什么需要这个脚本：WorkBuddy 5.6.0 起强制 AtRest 加密，登录文件
 * （%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info）
 * 里的 accessToken / refreshToken 变成 {$wbEncrypted:1, envelope:"…"}，
 * 插件读不懂会直接报「登录信息已加密」。解密所需的密钥不落盘，只由客户端
 * 自己的 Electron 原生绑定暴露 —— 所以这里向**写这个文件的那个客户端**索取。
 *
 * 算法（密钥派生 / AAD 转录）见
 * https://github.com/Ianzhyh/workbuddy-to-dsh/blob/main/docs/ARCHITECTURE.md
 * 第一节「凭据：AtRest 信封」。
 *
 * 输出结构 = 解密后的登录文件本体（{auth, account}），插件 signInsIn()
 * 认这个形状：`o.auth.accessToken` + `o.auth.refreshToken` + `o.account.uid`。
 *
 * 零依赖，Node 18+ / WorkBuddy 自带 Electron 均可运行。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { createDecipheriv, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const VERSION = '1.0.0';
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
const FIELD_FORMAT_ID = 'WBEV1'; // 字段级信封的标准格式 id
const SYMMETRIC_SCHEME = 'sym-v1';
const KEY_FETCH_TIMEOUT_MS = 20000;

// ── 终端输出 ────────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');

function info(line = '') {
  process.stdout.write(line + '\n');
}
function fail(message) {
  process.stderr.write(red('✗ ') + message + '\n');
}

const USAGE = `
${bold('wb-token-export')} ${dim('v' + VERSION)} —— 导出 WorkBuddy 登录凭据给 magpie 的 workbuddy 插件

${bold('用法')}
  wb-token-export.cmd [选项]
  node wb-token-export.cjs [选项]

${bold('选项')}
  -o, --out FILE      输出路径，'-' 表示打到 stdout      ${dim('(默认 ./workbuddy-signin-<时间戳>.json)')}
      --file PATH     指定登录文件                          ${dim('(默认自动挑活动的那份)')}
      --exe PATH      指定 WorkBuddy 可执行文件            ${dim('(默认自动探测)')}
      --verify        导出后再向 WorkBuddy 查一次账号列表   ${dim('(只读，不续期、不换 token)')}
      --allow-stale   即使 access token 已过期也照样导出
      --json          把摘要以 JSON 打到 stderr            ${dim('(给脚本用)')}
  -h, --help          帮助
  -V, --version       版本

${bold('导出后怎么用')}
  magpie → Accounts → 添加 WorkBuddy → Import accounts from a file…
  选生成的 json。插件会先向 WorkBuddy 续期一次再收进来，
  所以${yellow('这台桌面端会被登出，需要重新登录')}。
`.trim();

// ── 参数 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    out: '',
    file: '',
    exe: '',
    verify: false,
    allowStale: false,
    json: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = () => {
      const v = argv[i + 1];
      // '-' 是合法的值（-o - 表示 stdout），别当选项吞掉
      if (v === undefined || (v.startsWith('-') && v !== '-')) throw new Error(`${arg} 需要一个值`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '-o':
      case '--out':
        opts.out = need();
        break;
      case '--file':
        opts.file = need();
        break;
      case '--exe':
        opts.exe = need();
        break;
      case '--verify':
        opts.verify = true;
        break;
      case '--allow-stale':
        opts.allowStale = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-V':
      case '--version':
        opts.version = true;
        break;
      default:
        throw new Error(`不认识的参数：${arg}`);
    }
  }
  return opts;
}

// ── 定位 WorkBuddy 桌面端 ────────────────────────────────────────────────

const EXE_NAMES = ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'CodeBuddy.exe'];
const DIR_KEYWORD_RE = /workbuddy|codebuddy/i;

function candidatesFromRoots() {
  const out = [];
  const push = (p) => {
    if (p) out.push(p);
  };
  const env = process.env;
  if (env.WORKBUDDY_APP_EXECUTABLE) push(env.WORKBUDDY_APP_EXECUTABLE);
  if (env.WORKBUDDY_EXE) push(env.WORKBUDDY_EXE);

  if (process.platform === 'win32') {
    const roots = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.LOCALAPPDATA,
    ].filter(Boolean);
    const dirs = ['WorkBuddy', 'WorkBuddy AI', 'WorkBuddyAI', 'CodeBuddy', 'WorkbuddyInternational'];
    for (const root of roots) {
      for (const dir of dirs) {
        for (const name of EXE_NAMES) push(path.join(root, dir, name));
      }
    }
  } else if (process.platform === 'darwin') {
    for (const app of ['/Applications/WorkBuddy.app', '/Applications/WorkBuddy AI.app']) {
      for (const name of ['WorkBuddy', 'WorkBuddy AI', 'Electron']) {
        push(path.join(app, 'Contents', 'MacOS', name));
      }
    }
  } else {
    push('/opt/WorkBuddy/workbuddy');
  }
  return out;
}

/** 浅扫描：只在常见父目录里往下两层，看目录名像不像客户端安装目录。 */
function shallowScan() {
  const env = process.env;
  const roots = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    'C:\\App',
    'D:\\App',
    'E:\\App',
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const dirs = DIR_KEYWORD_RE.test(entry.name) ? [dir] : [];
      if (!dirs.length) {
        // 外壳目录：WorkBuddy\app\WorkBuddy.exe
        let inner;
        try {
          inner = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of inner) {
          if (sub.isDirectory() && DIR_KEYWORD_RE.test(sub.name)) dirs.push(path.join(dir, sub.name));
        }
      }
      for (const d of dirs) {
        for (const name of EXE_NAMES) {
          const exe = path.join(d, name);
          if (fs.existsSync(exe)) found.push(exe);
        }
        // 再看一层：WorkBuddy\app\WorkBuddy.exe
        let inner;
        try {
          inner = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of inner) {
          if (!sub.isDirectory()) continue;
          for (const name of EXE_NAMES) {
            const exe = path.join(d, sub.name, name);
            if (fs.existsSync(exe)) found.push(exe);
          }
        }
      }
    }
  }
  return found;
}

/**
 * 机器上可能并存多个 build（国内版 / 国际版），密钥未必相同 —— 全部列出来，
 * 由调用方按信封 keyId 认准写文件的那一个。
 */
function listExes(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`指定的可执行文件不存在：${explicit}`);
    return [explicit];
  }
  const staticHits = candidatesFromRoots().filter((p) => fs.existsSync(p));
  if (staticHits.length) return [...new Set(staticHits)];
  return [...new Set(shallowScan())];
}

// ── 从客户端取 AtRest 密钥 ───────────────────────────────────────────────

/**
 * 让客户端以纯 Node 模式跑一行脚本，把密钥载荷打出来。
 *
 * 两个必须注意的点：
 *   ① 必须 spawnSync + stdio[0]='ignore'。Windows 上用 execFileSync 启动 Electron
 *      会给 stdin 开管道，直接 EBUSY。
 *   ② ELECTRON_RUN_AS_NODE=1，否则会真的把 GUI 拉起来。
 */
function fetchKeyPayload(exe) {
  const code = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
    + 'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';
  const res = spawnSync(exe, ['-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], // ← 不能省
    encoding: 'utf8',
    timeout: KEY_FETCH_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw new Error(`启动客户端取密钥失败：${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`客户端拒绝交出密钥：${(res.stderr || '').trim() || `退出码 ${res.status}`}`);
  }
  const text = (res.stdout || '').trim();
  if (!text) throw new Error('客户端没有返回密钥载荷');
  return text;
}

/** 载荷里的 atRestSecretKey 可能在嵌套对象里，递归找。 */
function findSecretKey(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return '';
  if (typeof node.atRestSecretKey === 'string' && node.atRestSecretKey) return node.atRestSecretKey;
  for (const v of Object.values(node)) {
    const hit = findSecretKey(v, depth + 1);
    if (hit) return hit;
  }
  return '';
}

function deriveKey(payloadJson) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error(`密钥载荷不是 JSON：${payloadJson.slice(0, 80)}…`);
  }
  const secret = findSecretKey(payload);
  if (!secret) throw new Error('密钥载荷里没有 atRestSecretKey（客户端版本可能变了）');
  // 哈希的是 base64 字符串本身，不是解码后的字节
  return createHash('sha256').update(secret, 'utf8').digest();
}

const keyIdOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

// ── 解信封 ──────────────────────────────────────────────────────────────

const uint32 = (n) => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
};
const lenPrefixed = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([uint32(b.length), b]);
};

/** 字段级 sym-v1 信封的 AAD，顺序错一个字节就 tag 校验失败。 */
function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new Error(`信封 keyId 不合法：${keyId}`);
  return Buffer.concat([
    AAD_DOMAIN, // "WB-AAD\0"
    Buffer.from([0x01]),
    lenPrefixed(FIELD_FORMAT_ID),
    lenPrefixed(scheme),
    uint32(suite),
    lenPrefixed(keyId),
    Buffer.from([0x02]), // framing = field
    Buffer.from([0x00]),
    Buffer.from([0x00]),
  ]);
}

const isSealed = (v) => Boolean(
  v && typeof v === 'object' && !Array.isArray(v)
  && v.$wbEncrypted === 1 && typeof v.envelope === 'string',
);

function decodeEnvelope(envelope) {
  let record;
  try {
    record = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
  } catch {
    throw new Error('信封不是 base64(JSON)，文件可能损坏');
  }
  if (!record || typeof record !== 'object') throw new Error('信封内容不是对象');
  return record;
}

function openSealed(field, key) {
  const { suite, keyId, nonce, authTag, ciphertext } = decodeEnvelope(field.envelope);
  if (typeof suite !== 'number' || typeof keyId !== 'string') throw new Error('信封缺少 suite/keyId');
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('信封缺少 nonce/authTag/ciphertext');
  }
  const expected = keyIdOf(key);
  if (keyId !== expected) throw new Error(`信封属于密钥 ${keyId}，当前密钥是 ${expected}（装了两个客户端？）`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** 原地把整棵树里的信封全换成明文。 */
function openTree(node, key, where = '') {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    node.forEach((v, i) => openTree(v, key, `${where}[${i}]`));
    return node;
  }
  for (const [k, v] of Object.entries(node)) {
    if (isSealed(v)) {
      try {
        node[k] = openSealed(v, key);
      } catch (err) {
        throw new Error(`${where}${k}：${err.message}`);
      }
    } else if (v && typeof v === 'object') {
      openTree(v, key, `${where}${k}.`);
    }
  }
  return node;
}

/** 树里第一个信封的 keyId —— 用来在多个客户端之间认准写文件的那一个。 */
function firstEnvelopeKeyId(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return '';
  if (isSealed(node)) {
    try {
      return String(decodeEnvelope(node.envelope).keyId || '');
    } catch {
      return '';
    }
  }
  for (const v of Object.values(node)) {
    const hit = firstEnvelopeKeyId(v, depth + 1);
    if (hit) return hit;
  }
  return '';
}

// ── 定位登录文件 ────────────────────────────────────────────────────────

function authDir() {
  if (process.env.WORKBUDDY_AUTH_DIR) return process.env.WORKBUDDY_AUTH_DIR;
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  return path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

/** 活动登录文件只有两个固定名字；带时间戳的是登出留下的快照，不参与。 */
function resolveAuthFile(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`指定的登录文件不存在：${explicit}`);
    return explicit;
  }
  const dir = authDir();
  const names = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info'];
  let best = '';
  let bestAt = -1;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs > bestAt) {
        best = full;
        bestAt = st.mtimeMs;
      }
    } catch { /* 这个版本没装 */ }
  }
  if (best) return best;
  try {
    const hit = fs.readdirSync(dir).filter((f) => f.endsWith('.info')).sort()[0];
    if (hit) return path.join(dir, hit);
  } catch { /* 目录不存在 */ }
  throw new Error(`找不到登录文件（${dir}）。先登录 WorkBuddy 桌面端，或用 --file 指定`);
}

// ── 导出 ────────────────────────────────────────────────────────────────

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function buildExport(info) {
  const t = info.auth || {};
  const acct = info.account || {};
  const now = Date.now();
  const expiresAt = Number(t.expiresAt) > 0
    ? Number(t.expiresAt)
    : Number(t.expiresIn) > 0 ? now + Number(t.expiresIn) * 1000 : 0;
  const refreshExpiresAt = Number(t.refreshExpiresAt) > 0
    ? Number(t.refreshExpiresAt)
    : Number(t.refreshExpiresIn) > 0 ? now + Number(t.refreshExpiresIn) * 1000 : 0;

  const enterpriseId = str(acct.enterpriseId);
  const out = {
    auth: {
      accessToken: str(t.accessToken),
      refreshToken: str(t.refreshToken),
      expiresAt,
      refreshExpiresAt,
      domain: str(t.domain),
      tokenType: str(t.tokenType) || 'Bearer',
      ...(enterpriseId ? { enterpriseId } : {}),
    },
    account: {
      uid: str(acct.uid),
      nickname: str(acct.nickname),
      phoneNumber: str(acct.phoneNumber),
      ...(enterpriseId ? { enterpriseId } : {}),
    },
  };
  return out;
}

const CLOUD_HOSTED = [
  /^[a-z0-9-]+\.sso\.copilot\.tencent\.com$/,
  /^[a-z0-9-]+\.copilot\.qq\.com$/,
  /^[a-z0-9-]+\.sso\.codebuddy\.cn$/,
];
const IOA_HOSTS = new Set(['tencent.sso.copilot.tencent.com', 'tencent.sso.codebuddy.cn']);

/** 凭据的 domain → 请求该发给谁（与插件 endpointOf() 同口径）。 */
function endpointFor(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d || IOA_HOSTS.has(d)) return 'https://copilot.tencent.com';
  if (CLOUD_HOSTED.some((re) => re.test(d))) return `https://${d}`;
  if (/workbuddy\.ai$/.test(d)) return 'https://www.workbuddy.ai';
  if (/codebuddy\.ai$/.test(d)) return 'https://www.codebuddy.ai';
  return 'https://copilot.tencent.com';
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = JSON.parse(text);
        } catch { /* 非 JSON：原样带出 */ }
        // 上游统一信封 {code, msg, requestId, data}
        if (res.statusCode >= 400 || (body && typeof body.code === 'number' && body.code !== 0)) {
          const said = body?.msg || body?.message || text.slice(0, 120);
          const code = body && typeof body.code === 'number' ? ` code ${body.code}` : '';
          reject(new Error(`HTTP ${res.statusCode}${code} ${said}`));
          return;
        }
        resolve(body && typeof body === 'object' && 'data' in body ? body.data : body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（国内直连 copilot.tencent.com，若在需要代理的网络里会失败）')));
    req.on('error', reject);
    req.end();
  });
}

async function verify(exported) {
  const endpoint = endpointFor(exported.auth.domain);
  const id = str(exported.auth.enterpriseId);
  const headers = {
    Authorization: `Bearer ${exported.auth.accessToken}`,
    'X-Domain': exported.auth.domain || new URL(endpoint).host,
    Accept: 'application/json',
    ...(id ? { 'X-Enterprise-Id': id, 'X-Tenant-Id': id } : {}),
  };
  const body = await getJson(`${endpoint}/v2/plugin/accounts`, headers);
  const list = Array.isArray(body?.accounts) ? body.accounts : [];
  return list.filter((a) => a && a.uid).map((a) => ({
    uid: String(a.uid),
    nickname: str(a.nickname),
    type: str(a.type),
    lastLogin: Boolean(a.lastLogin),
  }));
}

function fmtTime(ms) {
  if (!ms) return '未知';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const maskPhone = (p) => (p && p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p);
const fingerprint = (s) => (s ? createHash('sha256').update(s).digest('hex').slice(0, 8) : '-');

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    fail(err.message);
    info('');
    info(USAGE);
    return 2;
  }
  if (opts.help) {
    info(USAGE);
    return 0;
  }
  if (opts.version) {
    info(VERSION);
    return 0;
  }

  const authFile = resolveAuthFile(opts.file);
  let info0;
  try {
    info0 = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (err) {
    fail(`读不了登录文件：${err.message}`);
    return 3;
  }
  if (!info0 || typeof info0 !== 'object') {
    fail('登录文件内容不是对象');
    return 3;
  }

  const sealedKeyId = firstEnvelopeKeyId(info0);
  let encrypted = Boolean(sealedKeyId) || isSealed(info0?.auth?.accessToken);

  if (encrypted) {
    // 客户端可能装了多个（国内版 / 国际版），密钥未必相同 —— 按信封 keyId 认。
    let exeList;
    try {
      exeList = listExes(opts.exe);
    } catch (err) {
      fail(err.message);
      return 4;
    }
    if (!exeList.length) {
      fail('找不到 WorkBuddy 桌面端。用 --exe 指定可执行文件路径');
      return 4;
    }

    let opened = false;
    let firstError = null;
    for (const exe of exeList) {
      try {
        const key = deriveKey(fetchKeyPayload(exe));
        if (sealedKeyId && keyIdOf(key) !== sealedKeyId) {
          firstError = firstError || new Error(
            `${exe} 的密钥（${keyIdOf(key)}）与登录文件（${sealedKeyId}）不匹配`,
          );
          continue;
        }
        openTree(info0, key);
        opened = true;
        break;
      } catch (err) {
        firstError = firstError || err;
      }
    }
    if (!opened) {
      fail(`解密失败：${firstError ? firstError.message : '未知原因'}`);
      return 5;
    }
  }

  const exported = buildExport(info0);
  if (!exported.auth.accessToken && !exported.auth.refreshToken) {
    fail('登录文件里没有 token（桌面端未登录？）');
    return 3;
  }
  const stale = exported.auth.expiresAt > 0 && exported.auth.expiresAt < Date.now();
  if (stale && !opts.allowStale) {
    fail(`access token 已于 ${fmtTime(exported.auth.expiresAt)} 过期。`
      + '插件会尝试用 refresh token 续期；确实要导出就加 --allow-stale');
    return 6;
  }

  // 写出
  let outPath = opts.out;
  const toStdout = outPath === '-';
  if (!outPath) outPath = path.resolve(process.cwd(), `workbuddy-signin-${stamp()}.json`);
  const text = `${JSON.stringify(exported, null, 2)}\n`;
  if (toStdout) {
    process.stdout.write(text);
  } else {
    const full = path.resolve(outPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(full, 0o600);
    } catch { /* Windows 上无所谓 */ }
    outPath = full;
  }

  // 可选：只读校验，不续期
  let accounts = null;
  let verifyError = '';
  if (opts.verify) {
    try {
      accounts = await verify(exported);
    } catch (err) {
      verifyError = err.message;
    }
  }

  const summary = {
    ok: true,
    file: toStdout ? null : outPath,
    authFile,
    encrypted,
    domain: exported.auth.domain,
    endpoint: endpointFor(exported.auth.domain),
    uid: exported.account.uid,
    nickname: exported.account.nickname,
    enterpriseId: exported.auth.enterpriseId || '',
    expiresAt: exported.auth.expiresAt,
    refreshExpiresAt: exported.auth.refreshExpiresAt,
    accessFingerprint: fingerprint(exported.auth.accessToken),
    accounts,
    verifyError: verifyError || null,
  };
  if (opts.json) process.stderr.write(`${JSON.stringify(summary)}\n`);

  if (!toStdout) {
    info('');
    info(`${green('✓')} 已导出 ${bold(path.basename(outPath))}`);
    info(`  账号      ${exported.account.nickname || '-'} ${dim(`(${exported.account.uid || '无 uid'})`)}`
      + (exported.account.phoneNumber ? dim(` ${maskPhone(exported.account.phoneNumber)}`) : ''));
    info(`  登录域名  ${exported.auth.domain || '(空)'} ${dim('→ ' + summary.endpoint)}`);
    if (exported.auth.enterpriseId) info(`  企业      ${exported.auth.enterpriseId}`);
    info(`  access    ${fmtTime(exported.auth.expiresAt)} 过期 ${dim(`(fp ${summary.accessFingerprint})`)}`);
    info(`  refresh   ${fmtTime(exported.auth.refreshExpiresAt)} 过期`);
    info('');
    if (accounts) {
      info(`${green('✓')} 在线校验通过，该账号可用的登录身份：`);
      for (const a of accounts) {
        info(`  - ${a.nickname || a.uid} ${dim(`${a.uid}${a.type ? ` · ${a.type}` : ''}${a.lastLogin ? ' · 最近登录' : ''}`)}`);
      }
    } else if (verifyError) {
      info(`${yellow('!')} 在线校验跳过：${verifyError}`);
    }
    info('');
    info(`${yellow('导入前请知悉')}`);
    info('  · magpie 会先向 WorkBuddy 续期一次再收下这份凭据 ——');
    info('    这台桌面端因此会被登出，需要重新登录（access token 未过期前当前会话不受影响）。');
    info('  · 文件里是明文 token，等价于账号本身，别同步到网盘或提交进仓库。');
    info(`  · magpie 里：Accounts → WorkBuddy → Import accounts from a file… → 选上面这个 json。`);
    info('');
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    fail(err && err.message ? err.message : String(err));
    if (process.env.DEBUG) process.stderr.write(`${err && err.stack}\n`);
    process.exitCode = 1;
  });
