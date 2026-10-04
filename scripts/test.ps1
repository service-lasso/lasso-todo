$ErrorActionPreference = 'Stop'
node --test tests/todo-service.test.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
