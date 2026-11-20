# 命令参考

```text
zcode-sync doctor   [--json] [--home DIR] [--credentials-file PATH]
zcode-sync status   [--json] [--home DIR] [--credentials-file PATH]
zcode-sync export   [-o FILE|-] [--include-device-id] [--allow-running] [--force]
zcode-sync inspect  FILE|- [--json]
zcode-sync import   FILE|- [--dry-run] [--mode os|env] [--secret-file PATH]
                    [--device-id keep|clone] [--replace-all|--merge]
                    [--restart] [--force] [--keep-backups N]
zcode-sync fix-keyring [--dry-run] [--force] [--source DIR] [--install-dir DIR]
                    [--quiet|--auto] [--json]
```

Windows 下用 `zcode-sync.cmd <命令>`；也可以直接 `node zcode-sync.cjs <命令>`。

## 通用选项

| 选项 | 说明 |
|---|---|
| `--home DIR` | ZCode 数据目录，等价 `ZCODE_HOME`，默认 `~/.zcode`。显式指定时**只在该目录下查找/写入**，绝不会回退到真实 `~/.zcode` |
| `--credentials-file PATH` | 只使用该 `credentials.json`，不做任何目录回退 |
| `--passphrase-file FILE` | 从文件读取迁移包口令（适合脚本；建议 0600） |
| `--json` | 机器可读输出 |
| `--verbose` | 出错时输出堆栈 |
| `-h, --help` / `-V, --version` | 帮助 / 版本 |

口令不支持放在命令行参数里（避免进入命令历史）。可用交互式隐藏输入、`--passphrase-file`，或 `ZCS_PASSPHRASE`（会提示风险）。

## doctor

只读诊断：ZCode 版本、运行状态、凭据路径、存储模式、`credential-source`、`ZCODE_CREDENTIAL_SECRET*` 冲突、钥匙串条目是否存在、指纹是否匹配、能否解密、目录是否可写、`deviceMid`。`--json` 输出结构化检查。

诊断项 `zcode-keyring-addon` 单独检测 **ZCode 自己**的钥匙串原生模块能否加载——否则会出现“工具能解密、ZCode 却报 credential storage unavailable”的假成功。

## status

显示当前登录摘要：账号、active provider、access token 过期时间、refresh token 指纹前 8 位、存储模式、key 数量、`deviceMid`。不打印 token 明文。

## export

读取并解密当前凭据，生成口令加密的 `.zcs` 包。

- 默认在 ZCode 运行时只警告；`--allow-running` 跳过警告。
- `--include-device-id` 把 `onboarding-record.json` 的 `deviceMid` 一起加密进包（默认不包含）。
- `-o -` 输出二进制到 stdout，配合管道用。

## inspect

解密迁移包并显示源平台、ZCode 版本、账号、key 列表等元信息；不显示任何 secret。

## import

- 默认要求 ZCode 已退出；`--force` 可强制继续（不推荐）。
- 写入前自动备份目标 `credentials.json`、`credential-source`、`credential-secret`、`onboarding-record.json` 到同目录的 `.zcs-backup-<timestamp>`，默认保留最近 5 份（`--keep-backups N`）。
- `--dry-run` 执行完整校验和加密回环，但不写任何文件/钥匙串。

### 合并策略

| 策略 | 行为 |
|---|---|
| 默认（identity） | 用迁移包替换目标机的全部身份凭据（`oauth:*`、`zcodejwttoken`），保留目标机其他 provider 的 API key |
| `--merge` | 迁移包的 key 覆盖同名，保留目标机其余所有 key（可能留下另一账号的 OAuth key，谨慎） |
| `--replace-all` | 结果完全等于迁移包 |

### 存储模式

- `--mode os`（默认）：目标机钥匙串没有 key 时自动生成 32 字节随机 key 并写入（读回校验）；已有 key 则复用。
- `--mode env`：使用 env 密钥，不依赖钥匙串；把 secret 写入凭据目录下的 `credential-secret`（0600），并移除 `credential-source`。适合无头/无钥匙串环境，安全性弱于 os 模式。

### 其它

- `--device-id clone`：把迁移包里的 `deviceMid` 写入目标机 `onboarding-record.json`。默认 `keep`。只有在确认 token 绑定设备时才建议用。
- `--restart`：导入后自动启动 ZCode。若 ZCode 正在运行，需同时加 `--force`，工具会先关闭主进程。
- `--force`：除允许运行中写入外，还用于确认“目标机旧 `enc:v2:os` 凭据的钥匙串密钥缺失/不匹配，仍要 `--replace-all`”这类会让旧备份不可解密的操作。加之前请确认备份和回滚方案。

## fix-keyring

修 ZCode 自带 `@napi-rs/keyring` 原生模块加载失败（ZCode 报 `System credential storage is unavailable`、无法登录）。只做一件事：把 `vcruntime140.dll` + `vcruntime140_1.dll` 复制到 addon 同目录。

- **为什么够**：那个 `.node` 动态依赖 `VCRUNTIME140.dll`；Node 用 `LoadLibraryEx(..., LOAD_WITH_ALTERED_SEARCH_PATH)` 加载 addon，依赖优先在该 addon 自己的目录里找。所以补两个 DLL 即可——不改 System32、不需要管理员权限、不装 redist。
- **DLL 从哪来**：取系统里已有的副本，按构建号降序选最新目录，同版本优先 Edge 而非 WebView2（`Edge\Application\<ver>`、`EdgeWebView\Application\<ver>`，也支持用户级安装）。Edge 自带的 VC 运行时通常比 redist 还新。
- **什么时候不需要**：`%SystemRoot%\System32\vcruntime140.dll` 存在即判定无需修补（ZCode 能从系统目录解析）；addon 旁边已有这两个 DLL 时也跳过（`--force` 强制重写）。
- **验证方式**：复制后在**独立进程**里 `require` 一次该 addon（ZCode.exe + `ELECTRON_RUN_AS_NODE`），避免本进程 `LoadLibrary` 的失败缓存造成误判。通过后仍提示“需重启 ZCode”——native 模块加载失败不会被热重载。
- `--dry-run` 只报告将要复制什么；`--quiet` / `--auto` 供自动调用用（成功时只打一行）；`--source DIR` 手动指定运行时来源目录。
- 只影响 keyring 这一个 addon：ZCode 里其余原生模块（sharp / node-pty / koffi / sshcrypto）都不 import `VCRUNTIME140.dll`。

`zcode-sync.cmd` 会自动调用它：先用两个文件探测（System32 有没有、addon 目录有没有）判定环境，命中才额外跑一次 `fix-keyring --auto`，健康机器上零开销。`--help` / `--version` / `fix-keyring` 自身跳过探测；设 `ZCS_NO_AUTOFIX=1` 可完全关掉这个钩子。

## 双击流程（`zcode-sync-auto.cmd`）

脚本只是封装 `zcode-sync.cmd`，命令行用法不变。

打包后的 Electron 启动器在双击场景下没有 TTY，CLI 自带的交互口令提示会失败。所以双击流程由 `zcode-sync-passphrase.ps1` 隐藏输入口令，写入 `%TEMP%` 下的临时文件，通过 `--passphrase-file` 传给 CLI，命令结束立即删除。若已设置 `ZCS_PASSPHRASE`，跳过提示直接由 CLI 使用该环境变量（CLI 会给出安全警告）。

## 退出码

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

`zcode-sync-auto.cmd` 靠 `status` 的退出码判断角色：0 = 源机，3 = 目标机，其它值直接放弃并提示跑 `doctor`。
