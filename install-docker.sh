#!/usr/bin/env sh
set -eu
command -v docker >/dev/null 2>&1 || { echo "Docker est requis."; exit 1; }
[ -f .env.local ] || cp .env.example .env.local
docker compose up -d --build
echo "Sébastien BTP est lancé sur http://localhost:3000"
