$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'package.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
