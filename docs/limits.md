# 限制与风险

威胁模型与加密细节见 [SECURITY.md](../SECURITY.md)；凭据格式见 [format.md](format.md)。

## 1. refresh token 轮换 / 设备绑定尚未真机验证

- 如果服务端在每次刷新后轮换 refresh token 并立即使旧 token 失效，多台设备共用同一条 token 链会互相踢掉。届时需要“刷新后回推”的双向同步，或退化为单活动设备模式。
- 如果 token 绑定 `deviceMid`，可能需要 `--device-id clone`；这会覆盖目标机 `onboarding-record.json` 的 `deviceMid`，并让多台设备上报同一设备标识。
- **先用可牺牲的测试账号验证，不要拿主账号做第一次实验。**

## 2. 钥匙串 account 来自 `credentials.json` 的绝对路径

account = `SHA-256(path.resolve(credentials.json)).hex`。不要随意移动或改大小写 `credentials.json` 的路径，否则 ZCode 和本工具都会找不到对应密钥。Windows Credential Manager 的 target 为 `<account>.<service>`，不同路径的 profile 可以有独立条目。

## 3. 运行中的 ZCode 可能用内存缓存覆盖写入

import 默认要求 ZCode 已退出；`--force` 只用于你明确知道后果的场景。

## 4. 不修改 ZCode、不注入进程、不伪造官方接口

如果 ZCode 未来改变 `enc:v2` 格式或路径，工具会通过 `doctor` / `inspect` 明确报错，需要升级工具。

## 5. 首版仅 Windows

macOS Keychain / Linux Secret Service 的抽象层已预留，但未实现/未测试。非 Windows 只能用 `--mode env`。

## 6. 不做云端托管、不做遥测

迁移包传输由你自行负责。

## 7. 仅供本人账号

token 共享可能触发服务端设备限制或违反服务条款；使用风险自负。

## 8. env 模式会落盘 secret

`--mode env` 把 secret 写在凭据目录下的 `credential-secret`。拿到该文件 + `credentials.json` 等同于拿到账号。只在无头/无钥匙串环境使用。
