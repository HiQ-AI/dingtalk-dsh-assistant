$ErrorActionPreference = "Stop"
$testDirectory = Join-Path $env:SystemDrive 'dsh-release-tests'
New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null
$current = Get-Item -LiteralPath $testDirectory
while ($null -ne $current) {
  if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'test_directory_must_not_use_reparse_points' }
  $current = $current.Parent
}
$testAcl = Get-Acl -LiteralPath $testDirectory
$testUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
$testAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($testUser, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $testDirectory -AclObject $testAcl
"TEMP=$testDirectory" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"TMP=$testDirectory" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
node --input-type=module -e "import {lstat,realpath} from 'node:fs/promises'; const p=process.argv[1]; const s=await lstat(p); console.log(JSON.stringify({testDirectory:p,realpath:await realpath(p),symlink:s.isSymbolicLink(),dev:s.dev,ino:s.ino}));" $testDirectory
