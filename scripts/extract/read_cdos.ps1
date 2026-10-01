# Reads raw bytes of UObjects from the running game (ReadProcessMemory, read-only,
# no injection). Called by native_defaults.py, which supplies the targets.
# Each target is name:objectIndexHex:classIndexHex:sizeHex; an object is only
# written if its ClassPrivate pointer and InternalIndex match, so a stale
# GObjects dump fails loudly instead of returning garbage.
param(
  [string]$OutDir,
  [int64]$GObjectsOffset = 0x0A803890,
  # object index -> expected class index, from Dumper-7's GObjects-Dump.txt
  [string]$Targets
)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Mem {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static byte[] Read(IntPtr h, long addr, int size) {
    var b = new byte[size]; IntPtr n;
    if (!ReadProcessMemory(h, new IntPtr(addr), b, size, out n)) throw new Exception("read failed at 0x" + addr.ToString("X"));
    return b;
  }
  public static long Ptr(IntPtr h, long addr) { return BitConverter.ToInt64(Read(h, addr, 8), 0); }
}
"@
$p = Get-Process RGame-Win64-Shipping
$base = $p.MainModule.BaseAddress.ToInt64()
$h = [Mem]::OpenProcess(0x0010 -bor 0x0400, $false, $p.Id)  # VM_READ | QUERY_INFORMATION
try {
  $arr = $base + $GObjectsOffset
  $chunks = [Mem]::Ptr($h, $arr)
  $num = [BitConverter]::ToInt32([Mem]::Read($h, $arr + 0x14, 4), 0)
  "base=0x{0:X} objects=0x{1:X} num={2}" -f $base, $chunks, $num
  function Get-Obj([int]$idx) {
    $chunk = [Mem]::Ptr($h, $chunks + 8 * [math]::Floor($idx / 0x10000))
    return [Mem]::Ptr($h, $chunk + 0x18 * ($idx % 0x10000))
  }
  foreach ($t in $Targets.Split(',')) {
    $name, $objIdx, $clsIdx, $size = $t.Split(':')
    $obj = Get-Obj ([Convert]::ToInt32($objIdx, 16))
    $cls = Get-Obj ([Convert]::ToInt32($clsIdx, 16))
    $hdr = [Mem]::Read($h, $obj, 0x18)
    $internalIdx = [BitConverter]::ToInt32($hdr, 0xC)
    $classPtr = [BitConverter]::ToInt64($hdr, 0x10)
    $ok = ($classPtr -eq $cls) -and ($internalIdx -eq [Convert]::ToInt32($objIdx, 16))
    "{0}: obj=0x{1:X} idx=0x{2:X} classMatches={3}" -f $name, $obj, $internalIdx, $ok
    if ($ok) { [IO.File]::WriteAllBytes((Join-Path $OutDir "$name.bin"), [Mem]::Read($h, $obj, [Convert]::ToInt32($size, 16))) }
  }
} finally { [Mem]::CloseHandle($h) | Out-Null }
