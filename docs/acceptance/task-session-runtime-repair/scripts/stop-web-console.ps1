param([switch]$Check,[Parameter(Mandatory)][int]$ExpectedPid)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TaskConsoleSignal {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool FreeConsole();
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AttachConsole(uint processId);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] list,uint count);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint controlEvent,uint processGroupId);
}
"@
$original=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
if(-not $original -or $original.CommandLine -notlike '*D:\dsh_home\profiles\web\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open*'){throw 'CONSOLE_TARGET_IDENTITY'}
$parent=Get-CimInstance Win32_Process -Filter "ProcessId=$($original.ParentProcessId)"
if(-not $parent -or $parent.Name -ne 'pwsh.exe' -or $parent.CommandLine -notlike '*D:\dsh_home\launchers\start-web.ps1*'){throw 'CONSOLE_PARENT_IDENTITY'}
$processes=@(Get-CimInstance Win32_Process)
$allowed=[Collections.Generic.HashSet[uint32]]::new()
[void]$allowed.Add([uint32]$ExpectedPid);[void]$allowed.Add([uint32]$parent.ProcessId);[void]$allowed.Add([uint32]$PID)
do{$added=$false;foreach($process in $processes){if($allowed.Contains([uint32]$process.ParentProcessId)-and $process.ProcessId-ne$PID-and $allowed.Add([uint32]$process.ProcessId)){$added=$true}}}while($added)
[void][TaskConsoleSignal]::FreeConsole()
if(-not [TaskConsoleSignal]::AttachConsole([uint32]$ExpectedPid)){throw "CONSOLE_ATTACH_FAILED:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"}
try{
 $ids=[uint32[]]::new(256);$count=[TaskConsoleSignal]::GetConsoleProcessList($ids,256)
 if($count-eq0-or$count-gt256){throw 'CONSOLE_INVENTORY_FAILED'}
 $members=@($ids[0..($count-1)])
 if($members|Where-Object {-not $allowed.Contains($_)}){throw 'CONSOLE_UNRELATED_PROCESS_PRESENT'}
 if($ExpectedPid-notin$members){throw 'CONSOLE_TARGET_NOT_PRESENT'}
 if($Check){@{checkOnly=$true;signals=0;targetPid=$ExpectedPid;consolePids=$members}|ConvertTo-Json -Compress;exit 0}
 $current=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
 if(-not$current-or$current.CreationDate-ne$original.CreationDate){throw 'CONSOLE_TARGET_CHANGED'}
 if(-not[TaskConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)){throw 'CONSOLE_IGNORE_FAILED'}
 if(-not[TaskConsoleSignal]::GenerateConsoleCtrlEvent(0,0)){throw "CONSOLE_SIGNAL_FAILED:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"}
 @{signalSent='CTRL_C_EVENT';targetPid=$ExpectedPid;consolePids=$members;drainVerified=$false}|ConvertTo-Json -Compress
}finally{[void][TaskConsoleSignal]::FreeConsole()}
