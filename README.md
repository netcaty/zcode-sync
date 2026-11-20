# zcode-sync

把一台机器上**已登录的 ZCode 凭据**迁移到另一台机器：A 机登录一次导出加密迁移包，B 机导入后启动 ZCode 就是登录态，不再走浏览器登录。

> 仅用于你本人拥有的账号。凭据包含完整的 access / refresh token；请只通过可信渠道传输，并使用强口令。

## 它解决什么

ZCode 3.18+ 的 `credentials.json` 每个值都是 `enc:v2:os:...`，密钥随机生成后存在**本机**系统钥匙串里。所以直接拷 `credentials.json` 到另一台机器没用——目标机钥匙串里没有那把密钥。

zcode-sync 在目标机生成（或复用）目标机自己的密钥，把凭据解密后重新加密写回，ZCode 无感。格式与算法细节见 [docs/format.md](docs/format.md)。

## 环境要求

- Windows 10/11 x64（首版仅 Windows；macOS/Linux 只能用 `--mode env`）
- 源机已安装并登录 ZCode 3.18.x，目标机已安装 ZCode
- 不需要额外装 Node.js（用 ZCode 自带的 Electron 跑 CLI），也不需要装 VC++ 运行时（缺了会自动补，见 [docs/troubleshooting.md](docs/troubleshooting.md)）

## 快速开始

### 双击（推荐）

双击 `zcode-sync-auto.cmd`，它自己判断角色：

- 本机有可解密的登录凭据 → 源机，执行 `export`（提示设置迁移包口令，包写到当前目录，文件名带时间戳）
- 本机没有登录凭据 → 目标机，自动用目录下唯一的 `.zcs`（没有则让你输入路径），执行 `import`
- 判断不了（比如钥匙串不可用）→ 提示先跑 `doctor`，不会盲目导出/导入

把 `.zcs` 拖到 `zcode-sync-auto.cmd` 上可强制导入；`ZCS_FORCE_ROLE=source|target` 可强制角色。

### 命令行：A 机导出

```bat
zcode-sync.cmd doctor
zcode-sync.cmd export -o zcode-creds.zcs
```

`export` 会提示设置迁移包口令（只用于加密包，**不是** ZCode 密码）。完成后终端显示账号、大小和 SHA-256，记下来传输后可校验。

### 传输

U 盘 / `scp` / 加密网盘都可以。**不要把迁移包和口令放在同一个渠道里。**

### 命令行：B 机导入

```bat
rem 1) 看包里是什么（不显示 secret）
zcode-sync.cmd inspect zcode-creds.zcs
rem 2) 完整校验一遍，不落盘
zcode-sync.cmd import zcode-creds.zcs --dry-run
rem 3) 正式导入
zcode-sync.cmd import zcode-creds.zcs
rem 4) 确认账号与存储模式
zcode-sync.cmd status
```

- 导入前**退出 ZCode**（含托盘）；运行中会被拒绝写入。
- 写入前自动备份目标凭据（`.zcs-backup-<timestamp>`，默认留 5 份）。
- 导入后需重启 ZCode 才生效。

### 管道

```bat
zcode-sync.cmd export -o - --passphrase-file pass.txt | ssh B "zcode-sync.cmd import - --passphrase-file pass.txt"
```

`export -o -` 写 stdout，`import -` 读 stdin；两端都要能拿到口令。

## 命令速查

| 命令 | 作用 |
|---|---|
| `doctor` | 只读诊断：环境、存储模式、钥匙串条目、能否解密 |
| `status` | 当前登录摘要（不打印 token 明文） |
| `export` | 导出加密迁移包 `.zcs` |
| `inspect` | 查看迁移包元信息（不显示 secret） |
| `import` | 导入并重加密（支持 `--mode os\|env`、`--dry-run`、合并策略） |
| `fix-keyring` | 修 ZCode 钥匙串原生模块加载失败（`zcode-sync.cmd` 会自动调用） |

完整参数、合并策略、退出码见 [docs/commands.md](docs/commands.md)。

## 现状

Windows 路径、`enc:v2:os` / `env` / 旧 `v1` / 明文读取、目标机重加密、原子写、备份、dry-run、合并策略、`deviceMid` 可选克隆均已实现并测试。**待真机验证**：跨机登录、refresh token 是否轮换、token 是否绑定 `deviceMid`——见 [docs/development.md](docs/development.md) 与 [docs/phase0-results.md](docs/phase0-results.md)。

请先用可牺牲的测试账号验证，不要拿主账号做第一次实验。

## 安全与限制

默认 `--mode os` 下，迁移包之外不留明文 token；日志只输出指纹前缀。威胁模型见 [SECURITY.md](SECURITY.md)，操作层面的风险（token 轮换、设备绑定、路径 hash、运行中覆盖）见 [docs/limits.md](docs/limits.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/commands.md](docs/commands.md) | 全部命令与选项、合并策略、fix-keyring 原理、退出码 |
| [docs/format.md](docs/format.md) | ZCode 凭据格式、`.zcs` 包二进制布局、重加密流程 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见报错与处理 |
| [docs/limits.md](docs/limits.md) | 已知限制与操作风险 |
| [docs/development.md](docs/development.md) | 测试、代码结构、待验证项 |
| [docs/phase0-results.md](docs/phase0-results.md) | Phase 0 真机验证计划与结论 |
| [SECURITY.md](SECURITY.md) | 威胁模型与漏洞报告 |

## License

MIT
