#!/usr/bin/env bash
# Restaura un respaldo en una base NUEVA (nunca sobre producción en caliente). Uso: TARGET_URL=... restore.sh archivo.dump
set -euo pipefail
FILE="${1:?archivo .dump requerido}"
sha256sum -c "$FILE.sha256"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="${TARGET_URL:?TARGET_URL requerido}" "$FILE"
echo "Restaurado en $TARGET_URL"
