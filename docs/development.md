# 开发与测试

## 当前状态

**已实现**：Windows 路径、`enc:v2:os` / `enc:v2:env` / 旧 `enc:v1` / 明文读取、目标机重加密、钥匙串读写、原子写、备份、dry-run、合并策略、`deviceMid` 可选克隆、`fix-keyring` 自动修补。

**已测试**：

- 单元测试；
- 合成 profile 的 export/import E2E；
- 真实 Windows Credential Manager（独立测试 service）E2E；
- CLI 参数 / 管道 / 退出码 E2E；
- 与 ZCode 自带 `@napi-rs/keyring` 原生模块的双向读写兼容性（target 规则 + UTF-16LE）；
- `fix-keyring` 的决策矩阵与复制行为（伪造 Edge 目录 / 伪造安装目录）。

**待真机验证**：用真实测试账号 + 第二台机器确认跨机登录、refresh token 是否轮换、token 是否绑定 `deviceMid`。见 [phase0-results.md](phase0-results.md)。

## 跑测试

本仓库零第三方依赖，使用 ZCode 自带 Electron 的 Node 24 运行：

```bat
run-tests.cmd
```

或者手动：

```bat
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" test\run-all.cjs
```

| 测试文件 | 覆盖 |
|---|---|
| `test/unit.cjs` | 路径 hash、v1/v2 加解密、钥匙串 blob 编码、managed secret 优先级、合并策略、bundle 篡改/错误口令、account summary、原子写/备份/锁 |
| `test/keyring-addon.cjs` | `fix-keyring`：版本比较、运行时来源优选、复制与幂等、无来源/系统已有/`--dry-run`/缺 addon 的决策分支 |
| `test/smoke.cjs`、`test/process-smoke.cjs` | 模块可加载、ZCode 进程探测 |
| `test/e2e-synthetic.cjs` | 临时 profile + 内存钥匙串，覆盖 os/env、merge、dry-run、运行中拒绝 |
| `test/e2e-keyring.cjs` | 真实 Windows Credential Manager（独立测试 service），验证目标机生成独立密钥并重新加密 |
| `test/cli-e2e.cjs` | CLI 参数、`--passphrase-file`、`export -o -` → `import -` 管道、status/doctor、退出码 |

`test/target-diagnose.cjs` 是目标机现场诊断脚本，不在自动套件里。

## 代码结构

```text
zcode-sync.cjs / zcode-sync.cmd   入口与 Windows 包装器（含 fix-keyring 自动探测钩子）
zcode-sync-auto.cmd               双击自动探测源机/目标机
zcode-sync-passphrase.ps1         双击流程的隐藏口令输入
lib/cli.cjs                        参数解析与命令分发
lib/paths.cjs                      ZCode home / 凭据路径 / path hash
lib/crypto.cjs                     v1/v2 加解密、指纹、env secret、钥匙串 blob
lib/keyring.cjs                    Credential Manager 后端接口
lib/credential-manager.ps1         Windows Credential Manager P/Invoke
lib/credentials.cjs                读写、原子替换、备份、锁、合并、账号摘要
lib/bundle.cjs                     .zcs 格式（scrypt + AES-256-GCM）
lib/process.cjs                    ZCode 进程/版本/重启、keyring addon 探测
lib/keyring-addon.cjs              vcruntime140*.dll 定位与复制（fix-keyring 的纯逻辑）
lib/onboarding.cjs                 deviceMid 读取/克隆
lib/passphrase.cjs                 隐藏口令输入
lib/commands/*.cjs                 doctor/status/export/inspect/import/fix-keyring
```

## 非 Windows

`zcode-sync.sh` 是实验性入口（优先用 Node，或常见的 ZCode 路径）。首版钥匙串后端只有 Windows；macOS/Linux 请用 `--mode env`。
