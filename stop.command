#!/bin/zsh
set -e
cd "${0:A:h}"
node scripts/control.mjs stop
python3 scripts/model.py stop
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
if command -v docker >/dev/null; then
  docker compose -f napcat.compose.yml stop || print 'NapCat 未能停止，请在 Docker Desktop 中检查 niko-napcat。'
fi
