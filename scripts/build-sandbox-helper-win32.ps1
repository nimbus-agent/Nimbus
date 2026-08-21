#requires -Version 5.1
# Compiles the Windows sandbox helper with MSVC. No make on Windows runners, and no
# dependency on a Developer prompt: vswhere lives at a fixed path on every VS install.
$ErrorActionPreference = "Stop"

$src = Join-Path $PSScriptRoot "..\packages\gateway\src-native\sandbox-helper-win32"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere not found at $vswhere — is Visual Studio installed?" }

$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw "No Visual Studio installation with the C++ toolset was found." }

$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

$out = Join-Path $src "nimbus-sandbox-helper.exe"
$obj = Join-Path $src "main.obj"
# /Fo names the intermediate .obj explicitly so it lands beside the source (gitignored
# there) rather than wherever cl.exe happens to be invoked from. A directory-form /Fo
# (trailing backslash before the closing quote) is avoided — it trips MSVC's argv
# backslash-escaping and drops the following /Fe/source arguments.
# /W4 /WX mirrors the Linux helper's -Wall -Wextra -Werror.
$cmd = "`"$vcvars`" && cl /nologo /W4 /WX /O2 /Fo:`"$obj`" /Fe:`"$out`" `"$(Join-Path $src 'main.c')`" /link userenv.lib advapi32.lib"
cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE" }
Write-Output "built $out"
