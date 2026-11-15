#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
project='/home/deploy/МП Выход'
source_dir='/home/deploy/проекты/МП Управляющий'
secret_dir='/home/deploy/.config/mp-manager'
state_dir='/home/deploy/.local/share/mp-manager'
admin_doc='/home/deploy/проекты/Документы/Доступы к проектам/АДМИНЫ/ДОСТУПЫ-АДМИНА.md'
ip='100.103.120.79'
origin='http://100.103.120.79:8777'
repo='https://github.com/dvvpm96-code/marketflow-orders.git'
fail(){ echo "ОШИБКА: $*" >&2; exit 1; }
[[ "$(id -un)" == deploy ]] || fail 'Запускайте под deploy, без sudo.'
[[ -f "$project/data/skus.json" ]] || fail 'Проект МП Выход не найден.'
for cmd in docker git python3 curl openssl; do command -v "$cmd" >/dev/null || fail "Нет программы $cmd"; done
docker info >/dev/null 2>&1 || fail 'Нет доступа к Docker.'
mkdir -p "$secret_dir" "$state_dir"
chmod 700 "$secret_dir" "$state_dir"
if [[ ! -s "$secret_dir/password" ]]; then
  openssl rand -hex 24 > "$secret_dir/password"
  chmod 600 "$secret_dir/password"
  echo 'Создан новый пароль входа; только в защищённом файле.'
fi
if [[ -r "$admin_doc" && ! -s "$secret_dir/ozon-api-key" ]]; then
  python3 - "$admin_doc" "$secret_dir/ozon-api-key" <<'PY'
import sys,re,os
from pathlib import Path
txt=Path(sys.argv[1]).read_text(encoding='utf-8')
section=re.search(r'(?ms)^## 8\. Ключи API Ozon(.*?)(?=^## |\Z)',txt)
if not section:
    print('Ключ Ozon не найден (раздел 8 отсутствует).')
    sys.exit()
rows=[s for s in section.group(1).splitlines() if 'MP-Upravlyayushchiy' in s and s.startswith('|')]
if len(rows)!=1:
    print('Ключ Ozon не найден однозначно.')
    sys.exit()
parts=rows[0].split('|')
key=parts[2].strip().strip(chr(96)).strip()
if not re.fullmatch(r'[A-Za-z0-9_-]{16,128}(?:-[A-Za-z0-9_-]{2,128})*',key):
    print('Неожиданный формат ключа; автоматический перенос пропущен.')
    sys.exit()
fd=os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f: f.write(key)
print('Ключ Ozon сохранён в закрытый файл, не отображается.')
PY
fi
if [[ ! -e "$source_dir" ]]; then
  git clone --quiet --depth 1 "$repo" "$source_dir"
else
  [[ -d "$source_dir/.git" ]] || fail 'Папка модуля занята другим проектом.'
  [[ "$(git -C "$source_dir" remote get-url origin)" == "$repo" ]] || fail 'Неизвестный Git-репозиторий.'
  [[ -z "$(git -C "$source_dir" status --porcelain)" ]] || fail 'Есть локальные изменения, обновление остановлено.'
  git -C "$source_dir" pull --ff-only --quiet
fi
[[ -f "$source_dir/manager/server.mjs" ]] || fail 'Нет кода менеджера в GitHub.'
if docker container inspect mp-manager >/dev/null 2>&1; then
  fail 'Контейнер mp-manager уже существует. Ничего не перезаписываю.'
fi
key_file=''
key_mount=()
if [[ -s "$secret_dir/ozon-api-key" ]]; then
  key_file='/run/secrets/ozon_key'
  key_mount=(-v "$secret_dir/ozon-api-key:/run/secrets/ozon_key:ro")
fi
docker run -d --name mp-manager --restart unless-stopped \
  --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 1 --pids-limit 100 \
  --user "$(id -u):$(id -g)" \
  -e MP_PROJECT_DIR='/srv/mp' \
  -e MP_PUBLIC_ORIGIN="$origin" \
  -e MP_PORT=8777 \
  -e MP_BIND_HOST="$ip" \
  -e MP_ADMIN_PASSWORD_FILE='/run/secrets/mp_password' \
  -e MP_APPROVALS_FILE='/srv/state/manager-approvals.json' \
  -e OZON_CLIENT_ID=6241845 \
  -e OZON_API_KEY_FILE="$key_file" \
  -v "$source_dir/manager:/app:ro" \
  -v "$project:/srv/mp:ro" \
  -v "$state_dir:/srv/state:rw" \
  -v "$secret_dir/password:/run/secrets/mp_password:ro" \
  "${key_mount[@]}" \
  -w /app node:24-alpine node server.mjs >/dev/null
for n in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 "$origin/healthz" >/dev/null; then break; fi
  sleep 1
done
curl -fsS --max-time 5 "$origin/healthz" >/dev/null || fail 'Сервис не отвечает; проверьте docker logs mp-manager.'
code="$(curl -s -o /dev/null -w '%{http_code}' "$origin/api/snapshot")"
[[ "$code" == 401 ]] || fail 'Незащищённый API: вместо 401 получен другой код.'
echo "Установлено: $origin"
echo 'Вход закрыт паролем, API без авторизации возвращает 401.'
python3 - "$origin" "$secret_dir/password" <<'PY'
import sys,json,urllib.request,urllib.parse,http.cookiejar,urllib.error
origin,password_path=sys.argv[1:]
with open(password_path,encoding='utf-8') as f:
    password=f.read().strip()
cookies=http.cookiejar.CookieJar()
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies),urllib.request.HTTPRedirectHandler())
try:
    data=urllib.parse.urlencode({'password':password}).encode('utf-8')
    req=urllib.request.Request(origin+'/login',data=data,headers={'Origin':origin,'Content-Type':'application/x-www-form-urlencoded'})
    opener.open(req,timeout=8).read()
    req=urllib.request.Request(origin+'/api/ozon/check',data=b'{"confirm":"read-only"}',headers={'Origin':origin,'Content-Type':'application/json'})
    response=opener.open(req,timeout=20)
    result=json.load(response)
    if result.get('ok'):
        print('OZON API: ПОДКЛЮЧЕНО; количество товаров первой страницы:',result.get('countOnPage'))
    else:
        print('OZON API: ответ с ошибкой:',str(result.get('message') or result.get('error'))[:160])
except urllib.error.HTTPError as e:
    print('OZON API: проверка не пройдена, HTTP',e.code)
except Exception as e:
    print('OZON API: проверка не пройдена:',type(e).__name__)
PY
