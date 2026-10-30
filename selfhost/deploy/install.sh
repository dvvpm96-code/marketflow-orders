#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
domain=''
username='dmitry'
dry_run=0
while (( $# )); do
  case "$1" in
    --domain) domain="${2:?Укажите домен}"; shift 2 ;;
    --username) username="${2:?Укажите логин}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 1 ;;
  esac
done
[[ "$username" =~ ^[a-zA-Z0-9._-]{1,64}$ ]] || { echo 'Недопустимый логин' >&2; exit 1; }
if [[ -n "$domain" ]]; then
  [[ "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$ ]] || { echo 'Нужен домен, например orders.example.ru (не IP и не URL)' >&2; exit 1; }
  [[ "$domain" != *'..'* ]] || { echo 'Недопустимый домен' >&2; exit 1; }
fi
[[ -f "$source_dir/server/server.mjs" && -f "$source_dir/client/index.html" ]] || { echo 'Не найден полный установочный пакет' >&2; exit 1; }
if (( dry_run )); then
  echo "Проверка пакета: OK. Логин: $username."
  echo "Установка: /opt/marketflow; данные: /var/lib/marketflow; сервис: marketflow.service."
  if [[ -n "$domain" ]]; then echo "Режим: HTTPS на домене $domain, через Caddy."; else echo 'Режим: только 127.0.0.1:3000, вход через SSH-туннель localhost:8080.'; fi
  echo 'Dry-run: сервер не изменён.'
  exit 0
fi
(( EUID == 0 )) || { echo 'Запустите через sudo или от root' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'Требуется Ubuntu с systemd' >&2; exit 1; }
[[ ! -e /opt/marketflow && ! -e /var/lib/marketflow ]] || { echo 'Установка уже существует. Данные не перезаписаны.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Нужен python3: apt-get install python3' >&2; exit 1; }
command -v curl >/dev/null || { echo 'Нужен curl: apt-get install curl ca-certificates' >&2; exit 1; }
command -v xz >/dev/null || { echo 'Нужен xz: apt-get install xz-utils' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'Нужен sha256sum' >&2; exit 1; }
if ss -H -ltn 'sport = :3000' | read -r _; then echo 'Порт 3000 уже занят. Существующий сервис не изменён.' >&2; exit 1; fi
if [[ -n "$domain" ]]; then
  if command -v caddy >/dev/null || [[ -e /etc/caddy/Caddyfile ]]; then echo 'Caddy уже установлен. Для сохранения текущих сайтов остановлено; настройте отдельный reverse proxy по README.' >&2; exit 1; fi
  if ss -H -ltn '( sport = :80 or sport = :443 )' | read -r _; then echo '80/443 уже заняты. Для сохранения текущих сайтов остановлено; настройте существующий reverse proxy по README.' >&2; exit 1; fi
fi
case "$(uname -m)" in x86_64) node_arch=x64; node_sha256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 ;; aarch64|arm64) node_arch=arm64; node_sha256=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8 ;; *) echo 'Поддерживаются amd64 и arm64' >&2; exit 1 ;; esac
printf 'Создайте пароль для входа в Поток (не менее 12 символов): ' >/dev/tty
IFS= read -r -s marketflow_password </dev/tty
printf '\nПовторите пароль: ' >/dev/tty
IFS= read -r -s marketflow_repeat </dev/tty
printf '\n' >/dev/tty
[[ "$marketflow_password" == "$marketflow_repeat" && ${#marketflow_password} -ge 12 ]] || { unset marketflow_password marketflow_repeat; echo 'Пароли не совпадают или слишком короткие' >&2; exit 1; }
tmp_dir="$(mktemp -d /var/tmp/marketflow-install.XXXXXXXX)"
trap 'rm -rf -- "$tmp_dir"; unset marketflow_password marketflow_repeat' EXIT
node_version='24.22.2'
node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 "https://nodejs.org/dist/v${node_version}/${node_archive}" -o "$tmp_dir/$node_archive"
printf '%s  %s\n' "$node_sha256" "$node_archive" > "$tmp_dir/selected.sha256"
(cd "$tmp_dir" && sha256sum --check selected.sha256)
install -d -m 755 /opt/marketflow
install -d -m 755 /opt/marketflow/runtime
if ! id marketflow >/dev/null 2>&1; then useradd --system --home-dir /var/lib/marketflow --shell /usr/sbin/nologin marketflow; fi
install -d -m 700 -o marketflow -g marketflow /var/lib/marketflow
install -d -m 755 /opt/marketflow/app
cp -a "$source_dir/client" "$source_dir/server" "$source_dir/node_modules" "$source_dir/migrations" "$source_dir/package.json" /opt/marketflow/app/
chown -R root:root /opt/marketflow/app
chmod -R a+rX /opt/marketflow/app
tar -xJf "$tmp_dir/$node_archive" --strip-components=1 -C /opt/marketflow/runtime
origin='http://localhost:8080'
if [[ -n "$domain" ]]; then origin="https://$domain"; fi
printf '%s' "$marketflow_password" | /opt/marketflow/runtime/bin/node /opt/marketflow/app/server/admin.mjs init /var/lib/marketflow/config.json "$origin" "$username"
unset marketflow_password marketflow_repeat
chown marketflow:marketflow /var/lib/marketflow/config.json
install -m 644 "$source_dir/marketflow.service" /etc/systemd/system/marketflow.service
systemctl daemon-reload
systemctl enable --now marketflow.service
sleep 2
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/healthz >/dev/null
if [[ -n "$domain" ]]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
  cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-marketflow
  printf '%s {\n encode zstd gzip\n reverse_proxy 127.0.0.1:3000\n}\n' "$domain" > /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile
  systemctl enable --now caddy
  systemctl reload caddy
  echo "Приложение запущено. Адрес: https://$domain . Логин: $username ."
  echo 'HTTPS заработает, когда DNS домена указывает на этот сервер и доступны порты 80/443.'
else
  echo "Приложение запущено приватно. Логин: $username ."
  echo 'На вашем компьютере: ssh -N -L 8080:127.0.0.1:3000 root@SERVER_IP'
  echo 'Затем откройте http://localhost:8080 . Не открывайте порт 3000 в интернет.'
fi
