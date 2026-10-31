#!/usr/bin/env bash
# GitHub runner only. Credentials arrive through environment; the app password
# is sent to the remote installer through SSH stdin, never as an argument.
set +x
set -Eeuo pipefail
umask 077
die() { printf '%s\n' "$1" >&2; exit 1; }
for name in SERVER_HOST SERVER_KNOWN_HOSTS CABINET_PASSWORD SITE_DOMAIN CABINET_USERNAME; do
  [[ -n "${!name:-}" ]] || die "Не задан $name. Добавьте настройку в GitHub, не в исходный код."
done
[[ "$SERVER_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && "$SERVER_HOST" != *'..'* ]] || die 'Некорректный SERVER_HOST: нужен IP или hostname без URL.'
SERVER_PORT="${SERVER_PORT:-22}"
[[ "$SERVER_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$SERVER_PORT >= 1 && 10#$SERVER_PORT <= 65535 )) || die 'Некорректный SERVER_PORT.'
SERVER_PORT="$((10#$SERVER_PORT))"
[[ "$SITE_DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$ && "$SITE_DOMAIN" != *'..'* ]] || die 'Нужен свой домен без https://, пути и номера порта.'
[[ "$CABINET_USERNAME" =~ ^[a-zA-Z0-9._-]{1,64}$ ]] || die 'Некорректный логин кабинета.'
[[ ${#CABINET_PASSWORD} -ge 12 && ${#CABINET_PASSWORD} -le 1024 && "$CABINET_PASSWORD" != *$'\n'* && "$CABINET_PASSWORD" != *$'\r'* ]] || die 'CABINET_PASSWORD: одна строка, 12–1024 символа.'
if [[ -n "${SERVER_SSH_KEY:-}" && -n "${SERVER_PASSWORD:-}" ]]; then die 'Задайте только один способ SSH: SERVER_SSH_KEY или SERVER_PASSWORD.'; fi
[[ -n "${SERVER_SSH_KEY:-}${SERVER_PASSWORD:-}" ]] || die 'Не задан SERVER_SSH_KEY или SERVER_PASSWORD.'
local_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/marketflow-deploy.XXXXXXXX")"
remote_dir=''
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$remote_dir" =~ ^/var/tmp/marketflow-github\.[a-zA-Z0-9]{8}$ ]]; then
    "${ssh_command[@]}" "${ssh_options[@]}" "root@$SERVER_HOST" "rm -rf -- $remote_dir" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$local_dir"
  unset CABINET_PASSWORD SERVER_SSH_KEY SERVER_PASSWORD SSHPASS
  exit "$result"
}
trap cleanup EXIT
printf '%s\n' "$SERVER_KNOWN_HOSTS" > "$local_dir/known_hosts"
lookup="$SERVER_HOST"
if [[ "$SERVER_PORT" != 22 ]]; then lookup="[$SERVER_HOST]:$SERVER_PORT"; fi
ssh-keygen -F "$lookup" -f "$local_dir/known_hosts" >/dev/null || die 'SERVER_KNOWN_HOSTS не содержит ключ для указанного хоста/порта.'
ssh_options=(-T -o "Port=$SERVER_PORT" -o ConnectTimeout=15 -o ConnectionAttempts=1 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$local_dir/known_hosts" -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR)
ssh_command=(ssh)
scp_command=(scp)
if [[ -n "${SERVER_SSH_KEY:-}" ]]; then
  printf '%s\n' "$SERVER_SSH_KEY" > "$local_dir/deploy_key"
  ssh_options+=(-o BatchMode=yes -o IdentitiesOnly=yes -i "$local_dir/deploy_key")
else
  export SSHPASS="$SERVER_PASSWORD"
  ssh_command=(sshpass -e ssh)
  scp_command=(sshpass -e scp)
  ssh_options+=(-o BatchMode=no -o PreferredAuthentications=password,keyboard-interactive -o NumberOfPasswordPrompts=1)
fi
# OpenSSH scp uses -T for a different purpose. Omit SSH's no-PTY switch there.
scp_options=("${ssh_options[@]:1}")
if [[ "${1:-}" == --check ]]; then
  echo 'Настройки GitHub заполнены; соединение с сервером не выполнялось.'
  exit 0
fi
archive="${1:?Укажите собранный marketflow-ubuntu.tar.gz}"
[[ -s "$archive" ]] || die 'Архив приложения не найден.'
if [[ -n "${SERVER_PASSWORD:-}" ]]; then command -v sshpass >/dev/null || die 'Нужен sshpass на runner.'; fi
remote_dir="$("${ssh_command[@]}" "${ssh_options[@]}" "root@$SERVER_HOST" 'umask 077 && mktemp -d /var/tmp/marketflow-github.XXXXXXXX')"
[[ "$remote_dir" =~ ^/var/tmp/marketflow-github\.[a-zA-Z0-9]{8}$ ]] || die 'Сервер не вернул безопасный путь установки.'
"${scp_command[@]}" "${scp_options[@]}" "$archive" "root@$SERVER_HOST:$remote_dir/package.tar.gz"
# Domain, username and stage path were strictly validated before constructing
# this remote shell command. No credential is embedded in the command.
printf '%s\n' "$CABINET_PASSWORD" | "${ssh_command[@]}" "${ssh_options[@]}" "root@$SERVER_HOST" "tar -xzf $remote_dir/package.tar.gz -C $remote_dir && exec bash $remote_dir/install.sh --password-stdin --install-dependencies --domain $SITE_DOMAIN --username $CABINET_USERNAME"
unset CABINET_PASSWORD
site_url="https://$SITE_DOMAIN"
echo 'Установщик завершён. Проверка HTTPS и защиты кабинета…'
curl --fail --silent --show-error --connect-timeout 10 --max-time 15 --retry 12 --retry-all-errors --retry-delay 5 "$site_url/healthz" >/dev/null
login_status="$(curl --silent --show-error --connect-timeout 10 --max-time 15 -o /dev/null -w '%{http_code}' "$site_url/login")"
api_status="$(curl --silent --show-error --connect-timeout 10 --max-time 15 -o /dev/null -w '%{http_code}' "$site_url/api/hub")"
[[ "$login_status" == 200 && "$api_status" == 401 ]] || die 'Не пройдена проверка входа/закрытого API. Не переустанавливайте: проверьте DNS и reverse proxy.'
printf 'Кабинет доступен: %s\nЛогин: %s\n' "$site_url" "$CABINET_USERNAME"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'site_url=%s\n' "$site_url" >> "$GITHUB_OUTPUT"; fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '## Поток установлен\n\n[Открыть кабинет](%s)\n\nЛогин: `%s`. Пароль — значение секрета `CABINET_PASSWORD`. Вход через ChatGPT не требуется.\n\nHTTPS отвечает; API без сессии закрыт (401). Данные Sites автоматически не перенесены.\n' "$site_url" "$CABINET_USERNAME" >> "$GITHUB_STEP_SUMMARY"
fi
