param(
  [string]$OutputDir = ".\backups"
)

$ErrorActionPreference = "Stop"

if (-not $env:MONGODB_URI) {
  throw "MONGODB_URI is not set in this shell. Export it from your secure environment manager; never hardcode it."
}

$mongodump = Get-Command mongodump -ErrorAction SilentlyContinue
if (-not $mongodump) {
  throw "mongodump was not found. Install MongoDB Database Tools and retry."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$databaseName = "roulette-platform"
if ($env:MONGODB_DATABASE) { $databaseName = $env:MONGODB_DATABASE }

$targetDir = Resolve-Path -Path (New-Item -ItemType Directory -Force -Path $OutputDir)
$archive = Join-Path $targetDir "roulette-$databaseName-$timestamp.archive.gz"
$checksum = "$archive.sha256"

& mongodump --uri=$env:MONGODB_URI --db=$databaseName --gzip --archive=$archive
if ($LASTEXITCODE -ne 0) {
  throw "mongodump failed with exit code $LASTEXITCODE"
}

$hash = Get-FileHash -Algorithm SHA256 -Path $archive
"$($hash.Hash)  $(Split-Path $archive -Leaf)" | Set-Content -Path $checksum -Encoding ascii

Write-Output "Backup created: $archive"
Write-Output "SHA256: $($hash.Hash)"
Write-Output "Store the archive and checksum in encrypted storage. Do not commit them to Git."
