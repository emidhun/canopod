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

$mcpRoot = Join-Path $env:TEMP "canopy-mcp-release-smoke-$PID"
$configDir = Join-Path $mcpRoot "config"
$dataDir = Join-Path $mcpRoot "data"
$logDir = Join-Path $mcpRoot "logs"
$repoDir = Join-Path $mcpRoot "mcp-fixture"
New-Item -ItemType Directory -Force $configDir, $dataDir, $logDir, $repoDir | Out-Null
& git -C $repoDir init -b main | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not create MCP fixture repository" }
$common = @("--config-dir", $configDir, "--data-dir", $dataDir, "--log-dir", $logDir)
$mcpBackend = Start-Process -FilePath $backend.FullName -ArgumentList (@("serve", "--port", "47991") + $common) -RedirectStandardOutput (Join-Path $mcpRoot "backend.out") -RedirectStandardError (Join-Path $mcpRoot "backend.err") -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    & $backend.FullName status @common *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) { throw "Packaged backend did not become ready" }
  & $backend.FullName repo add $repoDir @common | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Headless repository registration failed" }
  & $backend.FullName mcp enable --repo mcp-fixture --read-only @common | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "MCP enable failed" }
  & $backend.FullName mcp smoke --repo mcp-fixture @common | Tee-Object -FilePath (Join-Path $mcpRoot "mcp-smoke.json")
  if ($LASTEXITCODE -ne 0) { throw "MCP packaged smoke failed" }
  & $backend.FullName stop @common | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Backend stop failed" }
  $mcpBackend.WaitForExit(12000)
  if (-not $mcpBackend.HasExited -or $mcpBackend.ExitCode -ne 0) { throw "Backend did not stop cleanly" }
} finally {
  if (-not $mcpBackend.HasExited) { Stop-Process -Id $mcpBackend.Id -Force }
  Remove-Item -Recurse -Force $mcpRoot -ErrorAction SilentlyContinue
}

$launched = Start-Process -FilePath $app.FullName -PassThru
Start-Sleep -Seconds 8
if ($launched.HasExited) { throw "Installed Canopy exited during launch probe with $($launched.ExitCode)" }
Stop-Process -Id $launched.Id -Force
