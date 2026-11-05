#!/usr/bin/env bash
# Ensayo de restauración (criterio 29): respalda la base de pruebas sembrada con pedidos, la restaura
# en una base nueva y verifica que pedidos, movimientos e invariantes coincidan.
set -euo pipefail
SRC="${SRC_DB:-aquisito_test}"
DST="aquisito_restore_drill"
BASE="postgresql://${PGUSER:-postgres}:${PGPASSWORD:-postgres}@${PGHOST:-localhost}:5432"
DIR="$(mktemp -d)"
DATABASE_URL="$BASE/$SRC" bash "$(dirname "$0")/backup.sh" "$DIR/drill.dump" >/dev/null
psql "$BASE/postgres" -qc "DROP DATABASE IF EXISTS $DST" -c "CREATE DATABASE $DST"
psql "$BASE/$DST" -qc "CREATE EXTENSION IF NOT EXISTS postgis" 2>/dev/null || true
TARGET_URL="$BASE/$DST" bash "$(dirname "$0")/restore.sh" "$DIR/drill.dump" >/dev/null 2>&1 || TARGET_URL="$BASE/$DST" bash "$(dirname "$0")/restore.sh" "$DIR/drill.dump"
Q="SELECT (SELECT count(*) FROM orders)||'|'||(SELECT count(*) FROM ledger_entries)||'|'||(SELECT coalesce(sum(amount_cents),0) FROM ledger_entries)||'|'||(SELECT count(*) FROM inventory_movements)||'|'||(SELECT coalesce(sum(on_hand),0) FROM inventory)||'|'||(SELECT count(*) FROM settlement_items)"
A=$(psql "$BASE/$SRC" -Atc "$Q")
B=$(psql "$BASE/$DST" -Atc "$Q")
INV=$(psql "$BASE/$DST" -Atc "SELECT count(*) FROM orders WHERE total_cents <> subtotal_cents - discount_cents + delivery_fee_cents + service_fee_cents + surcharge_cents + tip_cents")
NEG=$(psql "$BASE/$DST" -Atc "SELECT count(*) FROM inventory WHERE reserved > on_hand OR on_hand < 0")
echo "origen   pedidos|movimientos|suma|mov_inventario|stock|items_liquidación = $A"
echo "restaurado                                                         = $B"
[ "$A" = "$B" ] && [ "$INV" = "0" ] && [ "$NEG" = "0" ] && echo "RESTAURACIÓN OK: datos e invariantes coherentes" || { echo "RESTAURACIÓN CON DIFERENCIAS"; exit 1; }
psql "$BASE/postgres" -qc "DROP DATABASE $DST"
