#!/bin/zsh
set -e
cd "${0:A:h}"
if [ ! -f dist/index.html ]; then npm run build; fi
node scripts/control.mjs start --open
python3 scripts/model.py start
