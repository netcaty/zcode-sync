# Security Policy

## 报告问题

如果你发现安全问题，请通过仓库 issue 报告，但**不要**在 issue 中粘贴任何真实 token、`credentials.json` 内容、`credential-secret` 或迁移包。可以只描述复现步骤和脱敏后的错误信息。

## 威胁模型

`zcode-sync` 处理的是 ZCode 的完整登录凭据（access token、refresh token、`zcodejwttoken`）。拿到这些数据等同于拿到该账号在 ZCode 中的登录态。

### 迁移包

- 使用口令派生密钥：scrypt（N=65536, r=8, p=1）+ AES-256-GCM。
- 迁移包 header 作为 AAD 绑定，header/密文被篡改会解密失败。
- 口令错误只返回统一错误，不泄漏明文或部分结果。
- 迁移包默认 0600（Windows 依赖用户目录 ACL）。
- 没有口令时，攻击者拿到 `.zcs` 文件不能直接读取凭据。

### 目标机

- 默认 `--mode os` 会使用目标机系统钥匙串（Windows Credential Manager）中的密钥重新加密，不共享源机密钥。
- 工具通过 PowerShell P/Invoke 调用 `CredReadW` / `CredWriteW`，不把密钥放在命令行参数里；写入时通过 stdin 传给 PowerShell。
- Windows Credential Manager target 与 ZCode 一致：`<account>.<service>`，UserName = account，blob 为 UTF-16LE；已用 ZCode 自带 keyring 原生模块双向验证。
- 本工具不会删除 ZCode 的钥匙串条目；导入前会备份目标文件。

### env 模式

`--mode env` 把 secret 写入凭据目录下的 `credential-secret`。**该文件与 `credentials.json` 一起构成可直接解密账号的凭据**，安全性弱于 OS 钥匙串。只建议在无头/无钥匙串环境使用，并确保目录权限为 0600（Unix）。

### 已知限制

- Node/Electron 的字符串不可可靠 zeroize；明文 token 在进程运行期间可能存在于内存中。避免在不可信机器上运行，避免生成 core dump/内存转储。
- `ZCS_PASSPHRASE` 环境变量可被同一用户的其他进程读取；优先使用交互式输入或 `--passphrase-file`。
- `--force` 允许在 ZCode 运行时写入，可能被内存缓存覆盖，产生不可预期的登录状态。
- 迁移 token 可能触发服务端设备限制/轮换策略；这不属于本工具能控制的安全边界。
- 首版仅实现 Windows 钥匙串后端；macOS/Linux 使用 `--mode env` 或等待后续版本。

## 支持范围

- ZCode 3.18.x（`enc:v2` 格式）。
- Windows 10/11 x64。
- 旧 `enc:v1` / 明文凭据只读兼容；写回统一使用 `enc:v2`。

## 供应链

- 零第三方 npm 依赖。
- 运行时使用 ZCode 自带的 Electron/Node 和 Windows 自带的 PowerShell。
- 没有网络请求、遥测或远端存储。
