# Build the Windows installer from executables already built.
#
#   pwsh packaging/windows.ps1 <version> [bin]
#   pwsh packaging/windows.ps1 1.2.0                   # target\release
#
# Writes dist\snyvi-<version>-x86_64-pc-windows-msvc-setup.exe and its
# .sha256 beside it, written the way sha256sum writes one, so the release's
# checksums all read alike. The installer itself is packaging\windows.iss.
#
# One script for ci.yml and release.yml both: an installer that is only built
# at release time is broken exactly when it matters.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Bin = "target\release"
)
$ErrorActionPreference = "Stop"
$Version = $Version -replace '^v', ''
$root = Split-Path -Parent $PSScriptRoot

foreach ($exe in "snyvi.exe", "snyvi-app.exe") {
  if (-not (Test-Path (Join-Path $Bin $exe))) {
    throw "windows.ps1: no $exe in $Bin; build both first"
  }
}

# Inno Setup has come and gone from the hosted runner images; install it when
# this one lacks it rather than depend on which image the job landed on.
$iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
  if (-not (Test-Path $iscc)) {
    choco install innosetup --yes --no-progress | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "windows.ps1: could not install Inno Setup" }
  }
}

$binAbs = (Resolve-Path $Bin).Path
& $iscc /Q "/DVersion=$Version" "/DBin=$binAbs" (Join-Path $root "packaging\windows.iss")
if ($LASTEXITCODE -ne 0) { throw "windows.ps1: iscc failed" }

$name = "snyvi-$Version-x86_64-pc-windows-msvc-setup.exe"
$dist = Join-Path $root "dist"
$file = Join-Path $dist $name
$hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText("$file.sha256", "$hash  $name`n")
Write-Output $file
