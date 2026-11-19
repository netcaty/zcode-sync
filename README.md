# zcode-sync

把一台机器上**已登录的 ZCode 凭据**迁移到另一台机器：在 A 机登录一次，导出加密迁移包；B 机导入后启动 ZCode 即处于登录态，不再走浏览器登录。

> 仅用于你本人拥有的账号。凭据包含完整的 access/refresh token；请只通过可信渠道传输，并使用强口令。

## 背景：ZCode 3.18+ 的凭据机制

ZCode 3.18 起把 `credentials.json` 的每个值加密为：

```text
enc:v2:{os|env}:{fingerprint}:{nonce}.{tag}.{ciphertext}
```

- `os` 模式：随机 32 字节密钥存放在系统钥匙串（Windows Credential Manager / macOS Keychain / Linux Secret Service）。
  - service = `ZCode Credential Encryption`
  - account = `SHA-256(path.resolve(credentials.json)).hex`
  - Windows Credential Manager 的 target = `<account>.<service>`，UserName = account，blob 是 43 字符 base64url 密钥的 UTF-16LE 编码。
  - 这一点已用 ZCode 3.18.2 自带的 `@napi-rs/keyring` 原生模块做过双向读写验证。
- `env` 模式：密钥来自 `ZCODE_CREDENTIAL_SECRET` / `ZCODE_CREDENTIAL_SECRET_FILE`，或凭据目录下的 `credential-secret` 文件；key = `SHA-256(secret)`。
- 指纹 = `SHA-256(key)` 的 hex 前 24 位。
- 加密算法：AES-256-GCM，无 AAD，12 字节 nonce，16 字节 tag，base64url 无 padding。
- 同目录的 `credential-source` 内容必须恰好是 `os\n`；存在即锁定 OS 钥匙串。env 模式必须没有该文件。

因此**直接复制 `credentials.json` 不能跨机登录**：目标机的钥匙串里没有源机的密钥。本工具在目标机生成/复用目标机自己的密钥，把所有凭据重新加密后写入，ZCode 无感。

参考：`pjpv/zcode-switch` issue #44（ZCode 3.18 `enc:v2:os` 适配）。

## 当前状态

- 已实现：Windows 路径、`enc:v2:os` / `enc:v2:env` / 旧 `enc:v1` / 明文读取、目标机重加密、钥匙串读写、原子写、备份、dry-run、合并策略、`deviceMid` 可选克隆。
- 已测试：单元测试、合成 profile 的 export/import E2E、真实 Windows Credential Manager（独立测试 service）E2E、CLI 参数/管道/退出码 E2E；并与 ZCode 自带的 `@napi-rs/keyring` 原生模块做了双向读写兼容性验证（target 规则 + UTF-16LE）。
- `doctor` 会检测 **ZCode 自身**的 keyring 原生模块能否加载，避免出现“工具能解密、ZCode 却报 credential storage unavailable”的假成功。
- **待真机验证**：用真实测试账号 + 第二台机器确认跨机登录、refresh token 是否轮换、token 是否绑定 `deviceMid`。见 [docs/phase0-results.md](docs/phase0-results.md)。

## 环境要求

- Windows 10/11 x64。
- 源机已安装并登录 ZCode 3.18.x；目标机已安装 ZCode。
- 不需要单独安装 Node.js：`zcode-sync.cmd` 会调用 ZCode 自带的 Electron（`ELECTRON_RUN_AS_NODE=1`）运行 CLI。
- 如果系统里有 Node.js 22+，也可以直接 `node zcode-sync.cjs ...`。
- PowerShell 5.1+（Windows 自带）用于访问 Credential Manager。
- **Microsoft Visual C++ 2015–2022 Redistributable (x64)**。ZCode 自己的 `@napi-rs/keyring` 原生模块依赖它；缺失时 ZCode 会报 `System credential storage is unavailable`，即使凭据文件导入正确也无法登录。`zcode-sync doctor` 会检测并提示。

## 快速开始

### 双击自动迁移（推荐）

在项目根目录双击 `zcode-sync-auto.cmd`，脚本会自动判断本机角色：

- 本机有可解密的 ZCode 登录凭据 → 视为**源机**，执行 `export`（提示设置迁移包口令，迁移包写入项目目录，文件名带时间戳）。
- 本机没有登录凭据 → 视为**目标机**，自动使用脚本目录下唯一的 `.zcs`（没有则提示输入路径），执行 `import`。
- 两者都无法判断（例如钥匙串不可用）时，脚本会提示先运行 `zcode-sync.cmd doctor`，不会盲目导出或导入。

也可以把 `.zcs` 文件直接拖到 `zcode-sync-auto.cmd` 上强制导入；或设置 `ZCS_FORCE_ROLE=source` / `ZCS_FORCE_ROLE=target` 强制角色。脚本只是封装现有 `zcode-sync.cmd`，原有命令行用法不变。

双击流程由 `zcode-sync-passphrase.ps1` 隐藏输入口令：打包后的 Electron 启动器在双击场景下没有 TTY，CLI 自带的交互提示会失败。脚本把口令写入 `%TEMP%` 下的临时文件，通过 `--passphrase-file` 传给 CLI，命令结束后立即删除。若已设置 `ZCS_PASSPHRASE`，则跳过提示，直接由 CLI 使用该环境变量（CLI 会给出安全警告）。

### A 机：导出

1. **退出 ZCode**（托盘也要退出；运行中导出会给出警告）。
2. 运行：

```bat
zcode-sync.cmd doctor
zcode-sync.cmd export -o zcode-creds.zcs
```

- `export` 会提示设置迁移包口令。口令只用于加密迁移包，不是 ZCode 密码。
- 生成文件后，终端会显示账号、大小和 SHA-256。记下 SHA-256，传输后可校验。

### 传输

通过你信任的渠道（U 盘、`scp`、加密网盘等）把 `.zcs` 拷到 B 机。不要把迁移包和口令放在同一个渠道里。

### B 机：导入

1. 确认 ZCode 已退出。
2. 先检查包和预演：

```bat
zcode-sync.cmd inspect zcode-creds.zcs
zcode-sync.cmd import zcode-creds.zcs --dry-run
```

3. 正式导入：

```bat
zcode-sync.cmd import zcode-creds.zcs
```

4. 启动 ZCode，执行 `zcode-sync.cmd status` 确认账号和存储模式。
5. 如果导入时 ZCode 仍在运行，工具会拒绝写入；请退出 ZCode 后重试。

### 管道用法

```bat
zcode-sync.cmd export -o - --passphrase-file pass.txt | ssh B "zcode-sync.cmd import - --passphrase-file pass.txt"
```

`export -o -` 输出二进制到 stdout，`import -` 从 stdin 读取。两端都需要能拿到口令（推荐 `--passphrase-file` 或交互式 TTY；stdin 被包占用时不能再用 TTY 读口令）。

## 命令

```text
zcode-sync doctor   [--json] [--home DIR] [--credentials-file PATH]
zcode-sync status   [--json] [--home DIR] [--credentials-file PATH]
zcode-sync export   [-o FILE|-] [--include-device-id] [--allow-running] [--force]
zcode-sync inspect  FILE|- [--json]
zcode-sync import   FILE|- [--dry-run] [--mode os|env] [--secret-file PATH]
                    [--device-id keep|clone] [--replace-all|--merge]
                    [--restart] [--force] [--keep-backups N]
```

通用选项：

| 选项 | 说明 |
|---|---|
| `--home DIR` | ZCode 数据目录，等价 `ZCODE_HOME`，默认 `~/.zcode`。显式指定时**只在该目录下查找/写入**，绝不会回退到真实 `~/.zcode` |
| `--credentials-file PATH` | 只使用该 `credentials.json`，不做任何目录回退 |
| `--passphrase-file FILE` | 从文件读取迁移包口令（适合脚本；建议 0600） |
| `--json` | 机器可读输出 |
| `--verbose` | 出错时输出堆栈 |
| `-h, --help` / `-V, --version` | 帮助 / 版本 |

### doctor

只读诊断：ZCode 版本、运行状态、凭据路径、存储模式、`credential-source`、`ZCODE_CREDENTIAL_SECRET*` 冲突、钥匙串条目是否存在、指纹是否匹配、能否解密、目录是否可写、`deviceMid`。`--json` 输出结构化检查。

### status

显示当前登录摘要：账号、active provider、access token 过期时间、refresh token 指纹前 8 位、存储模式、key 数量、`deviceMid`。不会打印 token 明文。

### export

读取并解密当前凭据，生成口令加密的 `.zcs` 包。默认在 ZCode 运行时只警告；`--allow-running` 可跳过警告。`--include-device-id` 把 `onboarding-record.json` 的 `deviceMid` 一起加密进包（默认不包含）。

### inspect

解密迁移包并显示源平台、ZCode 版本、账号、key 列表等元信息；不显示任何 secret。

### import

- 默认要求 ZCode 已退出；`--force` 可强制继续（不推荐）。
- 写入前自动备份目标 `credentials.json`、`credential-source`、`credential-secret`、`onboarding-record.json` 到同目录的 `.zcs-backup-<timestamp>`，默认保留最近 5 份（`--keep-backups N`）。
- `--dry-run` 执行完整校验和加密回环，但不写任何文件/钥匙串。
- 默认合并策略 `identity`：用迁移包替换目标机的全部身份凭据（`oauth:*`、`zcodejwttoken`），保留目标机其他 provider 的 API key。
  - `--merge`：迁移包的 key 覆盖同名，保留目标机其余所有 key（可能保留另一账号的 OAuth key，谨慎）。
  - `--replace-all`：结果完全等于迁移包。
- `--mode os`（默认）：目标机钥匙串没有 key 时自动生成 32 字节随机 key 并写入；已有 key 则复用。
- `--mode env`：使用 env 密钥，不依赖钥匙串；会把 secret 写入凭据目录下的 `credential-secret`（0600），并移除 `credential-source`。适合无头/无钥匙串环境；安全性弱于 os 模式。
- `--device-id clone`：把迁移包中的 `deviceMid` 写入目标机 `onboarding-record.json`。默认 `keep`。只有在 Phase 0 确认 token 绑定设备时才建议使用。
- `--restart`：导入后自动启动 ZCode。若 ZCode 正在运行，需要同时加 `--force`，工具会先关闭主进程。
- `--force`：除了允许运行中写入，也用于确认“目标机旧 `enc:v2:os` 凭据的钥匙串密钥缺失/不匹配，仍要 `--replace-all`”这种会使命中旧备份不可解密的操作。加之前请确认备份和回滚方案。

### 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 通用错误 / doctor 发现 fail |
| 2 | 参数错误 |
| 3 | 未登录 / 凭据不存在 |
| 4 | 钥匙串不可用 |
| 5 | ZCode 正在运行（import 拒绝写入） |
| 6 | 解密失败 / 迁移包损坏 / 口令错误 |
| 130 | 用户取消 |

## 安全模型

- 迁移包：scrypt（N=65536, r=8, p=1）+ AES-256-GCM；header 作为 AAD 绑定。错误口令或篡改会失败。
- 目标机用目标机自己的钥匙串密钥重新加密；**不共享源机 OS 密钥**。
- 默认 `--mode os` 时，迁移包之外不会留下明文 token；备份仍是 ZCode 原格式密文。
- 日志/终端只输出指纹前缀、key 名、账号展示信息；不输出 token、secret、密文。
- `--mode env` 会把 secret 落到 `credential-secret` 文件；拿到该文件 + `credentials.json` 等同于拿到账号，请知悉。
- 不支持将口令放在命令行参数（避免进入命令历史）；支持交互式隐藏输入、`--passphrase-file`、`ZCS_PASSPHRASE`（后者会提示风险）。

## 限制与风险

1. **refresh token 轮换 / 设备绑定尚未真机验证。**
   - 如果服务端在每次刷新后轮换 refresh token 并立即使旧 token 失效，多台设备共用同一条 token 链会互相踢掉。届时需要“刷新后回推”的双向同步，或退化为单活动设备模式。
   - 如果 token 绑定 `deviceMid`，可能需要 `--device-id clone`；这会覆盖目标机 `onboarding-record.json` 的 `deviceMid`，并让多台设备上报同一设备标识。
   - 请先用**可牺牲的测试账号**验证，不要拿主账号做第一次实验。
2. **钥匙串 account 来自 `credentials.json` 的绝对路径**（`path.resolve` 后 SHA-256）。不要随意移动/改大小写 `credentials.json` 路径，否则 ZCode 和本工具都会找不到对应密钥。Windows Credential Manager 的 target 为 `<account>.<service>`，不同路径的 profile 可以有独立条目。
3. **运行中的 ZCode 可能用内存缓存覆盖写入**。import 默认要求退出；`--force` 只用于你明确知道后果的场景。
4. **不修改 ZCode、不注入进程、不伪造官方接口**。如果 ZCode 未来改变 `enc:v2` 格式或路径，工具会通过 `doctor`/`inspect` 明确报错，需要升级工具。
5. **首版仅 Windows**。macOS Keychain / Linux Secret Service 的抽象层已预留，但未实现/未测试。
6. **不做云端托管、不做遥测**。迁移包传输由你自行负责。
7. **仅供本人账号**。token 共享可能触发服务端设备限制或违反服务条款；使用风险自负。

## 故障排查

| 现象 | 处理 |
|---|---|
| `未找到登录凭据` | 先在 ZCode 登录；确认 `--home` 指向 `~/.zcode`（不是用户主目录）；或用 `--credentials-file` 指向 `v2/credentials.json` |
| `KEYRING_UNAVAILABLE` / 找不到钥匙串条目 | 确认 ZCode 已登录、`doctor` 的 `keyring-fingerprint` 为 ok；检查 PowerShell 是否可用、是否被组策略限制；确认没有同时设置 `ZCODE_CREDENTIAL_SECRET` 和 `_FILE` |
| `CRYPTO` / 口令错误 | 迁移包口令错误或文件损坏；用 `inspect` 验证；重新从源机导出 |
| `ZCODE_RUNNING` | 完全退出 ZCode（含托盘）后重试；不要在运行中 import |
| 指纹不匹配 | `--credentials-file` 可能指到了另一个 profile；`doctor` 会显示实际 account hash |
| 导入后仍未登录 | 重启 ZCode；`status` 检查存储模式；如果服务端有设备限制，参考 Phase 0 的 `--device-id` 结论 |
| PowerShell 找不到 | 确认 Windows PowerShell 5.1 可用；或先用 `--mode env` 导入（不依赖钥匙串） |
| ZCode 报 `System credential storage is unavailable` | 运行 `zcode-sync doctor`，看 `zcode-keyring-addon` 是否 fail。通常是缺少 VC++ 运行时；安装 Microsoft Visual C++ Redistributable (x64)，或改用 `zcode-sync import ... --mode env`。改完后必须**完整退出并重启 ZCode**，native 模块加载失败不会被热重载 |
| `doctor` 的 `zcode-keyring-addon` fail，但 `keyring-key` ok | 说明我们的 PowerShell 后端能读，ZCode 自己的 addon 不能读；这是 ZCode 运行环境问题，不是迁移包问题 |

## 开发与测试

本仓库零第三方依赖，使用 ZCode 自带 Electron 的 Node 24 运行：

```bat
run-tests.cmd
```

或者手动：

```bat
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" test\run-all.cjs
```

macOS/Linux 有一个实验性的 `zcode-sync.sh`（优先用 Node，或常见的 ZCode 路径），但首版钥匙串后端只有 Windows；非 Windows 请用 `--mode env`。

测试包含：

- `test/unit.cjs`：路径 hash、v1/v2 加解密、钥匙串 blob 编码、managed secret 优先级、合并策略、bundle 篡改/错误口令、account summary、原子写/备份/锁。
- `test/e2e-synthetic.cjs`：临时 profile + 内存钥匙串，覆盖 os/env、merge、dry-run、运行中拒绝。
- `test/e2e-keyring.cjs`：真实 Windows Credential Manager（独立测试 service），验证目标机生成独立密钥并重新加密。
- `test/cli-e2e.cjs`：CLI 参数、`--passphrase-file`、`export -o -` → `import -` 管道、status/doctor、退出码。

代码结构：

```text
zcode-sync.cjs / zcode-sync.cmd   入口与 Windows 包装器
zcode-sync-auto.cmd               双击自动探测源机/目标机
zcode-sync-passphrase.ps1         双击流程的隐藏口令输入
lib/cli.cjs                        参数解析与命令分发
lib/paths.cjs                      ZCode home / 凭据路径 / path hash
lib/crypto.cjs                     v1/v2 加解密、指纹、env secret、钥匙串 blob
lib/keyring.cjs                    Credential Manager 后端接口
lib/credential-manager.ps1         Windows Credential Manager P/Invoke
lib/credentials.cjs                读写、原子替换、备份、锁、合并、账号摘要
lib/bundle.cjs                     .zcs 格式（scrypt + AES-256-GCM）
lib/process.cjs                    ZCode 进程/版本/重启
lib/onboarding.cjs                 deviceMid 读取/克隆
lib/passphrase.cjs                 隐藏口令输入
lib/commands/*.cjs                 doctor/status/export/inspect/import
```

## License

MIT
