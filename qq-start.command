#!/bin/zsh
set -e
cd "${0:A:h}"
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
docker compose -f napcat.compose.yml up -d
./start.command
