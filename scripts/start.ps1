$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.env')) {
  $dbPassword = -join (1..4 | ForEach-Object { [guid]::NewGuid().ToString('N') })
  $hookToken = -join (1..4 | ForEach-Object { [guid]::NewGuid().ToString('N') })
  @("POSTGRES_PASSWORD=$dbPassword", "HOOK_TOKEN=$hookToken", "DATA_DIR=../dachuang-data") | Set-Content -LiteralPath '.env' -Encoding ascii
}
$dataDir = Join-Path (Split-Path -Parent (Get-Location).Path) 'dachuang-data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
docker compose up -d --build db ollama
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed. Check Docker Desktop.' }
powershell -ExecutionPolicy Bypass -File scripts/install-models.ps1
if ($LASTEXITCODE -ne 0) { throw 'Local model installation failed.' }
docker compose up -d --build api indexer tusd
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed. Check Docker Desktop.' }
Write-Host 'Local service started: http://localhost:3000/#documents'
