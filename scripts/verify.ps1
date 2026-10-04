$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'verify-service.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
