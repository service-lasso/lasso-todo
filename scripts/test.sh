#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --test tests/todo-service.test.mjs
