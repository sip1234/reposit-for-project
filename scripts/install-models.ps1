$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$container = (docker compose ps -q ollama).Trim()
if (-not $container) { throw 'Ollama container is not running.' }
$dataDir = Join-Path (Split-Path -Parent (Get-Location).Path) 'dachuang-data'
$cache = Join-Path $dataDir 'model-downloads'
New-Item -ItemType Directory -Path $cache -Force | Out-Null

foreach ($model in @('qwen3-embedding:0.6b', 'qwen3:4b-instruct')) {
  $installed = (docker compose exec -T ollama ollama list | Out-String)
  if ($installed -match [regex]::Escape($model)) { continue }
  Write-Host "Installing $model..."
  $ErrorActionPreference = 'Continue'
  docker compose exec -T ollama ollama pull $model *> $null
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -eq 0) { continue }
  Write-Host 'Using host download because the container cannot follow the model registry redirect.'
  $name, $tag = $model.Split(':')
  $manifestUrl = "https://registry.ollama.ai/v2/library/$name/manifests/$tag"
  $manifest = Invoke-RestMethod -Uri $manifestUrl
  foreach ($layer in @($manifest.config) + @($manifest.layers)) {
    $digest = $layer.digest.Split(':')[1]
    $blobName = "sha256-$digest"
    $local = Join-Path $cache $blobName
    if (-not (Test-Path -LiteralPath $local) -or (Get-Item -LiteralPath $local).Length -lt [long]$layer.size) {
      & curl.exe -L --fail --silent --show-error -C - -o $local "https://registry.ollama.ai/v2/library/$name/blobs/$($layer.digest)"
      if ($LASTEXITCODE -ne 0) { throw "Download failed: $model $digest" }
    }
    $actual = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $digest) { throw "Model checksum mismatch: $model $digest" }
    docker compose exec -T ollama mkdir -p /root/.ollama/models/blobs
    docker cp $local "${container}:/root/.ollama/models/blobs/$blobName"
    if ($LASTEXITCODE -ne 0) { throw "Model copy failed: $model $digest" }
    Remove-Item -LiteralPath $local -Force
  }
  $manifestPath = Join-Path $cache "$name-$tag.json"
  [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10 -Compress), [System.Text.UTF8Encoding]::new($false))
  docker compose exec -T ollama mkdir -p "/root/.ollama/models/manifests/registry.ollama.ai/library/$name"
  docker cp $manifestPath "${container}:/root/.ollama/models/manifests/registry.ollama.ai/library/$name/$tag"
  if ($LASTEXITCODE -ne 0) { throw "Model manifest installation failed: $model" }
  Remove-Item -LiteralPath $manifestPath -Force
  $installed = (docker compose exec -T ollama ollama list | Out-String)
  if ($installed -notmatch [regex]::Escape($model)) { throw "Model was not recognized: $model" }
}
