param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$code = @'
using System;
using System.Runtime.InteropServices;

public static class ZcodeSyncCredNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr buffer);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDeleteW(string target, uint type, uint flags);

    public static void Write(string target, string user, byte[] blob, uint persist) {
        IntPtr blobPtr = Marshal.AllocHGlobal(blob.Length);
        try {
            Marshal.Copy(blob, 0, blobPtr, blob.Length);
            var cred = new CREDENTIAL();
            cred.Type = 1; // CRED_TYPE_GENERIC
            cred.TargetName = target;
            cred.UserName = user;
            cred.CredentialBlob = blobPtr;
            cred.CredentialBlobSize = (uint)blob.Length;
            cred.Persist = persist;
            if (!CredWriteW(ref cred, 0)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        } finally {
            Marshal.FreeHGlobal(blobPtr);
        }
    }

    public static byte[] Read(string target, out string user) {
        IntPtr ptr;
        if (!CredReadW(target, 1, 0, out ptr)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            user = cred.UserName ?? "";
            byte[] blob = new byte[cred.CredentialBlobSize];
            if (blob.Length > 0) Marshal.Copy(cred.CredentialBlob, blob, 0, blob.Length);
            return blob;
        } finally {
            CredFree(ptr);
        }
    }

    public static bool Delete(string target) {
        if (!CredDeleteW(target, 1, 0)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) return false; // ERROR_NOT_FOUND
            throw new System.ComponentModel.Win32Exception(err);
        }
        return true;
    }
}
'@

function Respond([hashtable]$payload) {
    $payload | ConvertTo-Json -Compress -Depth 6
    exit 0
}

function Get-Win32Code($exception) {
    try {
        if ($exception -is [System.ComponentModel.Win32Exception]) { return $exception.NativeErrorCode }
        if ($exception.InnerException -is [System.ComponentModel.Win32Exception]) { return $exception.InnerException.NativeErrorCode }
    } catch { }
    return $null
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Respond @{ ok = $false; error = @{ message = 'empty request' } }
    }
    $req = $raw | ConvertFrom-Json
    $action = [string]$req.action
    $target = [string]$req.target
    if ([string]::IsNullOrWhiteSpace($target)) {
        Respond @{ ok = $false; error = @{ message = 'target is required' } }
    }

    Add-Type -TypeDefinition $code -Language CSharp

    switch ($action) {
        'read' {
            try {
                $user = ''
                $blob = [ZcodeSyncCredNative]::Read($target, [ref]$user)
                Respond @{
                    ok = $true
                    found = $true
                    blobB64 = [Convert]::ToBase64String($blob)
                    user = $user
                }
            } catch {
                if ((Get-Win32Code $_.Exception) -eq 1168) {
                    Respond @{ ok = $true; found = $false }
                }
                throw
            }
        }
        'write' {
            $blob = [Convert]::FromBase64String([string]$req.blobB64)
            [ZcodeSyncCredNative]::Write($target, [string]$req.user, $blob, 2)
            Respond @{ ok = $true }
        }
        'delete' {
            $deleted = [ZcodeSyncCredNative]::Delete($target)
            Respond @{ ok = $true; deleted = $deleted }
        }
        default {
            Respond @{ ok = $false; error = @{ message = "unknown action: $action" } }
        }
    }
} catch {
    Respond @{
        ok = $false
        error = @{
            message = [string]$_.Exception.Message
            win32 = (Get-Win32Code $_.Exception)
        }
    }
}
