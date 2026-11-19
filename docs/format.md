# ZCode 凭据与 zcode-sync 迁移包格式

本文记录 `zcode-sync` 依赖的 ZCode 3.18.x 凭据格式，以及 `.zcs` 迁移包的二进制布局。实现以 ZCode 3.18.2.10443 的 `app.asar` 为准，并参考 `pjpv/zcode-switch` issue #44。

## 1. ZCode 凭据文件

### 路径

```text
$ZCODE_HOME/v2/credentials.json      # ZCODE_HOME 默认 ~/.zcode
$ZCODE_HOME/v2/credential-source
$ZCODE_HOME/v2/credential-secret
$ZCODE_HOME/v2/onboarding-record.json
```

Windows 下 `$HOME` 通常为 `%USERPROFILE%`。`zcode-sync` 也支持 `--credentials-file` 直接指定。

### 记录格式

`credentials.json` 是 JSON object，key 和 value 都是字符串。已知 key：

```text
oauth:active_provider
oauth:zai:access_token
oauth:zai:refresh_token
oauth:zai:user_info
oauth:zai_cn:access_token
oauth:zai_cn:refresh_token
oauth:zai_cn:user_info
oauth:bigmodel:access_token
oauth:bigmodel:refresh_token
oauth:bigmodel:user_info
zcodejwttoken
```

value 支持四种形态：

```text
enc:v2:os:{fingerprint}:{nonce}.{tag}.{ciphertext}
enc:v2:env:{fingerprint}:{nonce}.{tag}.{ciphertext}
enc:v1:{nonce}.{tag}.{ciphertext}
明文
```

- `fingerprint` = `SHA-256(key)` 的 hex 前 24 位。
- `nonce` = 12 字节，base64url 无 padding。
- `tag` = 16 字节，base64url 无 padding。
- `ciphertext` = AES-256-GCM 输出，base64url 无 padding。
- v2 无 AAD。

### 密钥来源与优先级

ZCode 的解析顺序（简化）：

1. `ZCODE_CREDENTIAL_SECRET` 环境变量（如果同时设置 `ZCODE_CREDENTIAL_SECRET_FILE` 会报错）。
2. `ZCODE_CREDENTIAL_SECRET_FILE` 指向的文件。
3. 隐式文件 `$CREDENTIALS_DIR/credential-secret`（32–4096 字节；Unix 要求 0600）。
   - 只在凭据**未固定到 OS** 时使用：即不存在 `credential-source`，且没有 `enc:v2:os:` 值。
4. OS 钥匙串。
   - service = `ZCode Credential Encryption`
   - account = `SHA-256(path.resolve(credentials.json)).hex`
   - Windows：Credential Manager generic credential，**target = `<account>.<service>`**，UserName = account，blob 是 43 字符 base64url 密钥的 UTF-16LE 编码（86 字节）。
   - 已用 ZCode 3.18.2 自带的 `keyring.win32-x64-msvc.node` 验证：原生模块写入后本工具能读，本工具写入后原生模块能读。
   - 随机 32 字节密钥，base64url 编码后 43 字符。

env 模式的 key：

```text
key = SHA-256(secret UTF-8 bytes)
```

legacy `enc:v1` 的候选 key（按顺序尝试）：

```text
ZCODE_CREDENTIAL_SECRET
ZCODE_CREDENTIAL_SECRET.trim()
zcode-credential-fallback:{platform}:{homedir}:{username}
```

### credential-source

- 内容必须恰好是 `os\n`。
- 存在即固定到 OS 钥匙串；env 模式必须没有该文件。
- 值里出现 `enc:v2:os:` 也会被 ZCode 视为 OS 固定，并在成功后补写该文件。

### 设备身份

`onboarding-record.json` 的 `deviceMid` 会作为 `X-Device-Mid` 请求头发送给 ZCode 服务端。是否与 token 绑定尚未在真实账号上验证；`zcode-sync import --device-id clone` 可选择覆盖目标机的 `deviceMid`。

## 2. `.zcs` 迁移包

### 布局

```text
offset  size   field
0       8      magic = "ZCSYNC\0\0"
8       1      version = 1
9       1      kdfId: 1 = scrypt, 2 = argon2id（仅解析预留）
10      4      headerLen (big-endian u32)
14      N      header JSON (UTF-8)
14+N    M      AES-256-GCM 密文 + 16 字节 tag
```

### header

示例：

```json
{
  "v": 1,
  "createdAt": "2026-11-19T12:00:00.000Z",
  "kdf": {
    "id": "scrypt",
    "N": 65536,
    "r": 8,
    "p": 1,
    "keyLen": 32,
    "salt": "base64url-16-bytes"
  },
  "aead": {
    "id": "aes-256-gcm",
    "nonce": "base64url-12-bytes",
    "tagLen": 16
  }
}
```

- AAD = `magic || version || kdfId || headerLen || header`
- 密钥 = `scrypt(passphrase, salt, N, r, p, keyLen=32)`
- 当前创建只使用 scrypt；解密时若 header 声明 argon2id，会尝试 `crypto.argon2Sync`（部分 Electron/OpenSSL 构建未启用，会明确报错）。
- 限制：header ≤ 64 KiB，整包 ≤ 8 MiB，N ≤ 2^20，r ≤ 16，p ≤ 8，KDF 内存 ≤ 512 MiB，salt 8–64 字节，nonce 12 字节，tag 16 字节。

### payload（解密后的 JSON）

```json
{
  "format": 1,
  "createdAt": "2026-11-19T12:00:00.000Z",
  "source": {
    "platform": "win32",
    "arch": "x64",
    "zcodeVersion": "3.18.2.10443",
    "credentialsPath": "C:\\Users\\me\\.zcode\\v2\\credentials.json",
    "keySource": "os",
    "deviceMid": "optional, only with --include-device-id"
  },
  "summary": {
    "activeProvider": "zai",
    "user": { "email": "...", "username": "...", "id": "..." },
    "accessTokenExpiresAt": "2026-11-19T13:00:00.000Z",
    "refreshTokenFingerprint": "1a2b3c4d",
    "identityKeyCount": 5,
    "otherKeyCount": 1,
    "keyCount": 6
  },
  "credentials": {
    "oauth:active_provider": "zai",
    "oauth:zai:access_token": "...",
    "oauth:zai:refresh_token": "...",
    "oauth:zai:user_info": "{...}",
    "zcodejwttoken": "..."
  }
}
```

`credentials` 是**解密后的明文 map**。迁移包本身用口令加密，明文只存在于解密后的内存中。

## 3. 导入时的重加密

1. 解析并解密迁移包。
2. 读取目标机现有凭据（如果存在），按需解密以保留非身份类 provider key。
3. 按合并策略得到明文字典。
4. 选择目标密钥：
   - os：复用目标机钥匙串 key；不存在则生成 32 字节随机 key 并写入，读回校验。
   - env：使用 `--secret-file` / `ZCODE_CREDENTIAL_SECRET` / `ZCODE_CREDENTIAL_SECRET_FILE` / 现有 `credential-secret`；否则生成 43 字符 base64url secret。
5. 用目标 key 加密整个结果 map，逐项做解密回环校验。
6. 备份后原子写 `credentials.json`；os 模式写 `credential-source=os\n`，env 模式移除该文件并写 `credential-secret`。
7. 可选克隆 `deviceMid`。

这样目标机不会依赖源机的钥匙串密钥，也不会把源机的 OS 密钥复制到目标机。
