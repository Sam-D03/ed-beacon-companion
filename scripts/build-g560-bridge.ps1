[CmdletBinding()]
param(
    [string] $OutputDirectory,
    [switch] $SkipSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $PSCommandPath
$repositoryRoot = Split-Path -Parent $scriptDirectory
$projectPath = Join-Path $repositoryRoot "native\g560-bridge\g560-bridge.vcxproj"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repositoryRoot "build\native"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "Visual Studio Build Tools were not found (vswhere.exe is missing)."
}
$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($msbuild) -or -not (Test-Path -LiteralPath $msbuild)) {
    throw "MSBuild with the Visual C++ toolchain was not found."
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outDirProperty = $OutputDirectory.TrimEnd("\") + "\"
& $msbuild $projectPath /nologo /m /t:Build /p:Configuration=Release /p:Platform=x64 "/p:OutDir=$outDirProperty"
if ($LASTEXITCODE -ne 0) {
    throw "The G560 bridge build failed with exit code $LASTEXITCODE."
}

$bridgePath = Join-Path $OutputDirectory "g560-bridge.exe"
if (-not (Test-Path -LiteralPath $bridgePath)) {
    throw "MSBuild completed without producing $bridgePath."
}
if (-not $SkipSelfTest) {
    & $bridgePath --self-test
    if ($LASTEXITCODE -ne 0) {
        throw "The G560 bridge self-test failed with exit code $LASTEXITCODE."
    }
}

Write-Host "G560 bridge built: $bridgePath"
