param(
 [Parameter(Mandatory)][string]$WorkspaceRoot,
 [switch]$Check,
 [string]$ExpectedAclSha256,
 [string]$EvidenceDirectory
)
$ErrorActionPreference='Stop'
if(-not$IsWindows){throw 'TASK_ACL_WINDOWS_REQUIRED'}
if(-not[IO.Path]::IsPathFullyQualified($WorkspaceRoot)){throw 'TASK_ACL_ABSOLUTE_ROOT_REQUIRED'}
$workspace=[IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\','/')
if($workspace-eq[IO.Path]::GetPathRoot($workspace).TrimEnd('\','/')){throw 'TASK_ACL_VOLUME_ROOT_REFUSED'}
$target=Join-Path $workspace 'tasks'
function AssertDirectoryChain([string]$path){
 $item=Get-Item -LiteralPath $path -Force
 while($null-ne$item){
  if($item-isnot[IO.DirectoryInfo]-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)){throw 'TASK_ACL_REPARSE_OR_NON_DIRECTORY'}
  $item=$item.Parent
 }
}
AssertDirectoryChain $target
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$sections=[Security.AccessControl.AccessControlSections]::Access
function AclDigest($acl){
 $bytes=[Text.Encoding]::UTF8.GetBytes($acl.GetSecurityDescriptorSddlForm($sections))
 return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function AssertOwner($acl){if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-ne$sid.Value){throw 'TASK_ACL_FOREIGN_OWNER'}}
function PreservedRules($acl){
 @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {
  $_.IdentityReference.Value-ne$sid.Value-or$_.AccessControlType-eq'Deny'
 }|ForEach-Object {"$($_.IdentityReference.Value)|$($_.FileSystemRights)|$($_.AccessControlType)|$($_.IsInherited)|$($_.InheritanceFlags)|$($_.PropagationFlags)"}|Sort-Object)
}
function HasInheritableFullControl($acl){
 $full=[int][Security.AccessControl.FileSystemRights]::FullControl
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($rule.IdentityReference.Value-eq$sid.Value-and$rule.AccessControlType-eq'Allow'-and
    (([int]$rule.FileSystemRights-band$full)-eq$full)-and
    (([int]$rule.InheritanceFlags-band3)-eq3)-and$rule.PropagationFlags-eq'None'){return $true}
 }
 return $false
}
# 与原生诊断入口相同，仅写DACL，不请求owner/group/SACL变更。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;
public static class TaskDirectoryAcl {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
 static extern uint SetNamedSecurityInfoW(string path,int type,uint info,IntPtr owner,IntPtr group,byte[] dacl,IntPtr sacl);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 public static bool HasAccess(string path,uint access){
  using(var handle=CreateFileW(path,access,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){
   if(!handle.IsInvalid)return true;
   int error=Marshal.GetLastWin32Error();if(error==5)return false;
   throw new System.ComponentModel.Win32Exception(error);
  }
 }
 public static void WriteDacl(string path,string sddl){
  var sd=new RawSecurityDescriptor(sddl);var bytes=new byte[sd.DiscretionaryAcl.BinaryLength];sd.DiscretionaryAcl.GetBinaryForm(bytes,0);
  uint protection=(sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0?0x80000000u:0x20000000u;
  uint result=SetNamedSecurityInfoW(path,1,4u|protection,IntPtr.Zero,IntPtr.Zero,bytes,IntPtr.Zero);
  if(result!=0)throw new System.ComponentModel.Win32Exception((int)result);
 }
}
'@
$before=Get-Acl -LiteralPath $target
AssertOwner $before
$digest=AclDigest $before
$writeDac=[TaskDirectoryAcl]::HasAccess($target,0x40000)
$writeOwner=[TaskDirectoryAcl]::HasAccess($target,0x80000)
$needed=-not(HasInheritableFullControl $before)
if($Check){
 @{checkOnly=$true;writes=0;target=$target;currentSid=$sid.Value;aclSha256=$digest;needsChange=$needed;writeDac=$writeDac;writeOwner=$writeOwner;protected=$before.AreAccessRulesProtected}|ConvertTo-Json
 exit 0
}
if($ExpectedAclSha256-notmatch'^[a-fA-F0-9]{64}$'-or$ExpectedAclSha256.ToLowerInvariant()-ne$digest){throw 'TASK_ACL_CHANGED'}
if(-not$writeDac){throw 'TASK_ACL_WRITE_DAC_REQUIRED'}
if(-not$needed){@{changed=$false;target=$target;aclSha256=$digest;writeDac=$writeDac;writeOwner=$writeOwner}|ConvertTo-Json;exit 0}
if(-not[IO.Path]::IsPathFullyQualified($EvidenceDirectory)){throw 'TASK_ACL_EVIDENCE_REQUIRED'}
if(Test-Path -LiteralPath $EvidenceDirectory){throw 'TASK_ACL_EVIDENCE_EXISTS'}
AssertDirectoryChain ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($EvidenceDirectory)))
$beforeSddl=$before.GetSecurityDescriptorSddlForm($sections)
$preserved=PreservedRules $before
$owner=$before.GetOwner([Security.Principal.SecurityIdentifier]).Value
$group=$before.GetGroup([Security.Principal.SecurityIdentifier]).Value
$before.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,
 [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
@{target=$target;owner=$owner;group=$group;aclSha256=$digest;daclSddl=$beforeSddl;protected=$before.AreAccessRulesProtected}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'before.json')
# 备份后再次核对，任何并发权限变更都拒绝写入。
AssertDirectoryChain $target
$current=Get-Acl -LiteralPath $target
AssertOwner $current
if((AclDigest $current)-ne$digest){throw 'TASK_ACL_CHANGED'}
try{
 [TaskDirectoryAcl]::WriteDacl($target,$before.GetSecurityDescriptorSddlForm($sections))
 $after=Get-Acl -LiteralPath $target
 AssertOwner $after
 if($after.GetGroup([Security.Principal.SecurityIdentifier]).Value-ne$group-or$after.AreAccessRulesProtected-ne$before.AreAccessRulesProtected-or
   ((PreservedRules $after)-join"`n")-cne($preserved-join"`n")-or
   -not(HasInheritableFullControl $after)-or-not[TaskDirectoryAcl]::HasAccess($target,0x40000)-or-not[TaskDirectoryAcl]::HasAccess($target,0x80000)){throw 'TASK_ACL_VERIFY_FAILED'}
 $result=@{changed=$true;target=$target;aclSha256=(AclDigest $after);owner=$owner;writeDac=$true;writeOwner=$true;inheritableFullControl=$true}
 $result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'after.json')
 $result|ConvertTo-Json
}catch{
 [TaskDirectoryAcl]::WriteDacl($target,$beforeSddl)
 if((AclDigest (Get-Acl -LiteralPath $target))-ne$digest){throw 'TASK_ACL_ROLLBACK_FAILED'}
 throw
}
