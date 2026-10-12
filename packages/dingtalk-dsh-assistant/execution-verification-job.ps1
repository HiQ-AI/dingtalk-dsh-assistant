param([Parameter(Mandatory=$true)][string]$ReceiptPath)
$ErrorActionPreference = 'Stop'
$command = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class DshVerificationJob {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xCount,yCount,fillAttribute,flags;
    public short showWindow,reserved2; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeLimit;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr value,uint size,IntPtr returned);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string executable,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO start,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static uint Active(IntPtr job) {
    IntPtr value=Marshal.AllocHGlobal(48);
    try { Check(QueryInformationJobObject(job,1,value,48,IntPtr.Zero)); return unchecked((uint)Marshal.ReadInt32(value,40)); }
    finally { Marshal.FreeHGlobal(value); }
  }
  static string Quote(string argument) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in argument) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); }
      else { result.Append('\\',slashes); result.Append(c); }
      slashes=0;
    }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  public static int Run(string executable,string[] args,string cwd) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
    PROCESS_INFORMATION child=new PROCESS_INFORMATION(); bool assigned=false;
    try {
      var limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway permission.
      int size=Marshal.SizeOf(limits); IntPtr memory=Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(limits,memory,false); Check(SetInformationJobObject(job,9,memory,(uint)size)); }
      finally { Marshal.FreeHGlobal(memory); }
      var start=new STARTUPINFO(); start.cb=Marshal.SizeOf(start); start.flags=0x100;
      start.input=GetStdHandle(-10); start.output=GetStdHandle(-11); start.error=GetStdHandle(-12);
      var command=new StringBuilder(Quote(executable)); foreach(string arg in args) command.Append(" "+Quote(arg));
      // No target code executes before the kernel binds it and all future descendants to the Job.
      Check(CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref start,out child));
      Check(AssignProcessToJobObject(job,child.process)); assigned=true;
      Check(ResumeThread(child.thread)!=0xffffffff); Check(WaitForSingleObject(child.process,0xffffffff)==0);
      uint exitCode; Check(GetExitCodeProcess(child.process,out exitCode));
      // Parent exit is not completion: wait for every descendant, including detached/orphaned descendants.
      while(Active(job)!=0) Thread.Sleep(50);
      return unchecked((int)exitCode);
    } catch {
      if(assigned) { Check(TerminateJobObject(job,1)); while(Active(job)!=0) Thread.Sleep(50); }
      else if(child.process!=IntPtr.Zero) { Check(TerminateProcess(child.process,1)); Check(WaitForSingleObject(child.process,0xffffffff)==0); }
      throw;
    } finally {
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      CloseHandle(job);
    }
  }
}
"@
try {
  $exitCode = [DshVerificationJob]::Run([string]$command.executable,[string[]]$command.args,[string]$command.directory)
  @{ executionDrained=$true; exitCode=$exitCode } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReceiptPath -Encoding utf8
  exit $exitCode
} catch {
  # A failure has no success/drain receipt; Host retains its lease until explicit native reconciliation.
  [Console]::Error.WriteLine('VERIFY_JOB_NATIVE_LIFECYCLE_FAILED')
  exit 1
}
