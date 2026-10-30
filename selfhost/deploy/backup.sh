#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
(( EUID == 0 )) || { echo 'Запустите от root' >&2; exit 1; }
backup_dir=/var/backups/marketflow
install -d -m 700 "$backup_dir"
backup_target="$backup_dir/marketflow-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
backup_temp="$(mktemp -d /var/tmp/marketflow-backup.XXXXXXXX)"
trap 'rm -rf -- "$backup_temp"' EXIT
python3 - "$backup_temp/orders.sqlite3" <<'PY'
import sqlite3,sys
with sqlite3.connect('file:/var/lib/marketflow/orders.sqlite3?mode=ro',uri=True) as source:
    with sqlite3.connect(sys.argv[1]) as target:
        source.backup(target)
PY
install -m 600 /var/lib/marketflow/config.json "$backup_temp/config.json"
tar -czf "$backup_target" -C "$backup_temp" config.json orders.sqlite3
chmod 600 "$backup_target"
printf 'Резервная копия: %s\n' "$backup_target"
echo 'Копия содержит зашифрованные ключи и ключ расшифровки. Храните её как секрет.'
