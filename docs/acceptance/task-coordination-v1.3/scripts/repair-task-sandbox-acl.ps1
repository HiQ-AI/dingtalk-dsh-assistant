# Execute requires no concurrent ACL writer (including native grantWrite).
# Read-before-write detects observed changes; SetNamedSecurityInfo is not CAS.
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
  [Parameter(ParameterSetName = 'Check')][switch]$Check,
  [Parameter(Mandatory, ParameterSetName = 'Execute')][switch]$Execute,
  [Parameter(Mandatory, ParameterSetName = 'Execute')][string]$EvidenceDirectory,
  [ValidateSet('coordination-f1767af593d66d5eabe73d31dfbc9a30')][string]$CoordinationId,
  [ValidateSet('task-cfe4f8e8b0993c6458d8391f9e885516', 'task-3379b3ead0e8713b6df0783f2ec88721', 'task-4d198f4ac51b9830ac50de22ff9e223a')]
  [string[]]$TaskId = @('task-cfe4f8e8b0993c6458d8391f9e885516', 'task-3379b3ead0e8713b6df0783f2ec88721', 'task-4d198f4ac51b9830ac50de22ff9e223a')
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows is required.' }
if ($TaskId.Count -ne @($TaskId | Select-Object -Unique).Count) { throw 'Duplicate task IDs are not allowed.' }
if ($CoordinationId -and $PSBoundParameters.ContainsKey('TaskId')) { throw 'CoordinationId and TaskId are mutually exclusive.' }

# This is a one-round repair, not a general permission-management command.
$root = 'D:\baibu-agent\tasks'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if (([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run as the existing unelevated Host owner, not as administrator.'
}
if (-not ('TaskSandboxAcl.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
namespace TaskSandboxAcl {
  public static class Native {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetNamedSecurityInfoW(string path,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor,uint revision,uint info,out IntPtr text,out uint length);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern uint SetNamedSecurityInfoW(string path,int type,uint info,IntPtr owner,IntPtr group,byte[] dacl,IntPtr sacl);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    public static bool CanOpen(string path,uint access) {
      // OPEN_EXISTING only: no directory, file, owner, DACL or label changes.
      using(var h=CreateFileW(path,access,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
        if(!h.IsInvalid) return true;
        int code=Marshal.GetLastWin32Error();
        if(code==5) return false;
        throw new Win32Exception(code,"Permission probe: "+path);
      }
    }
    public static string ReadSddl(string path) {
      IntPtr owner,group,dacl,sacl,sd,text;
      // LABEL_SECURITY_INFORMATION reads the mandatory label without requesting
      // privileged audit-SACL access. Its bytes are verified after DACL-only writes.
      uint code=GetNamedSecurityInfoW(path,1,0x17,out owner,out group,out dacl,out sacl,out sd);
      if(code!=0) throw new Win32Exception((int)code,"Read security: "+path);
      try {
        uint length;
        if(!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd,1,0x17,out text,out length)) throw new Win32Exception();
        try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
      } finally { LocalFree(sd); }
    }
    public static void WriteDacl(string path,string sddl) {
      var sd=new RawSecurityDescriptor(sddl);
      if(sd.DiscretionaryAcl==null) throw new InvalidOperationException("Null DACL refused.");
      var dacl=new byte[sd.DiscretionaryAcl.BinaryLength];
      sd.DiscretionaryAcl.GetBinaryForm(dacl,0);
      // DACL only: never set owner/group, SACL, mandatory label or inheritance flags.
      uint code=SetNamedSecurityInfoW(path,1,4,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero);
      if(code!=0) throw new Win32Exception((int)code,"Write DACL: "+path);
    }
  }
}
'@
}

function Assert-DirectoryChain([string]$Path) {
  $current = $Path
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Non-directory or reparse point refused: $current"
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
  }
}
function Read-Target([string]$Path) {
  Assert-DirectoryChain $Path
  $sddl = [TaskSandboxAcl.Native]::ReadSddl($Path)
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
  [pscustomobject]@{
    path = $Path
    ownerSid = $raw.Owner.Value
    currentOwner = $raw.Owner.Value -eq $sid.Value
    writeDac = [TaskSandboxAcl.Native]::CanOpen($Path, 0x40000)
    writeOwner = [TaskSandboxAcl.Native]::CanOpen($Path, 0x80000)
    combined = [TaskSandboxAcl.Native]::CanOpen($Path, 0xC0000)
    sddl = $sddl
  }
}
function Get-AceBytes($Acl) {
  if ($null -eq $Acl) { return '' }
  $bytes = [byte[]]::new($Acl.BinaryLength)
  $Acl.GetBinaryForm($bytes, 0)
  [Convert]::ToBase64String($bytes)
}
function New-RepairedSddl([string]$Sddl) {
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'Null DACL refused.' }
  $ace = [Security.AccessControl.CommonAce]::new(
    [Security.AccessControl.AceFlags]::None,
    [Security.AccessControl.AceQualifier]::AccessAllowed,
    0x80000, $sid, $false, $null)
  $position = 0
  while ($position -lt $raw.DiscretionaryAcl.Count -and -not $raw.DiscretionaryAcl[$position].IsInherited) { $position++ }
  $raw.DiscretionaryAcl.InsertAce($position, $ace)
  $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
}

$paths = if ($CoordinationId) { @(Join-Path $root (Join-Path $CoordinationId 'outputs')) } else { @($TaskId | ForEach-Object { Join-Path $root $_ }) }
$before = @($paths | ForEach-Object { Read-Target $_ })
if (@($before | Where-Object { -not $_.currentOwner -or -not $_.writeDac }).Count) {
  $before | ConvertTo-Json -Depth 8
  throw 'Refused: current owner and effective WRITE_DAC are required on every selected root.'
}
if (-not $Execute) {
  [pscustomobject]@{ mode = 'check'; sid = $sid.Value; ready = $true; targets = $before } | ConvertTo-Json -Depth 8
  return
}
if (-not [IO.Path]::IsPathFullyQualified($EvidenceDirectory)) { throw 'EvidenceDirectory must be absolute.' }
Assert-DirectoryChain $EvidenceDirectory
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory).TrimEnd('\')
foreach ($path in $paths) {
  if ($evidenceRoot -eq $path -or $evidenceRoot.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Evidence must be outside the directories being repaired.'
  }
}
$run = [guid]::NewGuid().ToString('N')
$beforeFile = Join-Path $evidenceRoot "acl-before-$run.json"
$afterFile = Join-Path $evidenceRoot "acl-after-$run.json"
function Save-Evidence([string]$Path, $Value) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 8))
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
}
Save-Evidence $beforeFile $before
$expectedSddl = @{}
$changed = @()
try {
  foreach ($target in $before) {
    if ($target.combined) { $expectedSddl[$target.path] = $target.sddl; continue }
    $current = Read-Target $target.path
    if ($current.sddl -cne $target.sddl) { throw "Concurrent ACL change refused: $($target.path)" }
    $expected = New-RepairedSddl $target.sddl
    $expectedSddl[$target.path] = $expected
    [TaskSandboxAcl.Native]::WriteDacl($target.path, $expected)
    $changed += $target.path
    $after = Read-Target $target.path
    $expectedRaw = [Security.AccessControl.RawSecurityDescriptor]::new($expected)
    $afterRaw = [Security.AccessControl.RawSecurityDescriptor]::new($after.sddl)
    $beforeRaw = [Security.AccessControl.RawSecurityDescriptor]::new($target.sddl)
    if (-not $after.combined -or $after.ownerSid -ne $target.ownerSid -or
        $afterRaw.Group.Value -ne $beforeRaw.Group.Value -or
        (Get-AceBytes $afterRaw.SystemAcl) -cne (Get-AceBytes $beforeRaw.SystemAcl) -or
        (Get-AceBytes $afterRaw.DiscretionaryAcl) -cne (Get-AceBytes $expectedRaw.DiscretionaryAcl) -or
        $afterRaw.ControlFlags -ne $beforeRaw.ControlFlags) {
      throw "Post-write verification failed: $($target.path); inspect $beforeFile before any further repair."
    }
  }
  $after = @($paths | ForEach-Object { Read-Target $_ })
  foreach ($target in $after) {
    $expected = $expectedSddl[$target.path]
    if ($null -eq $expected -or $target.sddl -cne $expected -or -not $target.currentOwner -or -not $target.combined) {
      throw "Final collection verification failed: $($target.path); concurrent ACL writer or unexpected descriptor change."
    }
  }
  Save-Evidence $afterFile $after
  [pscustomobject]@{ mode = 'execute'; verified = $true; changed = $changed; before = $beforeFile; after = $afterFile; targets = $after } | ConvertTo-Json -Depth 8
} catch {
  $after = @($paths | ForEach-Object { Read-Target $_ })
  Save-Evidence $afterFile $after
  throw "Repair stopped; do not retry blindly. Changed roots: $($changed -join ', '). Before=$beforeFile After=$afterFile. $($_.Exception.Message)"
}
