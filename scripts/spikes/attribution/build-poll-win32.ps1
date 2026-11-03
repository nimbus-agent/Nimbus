#requires -Version 5.1
# Builds poll-win32.exe with MSVC, the same way scripts/build-sandbox-helper-win32.ps1 builds the helper.
$ErrorActionPreference = "Stop"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
$src = Join-Path $PSScriptRoot "poll-win32.c"
$out = Join-Path $PSScriptRoot "poll-win32.exe"
$obj = Join-Path $PSScriptRoot "poll-win32.obj"
cmd.exe /c "`"$vcvars`" && cl /nologo /W3 /O2 /Fo:`"$obj`" /Fe:`"$out`" `"$src`""
if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE" }
Write-Output "built $out"
