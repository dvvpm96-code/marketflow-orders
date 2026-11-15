const state={data:null,view:'overview',query:'',selected:null,ozonResult:null,busy:false};
const $=id=>document.getElementById(id);
function el(tag,cls,text){
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined&&text!==null)node.textContent=String(text);
  return node;
}
function add(parent,...nodes){for(const node of nodes)if(node)parent.append(node);return parent;}
function badge(label,status=''){return el('span','badge '+status,label);}
function fmt(num){return typeof num==='number'&&Number.isFinite(num)?new Intl.NumberFormat('ru-RU').format(num):'—';}
function rub(num){return typeof num==='number'&&Number.isFinite(num)?fmt(Math.round(num))+' ₽':'—';}
function note(text,cls=''){return el('div','notice '+cls,text);}
function title(text,desc){
  const box=el('div','section-heading'),info=el('div'),h=el('h2','',text),p=el('p','',desc);
  add(info,h,p);box.append(info);return box;
}
function panel(heading){
  const p=el('section','panel');
  if(heading)p.append(el('h3','',heading));
  return p;
}
function button(label,action,cls='secondary'){
  const b=el('button','button '+cls,label);
  b.type='button';b.addEventListener('click',action);return b;
}
function row(label,detail,right){
  const r=el('div','list-row'),left=el('div');
  left.append(el('strong','',label));
  if(detail)left.append(el('small','',detail));
  add(r,left,right||el('span','',''));return r;
}
function stat(label,value,footer){
  const p=el('div','stat');
  add(p,el('div','stat-label',label),el('div','stat-number',value),el('div','stat-foot',footer));
  return p;
}
function table(headers,bodyRows){
  const wrap=el('div','table-wrap'),t=el('table','data-table'),head=el('thead'),tr=el('tr');
  headers.forEach(x=>tr.append(el('th','',x)));head.append(tr);t.append(head);
  const body=el('tbody');bodyRows.forEach(row=>{const r=el('tr');row.forEach(cell=>{const c=el('td');if(cell instanceof Node)c.append(cell);else c.textContent=String(cell??'—');r.append(c);});body.append(r);});t.append(body);wrap.append(t);return wrap;
}
function statusClass(status){return status==='готово'?'ready':status==='уточнить'?'blocked':'danger';}
function productCell(item){
  const p=el('div','product-name');
  if(item.photo){const im=el('img');im.src=item.photo;im.alt='Фото '+item.name;im.loading='lazy';p.append(im);}
  const txt=el('div');add(txt,el('strong','',item.name),el('small','',item.id+' · '+item.category));p.append(txt);
  return p;
}
function toast(message){const t=$('toast');t.textContent=message;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),6000);}
async function request(url,body){
  const opts=body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
  const response=await fetch(url,opts);
  if(response.status===401){window.location.assign('/login');throw new Error('Требуется вход');}
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'Ошибка сервера');
  return result;
}
async function refresh(){
  try{state.data=await request('/api/snapshot');render();}
  catch(e){const m=$('main');m.replaceChildren(note('Не удалось прочитать данные: '+e.message));}
}
function overview(container){
  const d=state.data,st=d.stats;
  container.append(title('Сводка направления','Данные подготовлены для запуска, но это не фактические показатели продаж.'));
  if(d.skuDataStale)container.append(note('Снимок данных 1С старше 24 часов. Перед изменением цен или публикацией необходима актуальная сверка.'));
  if(d.missing.length)container.append(note('Часть файлов недоступна: '+d.missing.map(x=>x.file).join(', ')));
  const stats=el('div','stats');
  add(stats,stat('Вариантов 1С',fmt(st.skuVariants),'Из локального каталога'),stat('Черновиков сайта',fmt(st.siteCards),'Stolberi.ru'),stat('Фотографий',fmt(st.photos),'Исходные фотографии'),stat('Карточек по содержанию',fmt(st.contentReady),'Не означает готовность к продаже'));
  container.append(stats);
  const cols=el('div','panels-two'),left=panel('Что уже подготовлено'),right=panel('Что мешает выходу');
  const done=el('div','list');
  add(done,row('Каталог 1С','Артикулы, цены, себестоимость и остатки из сохранённого среза',badge(fmt(st.skuVariants),'ready')),row('Карточки Ozon и WB','Валидация текста и характеристик',badge(fmt(st.textValidated),'ready')),row('Фотографии','Для набора из 16 товаров',badge(fmt(st.photos),'ready')),row('Подключение Ozon','API-ключ используется только с сервера',badge(state.ozonResult?.ok?'Проверено':'Не проверено',state.ozonResult?.ok?'ready':'blocked')));
  left.append(done);
  const blocks=el('div','list');
  add(blocks,row('Сверка кодов 1С и сайта','У первых 3 товаров нет однозначной связи SKU',badge('Требуется','blocked')),row('Документы на мебель','Подтвердить декларацию и связанные реквизиты',badge('Не подтверждено','blocked')),row('Комиссии и логистика','Ориентиры от '+(d.tariffsDate||'неизвестно')+'; перепроверить в кабинетах',badge('Оценка','blocked')),row('Реклама и публикации','Доступ к операциям записи не активирован',badge('Отключено')));
  right.append(blocks);add(cols,left,right);container.append(cols);
  const next=panel('Первые позиции на проверку');
  const rows=d.cards.slice(0,5).map(c=>[productCell(c),rub(c.price),badge(c.readiness,statusClass(c.readiness)),button('Открыть',()=>{state.view='cards';state.selected=c.id;state.query='';render();})]);
  next.append(table(['Товар','Цена сайта','Содержание','Действие'],rows));container.append(next);
}
function products(container){
  const d=state.data;
  container.append(title('Товары 1С','Каталог из серверного снимка. Остатки и себестоимость могут измениться.'));
  container.append(note('Цены здесь НЕ означают рекомендованную цену продажи: это исходные данные 1С. Перед запуском обязательны актуальные комиссия, доставка, возвраты и налог.'));
  const input=el('input');input.placeholder='Поиск по модели, артикулу, варианту';input.value=state.query;
  const search=el('div','searchbar');add(search,input,button('Найти',()=>{state.query=input.value.trim();render();}));input.addEventListener('keydown',e=>{if(e.key==='Enter'){state.query=input.value.trim();render();}});container.append(search);
  const q=state.query.toLowerCase();
  const found=d.skus.filter(s=>(s.code+' '+s.name+' '+s.variant).toLowerCase().includes(q));
  const results=panel('Номенклатура · '+found.length+' позиций');
  results.append(table(['Артикул / товар','Вариант','Остаток (срез)','Себестоимость','Цена Ozon (срез)'],found.slice(0,100).map(s=>[
    add(el('div'),el('strong','',s.code),el('div','muted',s.name)),
    s.variant||'—',fmt(s.stock),rub(s.cost),rub(s.price)
  ])));
  if(found.length>100)results.append(el('p','muted','Показаны первые 100 записей. Уточните поиск.'));
  container.append(results);
}
function cards(container){
  const d=state.data;
  container.append(title('Карточки товаров','16 позиций с сайта Stolberi. Проверка черновика не публикует товар на Ozon или WB.'));
  container.append(note('Статус «готово» относится к тексту и фото. Без подтверждённых себестоимости, остатков, кодов 1С, упаковки и документов товар не публикуем.'));
  const input=el('input');input.placeholder='Поиск по модели / ID';input.value=state.query;
  const search=el('div','searchbar');add(search,input,button('Найти',()=>{state.query=input.value.trim();render();}));
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){state.query=input.value.trim();render();}});
  container.append(search);
  const found=d.cards.filter(c=>(c.id+' '+c.name).toLowerCase().includes(state.query.toLowerCase()));
  const p=panel('Список карточек · '+found.length);
  p.append(table(['Товар','Цена сайта','Фото','Состояние','Согласование','Просмотр'],found.map(c=>[
    productCell(c),rub(c.price),String(c.photos),badge(c.readiness,statusClass(c.readiness)),
    badge(d.approvals[c.id]?.decision==='reviewed'?'Черновик просмотрен':d.approvals[c.id]?.decision==='needs_work'?'На доработку':'Не рассмотрено',d.approvals[c.id]?.decision==='reviewed'?'ready':''),
    button('Открыть',()=>{state.selected=c.id;render();})
  ])));container.append(p);
  const current=d.cards.find(c=>c.id===state.selected);
  if(!current)return;
  const detail=panel('Черновик: '+current.id+' · '+current.name);
  detail.append(note('Соответствие реальному SKU 1С не подтверждено. Предложенные кандидаты — не установленная связь.'));
  const info=el('div','list');
  add(info,row('Фотографии',String(current.photos)+' шт.',badge(current.photos?'Есть':'Нет',current.photos?'ready':'danger')),row('Содержание',current.readiness,badge(current.readiness,statusClass(current.readiness))),row('Себестоимость / актуальный остаток','Не подтверждены для этой записи сайта',badge('Нет данных','danger')));
  if(current.candidates.length)info.append(row('Возможные коды из 1С',current.candidates.slice(0,5).map(x=>x.code+' · '+x.name).join('; '),badge('Не сопоставлены','blocked')));
  detail.append(info);
  if(current.problems.length){const problems=el('div','detail');add(problems,el('h4','', 'Противоречия и блокеры'),el('p','',current.problems.join('\n')));detail.append(problems);}
  for(const platform of ['ozon','wb']){
    const c=current.draft[platform],box=el('div','detail');
    add(box,el('h4','',platform==='ozon'?'Ozon · название и описание':'Wildberries · название и описание'),el('strong','',c.title||'Нет названия'),el('p','',c.description||'Нет описания'));
    detail.append(box);
  }
  if(current.gaps.length){const gaps=el('div','detail');add(gaps,el('h4','','Недостающие сведения'),el('p','',current.gaps.join('\n')));detail.append(gaps);}
  const actions=el('div','row-actions');
  add(actions,button('Согласовать текст (не публикация)',()=>approve(current.id,'reviewed')),button('На доработку',()=>approve(current.id,'needs_work')),button('Сбросить отметку',()=>approve(current.id,'reset')));
  detail.append(actions);container.append(detail);
}
async function approve(id,decision){
  try{const value=await request('/api/approvals',{id,decision});state.data.approvals=value.approvals;toast('Решение по черновику сохранено. Товар не опубликован.');render();}
  catch(e){toast('Не удалось сохранить: '+e.message);}
}
function finance(container){
  const d=state.data;
  container.append(title('Экономика и цены','Безопасный обзор. Никаких автоматических изменений цен.'));
  container.append(note('Фактические комиссии и удержания Ozon не подтверждены API. Поэтому здесь не показываем выдуманную чистую прибыль.'));
  const p=panel('Контроль экономики');
  add(p,row('Источник себестоимости','Срез данных 1С; для некоторых товаров сайта отсутствует соответствие',badge('Проверить','blocked')),row('Комиссии Ozon и WB','Тарифные ориентиры: '+(d.tariffsDate||'неизвестно'),badge('Не подтверждено','blocked')),row('Репрайсер','Отдельное приложение уже есть на сервере. Этот модуль не запускает автопилот.',badge('Не подключён')),row('Запрет убыточных цен','Любые изменения только после актуального расчёта и согласования',badge('Включён','ready')));
  container.append(p);
  container.append(el('div','callout','Порядок расчёта: цена продажи − себестоимость − комиссия − логистика − упаковка − реклама − налоги − возвраты = прибыль. Для достоверного результата нужны актуальные фактические тарифы и расходы.'));
}
function ads(container){
  container.append(title('Реклама Ozon / Wildberries','Мониторинг и рекомендации добавим после подключения рекламных API.'));
  container.append(note('Рекламные кампании пока не синхронизируются. Бюджеты не расходуются и ставки не меняются.'));
  const p=panel('Правила будущего рекламного агента');
  add(p,row('Лимит на день','Без согласованного бюджета = 0 ₽',badge('0 ₽','ready')),row('Контроль ДРР','Отдельно по SKU и кампании; без выдуманных цифр',badge('Ожидает данных')),row('Изменение ставок','Только с явным разрешением и в заданных границах',badge('Заблокировано')),row('Убыточные товары','Не запускать продвижение без подтверждения юнит-экономики',badge('Защищено','ready')));
  container.append(p);
}
function agents(container){
  container.append(title('Команда агентов','Ролевые инструкции существуют на сервере. Автоматическое выполнение заданий пока не запущено.'));
  const agents=[['Управляющий','Координация запуска, проверка блокеров и сводка владельцу'],['Ассортимент','Подбор позиций и проверка номенклатуры 1С'],['Карточки','Названия, SEO, характеристики Ozon и WB'],['Контент','Фотографии, инфографика и проверка качества'],['Цены','Юнит-экономика, безопасные цены и маржа'],['Аналитика','Продажи, ДРР, возвраты и отчёты'],['Поддержка','Черновики ответов на вопросы и отзывы']];
  const g=el('div','agents');
  agents.forEach(([name,desc])=>{const p=el('div','mini');add(p,el('div','agent-icon','✧'),el('h3','',name),el('p','',desc),el('p','muted','Правила описаны; не выполняется автономно'));g.append(p);});
  container.append(g);
}
function settings(container){
  const d=state.data;
  container.append(title('Подключения','Ключи остаются только на сервере и никогда не показываются в браузере.'));
  const p=panel('Ozon Seller API');
  add(p,row('Client ID','Настраивается через переменную среды, не из браузера',badge(d.ozon.clientIdConfigured?'Настроен':'Нет',''+(d.ozon.clientIdConfigured?'ready':'blocked'))),row('Файл секретного ключа','Серверный файл, доступ только процессу приложения',badge(d.ozon.keyFileConfigured?'Путь настроен':'Нет',d.ozon.keyFileConfigured?'ready':'blocked')),row('Действия на маркетплейсе','Только тест чтения /v3/product/list',badge('Read-only','ready')));
  p.append(el('p','muted','Проверка API не изменяет цены, карточки или рекламные кампании.'));
  p.append(button(state.busy?'Проверка…':'Проверить Ozon API (только чтение)',async()=>{
    if(state.busy)return;state.busy=true;render();
    try{state.ozonResult=await request('/api/ozon/check',{confirm:'read-only'});toast(state.ozonResult.ok?'Ozon ответил: '+state.ozonResult.countOnPage+' товаров на странице':'Ozon: '+state.ozonResult.message);}
    catch(e){state.ozonResult={ok:false,message:e.message};toast('Проверка не удалась: '+e.message);}
    finally{state.busy=false;render();}
  },''));
  if(state.ozonResult){const result=el('div','detail');result.append(el('h4','',state.ozonResult.ok?'API ответил успешно':'Ошибка проверки'));result.append(el('p','',state.ozonResult.ok?('Получено '+state.ozonResult.countOnPage+' записей в первой странице; общее количество: '+fmt(state.ozonResult.totalItems)+'.'):state.ozonResult.message));p.append(result);}
  container.append(p);
  const wb=panel('Wildberries');wb.append(row('WB Seller API','Пока не подключено',badge('Ожидает подключения')));container.append(wb);
  container.append(el('div','callout','Для сервера нужны: MP_ADMIN_PASSWORD_FILE, MP_PUBLIC_ORIGIN, OZON_CLIENT_ID, OZON_API_KEY_FILE. Сами ключи не копируются в репозиторий.'));
}
function render(){
  const v=state.view,m=$('main');
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('nav-active',b.dataset.view===v));
  const names={overview:'Обзор',products:'Товары 1С',cards:'Карточки товаров',finance:'Экономика',ads:'Реклама',agents:'ИИ-агенты',settings:'Подключения'};
  $('view-title').textContent=names[v]||'Обзор';
  m.replaceChildren();
  if(!state.data){m.append(el('p','loading','Читаю данные…'));return;}
  const views={overview,products,cards,finance,ads,agents,settings};
  (views[v]||overview)(m);
}
document.querySelectorAll('#nav button').forEach(b=>b.addEventListener('click',()=>{state.view=b.dataset.view;state.query='';state.selected=null;render();}));
$('refresh').addEventListener('click',refresh);
refresh();