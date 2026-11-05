#!/usr/bin/env bash
# Copia de seguridad lógica (formato custom, comprimido). Uso: DATABASE_URL=... backup.sh [destino]
set -euo pipefail
OUT="${1:-backups/aquisito-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$OUT")"
pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "${DATABASE_URL:?DATABASE_URL requerido}"
sha256sum "$OUT" > "$OUT.sha256"
echo "Respaldo: $OUT"
