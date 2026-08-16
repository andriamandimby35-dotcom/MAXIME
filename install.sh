#!/usr/bin/env sh
set -eu
[ -f .env.local ] || cp .env.example .env.local
node scripts/check-env.mjs || true
npm install
npm run verify:static
npm run build
printf '\nInstallation terminée. Lancez: npm start\n'
