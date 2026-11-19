param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('export', 'import')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'

function Read-PlainPassphrase {
    param([string]$Prompt)

    $secure = Read-Host -AsSecureString -Prompt $Prompt
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

if ($Mode -eq 'export') {
    $first = Read-PlainPassphrase '设置迁移包口令'
    if ($first.Length -eq 0) {
        [Console]::Error.WriteLine('口令不能为空')
        exit 2
    }
    $second = Read-PlainPassphrase '确认口令'
    if ($first -cne $second) {
        [Console]::Error.WriteLine('两次输入的口令不一致')
        exit 2
    }
    $passphrase = $first
} else {
    $passphrase = Read-PlainPassphrase '迁移包口令'
    if ($passphrase.Length -eq 0) {
        [Console]::Error.WriteLine('口令不能为空')
        exit 2
    }
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($OutFile, $passphrase, $utf8)
exit 0
