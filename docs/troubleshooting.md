# 故障排查

先跑 `zcode-sync.cmd doctor`，多数问题它会直接指出来。完整命令见 [commands.md](commands.md)。

| 现象 | 处理 |
|---|---|
| `未找到登录凭据` | 先在 ZCode 登录；确认 `--home` 指向 `~/.zcode`（不是用户主目录）；或用 `--credentials-file` 指向 `v2/credentials.json` |
| `KEYRING_UNAVAILABLE` / 找不到钥匙串条目 | 确认 ZCode 已登录、`doctor` 的 `keyring-fingerprint` 为 ok；检查 PowerShell 是否可用、是否被组策略限制；确认没有同时设置 `ZCODE_CREDENTIAL_SECRET` 和 `_FILE` |
| `CRYPTO` / 口令错误 | 迁移包口令错误或文件损坏；用 `inspect` 验证；重新从源机导出 |
| `ZCODE_RUNNING` | 完全退出 ZCode（含托盘）后重试；不要在运行中 import |
| 指纹不匹配 | `--credentials-file` 可能指到了另一个 profile；`doctor` 会显示实际 account hash |
| 导入后仍未登录 | 重启 ZCode；`status` 检查存储模式；若服务端有设备限制，参考 `--device-id` 结论（[limits.md](limits.md)） |
| PowerShell 找不到 | 确认 Windows PowerShell 5.1 可用；或先用 `--mode env` 导入（不依赖钥匙串） |
| ZCode 报 `System credential storage is unavailable` | 先跑 `zcode-sync.cmd doctor` 看 `zcode-keyring-addon`；再跑 `zcode-sync fix-keyring`（`zcode-sync.cmd` 一般已自动修好）。修不了再装 Microsoft Visual C++ Redistributable (x64)，或改用 `--mode env` 重新导入。改完必须**完整退出并重启 ZCode** |
| `doctor` 的 `zcode-keyring-addon` fail，但 `keyring-key` ok | 我们的 PowerShell 后端能读，ZCode 自己的 addon 不能读——是 ZCode 运行环境问题，不是迁移包问题 |
| `fix-keyring` 说「无权写入 ZCode 安装目录」 | ZCode 装在 `Program Files` 下，需要以管理员身份运行一次 |

## keyring addon 加载失败的细节

ZCode 自带的 `keyring.win32-x64-msvc.node` 动态 import `VCRUNTIME140.dll`。没有 VC++ 运行时的镜像（典型是 Windows Sandbox）加载时报 `The specified module could not be found`（error 126），ZCode 随后报 `System credential storage is unavailable`——即使凭据文件完全正确。

`fix-keyring` 的修法不是装 redist，而是把系统里已有的 `vcruntime140.dll` + `vcruntime140_1.dll` 复制到 addon 同目录，利用 `LOAD_WITH_ALTERED_SEARCH_PATH` 的搜索顺序生效。来源优先取 Edge / WebView2 自带的那份（14.51 通常比本机装的老 redist 还新）。

怎么确认放对地方了：往 addon 同目录塞一个假的 `vcruntime140.dll`，加载会失败（`ERR_DLOPEN_FAILED`）——这说明 addon 目录优先级确实高于 System32，放对就生效。

验证是否修好：`zcode-sync.cmd doctor`，看 `zcode-keyring-addon` 是否变 ok；或

```bat
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" -e "require('%LOCALAPPDATA%\Programs\ZCode\resources\app.asar.unpacked\node_modules\@napi-rs\keyring-win32-x64-msvc\keyring.win32-x64-msvc.node');console.log('ok')"
```

只影响 keyring 一个 addon：ZCode 里其余原生模块（sharp / node-pty / koffi / sshcrypto）都不 import `VCRUNTIME140.dll`。
