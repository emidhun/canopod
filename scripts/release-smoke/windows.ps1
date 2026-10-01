param(
  [Parameter(Mandatory = $true)][ValidateSet("nsis", "msi")][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Packages,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"

if ($Kind -eq "nsis") {
  $installer = Get-ChildItem $Packages -Filter "*.exe" | Select-Object -First 1
  $process = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
} else {
  $installer = Get-ChildItem $Packages -Filter "*.msi" | Select-Object -First 1
  $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$($installer.FullName)`" /qn /norestart" -Wait -PassThru
}

if ($process.ExitCode -ne 0) { throw "$Kind installer exited with $($process.ExitCode)" }

$uninstallRoots = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
$entry = Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq "Canopy" } |
  Select-Object -First 1
$candidates = @(
  $entry.InstallLocation,
  "$env:LOCALAPPDATA\Canopy",
  "$env:LOCALAPPDATA\Programs\Canopy",
  "$env:ProgramFiles\Canopy"
) | Where-Object { $_ -and (Test-Path $_) }
$app = Get-ChildItem $candidates -Recurse -File -Filter "Canopy.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$backend = Get-ChildItem $candidates -Recurse -File -Filter "canopy-backend.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $app -or -not $backend) { throw "Installed Canopy executables were not found" }

$version = & $backend.FullName --version
if ($version -ne "canopy-backend $ExpectedVersion") { throw "Unexpected backend version: $version" }

$launched = Start-Process -FilePath $app.FullName -PassThru
Start-Sleep -Seconds 8
if ($launched.HasExited) { throw "Installed Canopy exited during launch probe with $($launched.ExitCode)" }
Stop-Process -Id $launched.Id -Force
