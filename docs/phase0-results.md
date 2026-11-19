# Phase 0：跨机可行性验证记录

> 状态：**待真机验证**。当前开发沙箱里的 ZCode 使用 endpoint token，没有 `~/.zcode/v2/credentials.json`，因此无法完成真实账号的跨机登录测试。
>
> 不要用主账号做第一次实验。请准备一个可牺牲的测试账号和两台 Windows 机器/VM。

## 已确认（来自 ZCode 3.18.2.10443 `app.asar`）

- `credentials.json` 值格式为 `enc:v2:{os|env}:{fingerprint}:{nonce}.{tag}.{ciphertext}`。
- AES-256-GCM、无 AAD、12 字节 nonce、16 字节 tag、base64url 无 padding。
- OS 密钥：随机 32 字节，钥匙串 service = `ZCode Credential Encryption`，account = `SHA-256(path.resolve(credentials.json)).hex`；Windows Credential Manager target = `<account>.<service>`，UserName = account，blob 为 UTF-16LE。
- 已用 ZCode 3.18.2 自带的 `@napi-rs/keyring` 原生模块做双向验证：原生写入 → 本工具读取 PASS；本工具写入 → 原生读取 PASS。
- **环境依赖**：ZCode 的 keyring 原生模块依赖 Microsoft Visual C++ Redistributable (x64)。WDAG 沙箱缺少 `vcruntime140.dll` 时，ZCode 会连续报 `System credential storage is unavailable`，表现为“导入成功但账号面板未登录”；此时 `doctor` 的 `zcode-keyring-addon` 为 fail。补齐 VC++ 运行时（或使用 `--mode env`）并完整重启 ZCode 后才生效。native 模块加载失败不会被热重载。
- env 密钥：`ZCODE_CREDENTIAL_SECRET` > `ZCODE_CREDENTIAL_SECRET_FILE` > 隐式 `credential-secret`；key = `SHA-256(secret)`。
- `credential-source` 内容必须为 `os\n`；存在即固定 OS 钥匙串；env 模式必须没有该文件。
- `onboarding-record.json.deviceMid` 会作为 `X-Device-Mid` 请求头发送。
- 工具已在合成 profile + 真实 Windows Credential Manager（独立测试 service）上验证：读取源 key、目标机生成独立 key、重加密、marker 正确、错误口令/篡改失败。

## 待验证清单

### 1. 跨机登录（Go/No-Go）

- A 机：测试账号登录 ZCode，退出 ZCode。
- A 机：`zcode-sync.cmd doctor`，确认：
  - 找到 `credentials.json`；
  - `credential-source = os\n`；
  - 钥匙串 key 存在；
  - `keyring-fingerprint` 与凭据一致（验证真实账号下的 path hash 与钥匙串条目；target 命名/编码已在开发机用原生模块验证）；
  - `decrypt` 成功。
- A 机：`zcode-sync.cmd export -o test.zcs --include-device-id`。
- B 机：安装 ZCode，不要登录；退出 ZCode。
- B 机：`zcode-sync.cmd import test.zcs --dry-run`，再 `zcode-sync.cmd import test.zcs`。
- B 机：启动 ZCode，检查账号面板是否显示同一账号；发一条模型请求。
- 记录：B 机是否无需浏览器登录；是否提示设备异常/需要验证。

### 2. refresh token 轮换

目标：判断多台设备共用一条 refresh token 链是否会被互相踢掉。

1. 导入后，在 A/B 分别运行 `zcode-sync.cmd status --json`，记录 `account.refreshTokenFingerprint`。
2. 等 B 的 access token 过期（看 `accessTokenExpiresAt`）或让 B 触发一次 token 刷新。
3. 再次记录 B 的 refresh fingerprint，和 A 比较：
   - 未变化：refresh token 未轮换（或服务端返回同一 token），多机共存概率高。
   - 变化：发生了轮换，需要继续第 4 步。
4. 让 A 刷新（等 A 的 access token 过期），观察 A 是否 401/invalid_grant，以及 B 是否被踢。
5. 查看 B 的 ZCode 日志/网络错误，记录 `401`、`invalid_grant`、`refresh_token` 相关错误。

判定：

| 结果 | 方案 |
|---|---|
| 不轮换、不绑定 | 一次性 export/import 即可支持多机同时在线 |
| 轮换但旧 token 仍可用一段时间 | 增加“刷新后回推”的双向同步（Phase 3）；或每次切换前重新导出 |
| 轮换且立即踢掉 / 单设备限制 | 无法真正多机同时在线；退化为单活动设备模式，或明确告知用户 |

### 3. 设备绑定（deviceMid）

1. B 机 `import --device-id keep`（默认）：启动 ZCode，观察是否登录成功、是否有设备校验。
2. 若失败，B 机重新 `import --device-id clone`：把 A 的 `deviceMid` 写入 B 的 `onboarding-record.json`，再启动。
3. 若 clone 后成功、keep 失败，说明 token 与 `deviceMid` 绑定。
4. 如果 access token / `zcodejwttoken` 是 JWT，解码 payload 检查 `mid`、`device`、`session`、`exp` 等 claims（不要贴出 token 原文）。

注意：clone 会让两台设备上报同一设备标识，可能影响服务端设备管理/统计；只在确认需要时使用。

### 4. 运行中覆盖

1. 保持 A 的 ZCode 运行，执行 `export`（只读）。
2. 保持 B 的 ZCode 运行，执行 `import`：应退出 5 并拒绝写入。
3. 用 `import --force` 再试：观察启动后是否被内存缓存覆盖、账号是否仍正确。
4. 结论：import 是否必须要求 ZCode 退出（当前默认是）。

## 结果记录模板

```text
日期：
ZCode 版本（A/B）：
Windows 版本（A/B）：

[1] 跨机登录：通过 / 失败；现象：
[1] doctor keyring-fingerprint：通过 / 失败
[2] refresh fingerprint A before/after：
[2] refresh fingerprint B before/after：
[2] A 刷新是否失效：是 / 否；B 是否被踢：是 / 否
[3] device-id keep：通过 / 失败；clone：通过 / 失败
[4] 运行中 import：拒绝 / 覆盖；--force 结果：
结论：多机同时在线可行 / 需要回推同步 / 只能单活动设备
备注：
```
