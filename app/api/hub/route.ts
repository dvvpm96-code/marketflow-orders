import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {demoOrders,importOrderSchema,nextStage,type Order,type Mode,type Market} from '@/lib/domain';
import {encrypt,decrypt} from '@/lib/crypto';
import {fetchOrders,api,type Keys} from '@/lib/marketplaces';
export const dynamic='force-dynamic';
const now=()=>new Date().toISOString();
function db(){if(!env.DB)throw new Error('База данных временно недоступна');return env.DB;}
function user(req:Request){const id=req.headers.get('oai-authenticated-user-id');if(id)return id;if(import.meta.env.DEV)return 'local-preview';throw new Error('AUTH');}
function response(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function fail(error:unknown){if(error instanceof Error&&error.message==='AUTH')return response({error:'Войдите через ChatGPT'},401);if(error instanceof z.ZodError)return response({error:error.issues.slice(0,3).map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')},400);return response({error:error instanceof Error?error.message:'Не удалось выполнить операцию'},400);}
function originCheck(req:Request){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)throw new Error('Недопустимый источник запроса');if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Error('Ожидается JSON');}
function log(owner:string,mode:Mode,action:string,detail:string){return db().prepare('INSERT INTO events (owner,mode,action,detail,created) VALUES (?,?,?,?,?)').bind(owner,mode,action,detail,now());}
function rowOrder(r:any):Order {return {...JSON.parse(r.payload),id:r.id,stage:r.stage,mode:r.mode,updated:r.updated};}
async function state(owner:string){
 const [rows,eventRows,keys]=await Promise.all([db().prepare('SELECT * FROM orders WHERE owner=? ORDER BY updated DESC LIMIT 2000').bind(owner).all(),db().prepare('SELECT id,mode,action,detail,created FROM events WHERE owner=? ORDER BY id DESC LIMIT 200').bind(owner).all(),db().prepare('SELECT market,updated FROM credentials WHERE owner=?').bind(owner).all()]);
 return {orders:rows.results.map(rowOrder),events:eventRows.results,connections:keys.results,secureStorage:!!env.CREDENTIALS_MASTER_KEY,version:'1.0'};
}
async function put(owner:string,mode:Mode,source:'demo'|'file'|'api',input:unknown,seed=false){
 const list=z.array(importOrderSchema).min(1).max(1000).parse(input);const unique=new Map(list.map(o=>[[o.market,o.scheme,o.externalId].join('|'),o]));
 const statements=[...unique.values()].map((o,index)=>{const id=[owner,mode,o.market,o.scheme,o.externalId].join(':');const payload=JSON.stringify({...o,source});return db().prepare(seed?'INSERT OR IGNORE INTO orders (id,owner,mode,market,scheme,external_id,stage,payload,updated) VALUES (?,?,?,?,?,?,?,?,?)':'INSERT INTO orders (id,owner,mode,market,scheme,external_id,stage,payload,updated) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated').bind(id,owner,mode,o.market,o.scheme,o.externalId,seed&&o.scheme==='FBS'?([1,5].includes(index)?'assembling':[3,7].includes(index)?'packed':'new'):'new',payload,now());});
 if(statements.length)await db().batch([...statements,log(owner,mode,source==='demo'?'Демо-данные':source==='file'?'Импорт файла':'Синхронизация',`${unique.size} заказов. Повторные номера обновляются без дубликатов.`)]);
 return unique.size;
}
async function getKeys(owner:string,market:Market):Promise<Keys>{const id=owner+':'+market;const row=await db().prepare('SELECT encrypted FROM credentials WHERE id=? AND owner=?').bind(id,owner).first<{encrypted:string}>();if(!row)throw new Error('Сначала подключите магазин в настройках');return decrypt(row.encrypted,env.CREDENTIALS_MASTER_KEY||'',id);}
export async function GET(req:Request){try{return response(await state(user(req)));}catch(e){return fail(e);}}
export async function POST(req:Request){try{
 const owner=user(req);originCheck(req);const raw=await req.text();if(raw.length>2_100_000)throw new Error('Запрос больше 2 МБ');const b=JSON.parse(raw);const mode:Mode=z.enum(['demo','live']).default('demo').parse(b.mode);
 if(b.action==='seed'){await put(owner,'demo','demo',demoOrders(),true);}
 else if(b.action==='import'){await put(owner,mode,'file',z.array(importOrderSchema).min(1).max(500).parse(b.orders));}
 else if(b.action==='transition'){
  const ids=z.array(z.string().max(500)).min(1).max(100).parse(b.ids);if(new Set(ids).size!==ids.length)throw new Error('Повторный заказ в операции');
  const rows=await db().prepare(`SELECT * FROM orders WHERE owner=? AND mode=? AND id IN (${ids.map(()=>'?').join(',')})`).bind(owner,mode,...ids).all();if(rows.results.length!==ids.length)throw new Error('Заказ не найден');
  const values=rows.results.map(row=>{const o=rowOrder(row);return {o,next:nextStage(o,b.operation)};});
  // Every order is validated before the atomic write. Stage guards protect repeated clicks.
  const updates=values.map(({o,next})=>db().prepare('UPDATE orders SET stage=?,updated=? WHERE id=? AND owner=? AND stage=?').bind(next,now(),o.id,owner,o.stage));
  await db().batch([...updates,log(owner,mode,({assemble:'Начата сборка',pack:'Сборка завершена',ship:'Отгрузка (демо)'} as any)[b.operation],`${ids.length} заказ(ов). ${mode==='live'?'Локальный этап; статус маркетплейса не изменён.':'Демонстрация.'}`)]);
 }
 else if(b.action==='credentials'){
  const v=z.object({market:z.enum(['ozon','wb']),clientId:z.string().max(100).optional(),apiKey:z.string().min(10).max(5000)}).parse(b);
  if(v.market==='ozon'&&!/^\d+$/.test(v.clientId||''))throw new Error('Client ID Ozon должен содержать цифры');
  const id=owner+':'+v.market;const encrypted=await encrypt({clientId:v.clientId,apiKey:v.apiKey},env.CREDENTIALS_MASTER_KEY||'',id);
  await db().batch([db().prepare('INSERT INTO credentials (id,owner,market,encrypted,updated) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted,updated=excluded.updated').bind(id,owner,v.market,encrypted,now()),log(owner,'live','Подключение',`${v.market==='ozon'?'Ozon':'Wildberries'}: ключ сохранён в защищённом хранилище. Запросов к API не было.`)]);
 }
 else if(b.action==='disconnect'){
  const market=z.enum(['ozon','wb']).parse(b.market);await db().batch([db().prepare('DELETE FROM credentials WHERE owner=? AND market=?').bind(owner,market),log(owner,'live','Отключение',market==='ozon'?'Ozon':'Wildberries')]);
 }
 else if(b.action==='sync'){
  if(b.confirmed!==true)throw new Error('Подтвердите обращение к внешнему API');const market=z.enum(['ozon','wb']).parse(b.market),scheme=z.enum(['FBS','FBO','FBW']).parse(b.scheme);
  if((market==='ozon'&&scheme==='FBW')||(market==='wb'&&scheme==='FBO'))throw new Error('Неподдерживаемая схема');
  const result=await fetchOrders(market,scheme,await getKeys(owner,market));if(result.orders.length)await put(owner,'live','api',result.orders);else await log(owner,'live','Синхронизация','Новых заказов не найдено').run();
  return response({...await state(owner),notice:`Получено ${result.orders.length}. ${result.note}${result.truncated?' Достигнут лимит v1: данные загружены частично. Сузьте период через файловый импорт.':''}`});
 }
 else if(b.action==='official-label'){
  if(b.confirmed!==true)throw new Error('Подтвердите запрос этикетки у маркетплейса');const id=z.string().max(500).parse(b.id);const row=await db().prepare('SELECT * FROM orders WHERE id=? AND owner=? AND mode=?').bind(id,owner,'live').first();if(!row)throw new Error('Заказ не найден');const o=rowOrder(row);
  if(o.scheme!=='FBS'||o.source!=='api')throw new Error('Официальная этикетка доступна для FBS-заказа, загруженного через API');const keys=await getKeys(owner,o.market);
  if(o.market==='wb'){
   if(!/^\d+$/.test(o.externalId))throw new Error('Некорректный номер заказа WB');const d=await api('https://marketplace-api.wildberries.ru/api/v3/orders/stickers?type=png&width=58&height=40',keys,'wb',{orders:[Number(o.externalId)]});const label=d.stickers?.find((s:any)=>String(s.orderId)===o.externalId);if(!label?.file)throw new Error('Этикетка ещё не готова. Проверьте сборку в кабинете WB.');await log(owner,'live','Этикетка WB',o.externalId).run();return response({label:{data:`data:image/png;base64,${label.file}`,name:`wb-${o.externalId}.png`}});
  }
  const payload=JSON.parse(String(row.payload));let task=payload.labelTask;
  if(!task){const d=await api('https://api-seller.ozon.ru/v3/posting/fbs/package-label/create',keys,'ozon',{posting_number:[o.externalId]});task=d.result?.task_id||d.task_id||d.result?.tasks?.[0]?.task_id||d.tasks?.[0]?.task_id;if(!task)throw new Error('Ozon не вернул номер задания на этикетку');await db().prepare('UPDATE orders SET payload=? WHERE id=? AND owner=?').bind(JSON.stringify({...payload,labelTask:task}),o.id,owner).run();await log(owner,'live','Задание на этикетку Ozon',o.externalId).run();return response({pending:true,notice:'Ozon формирует этикетку. Нажмите «Получить» через несколько секунд.'});}
  const d=await api('https://api-seller.ozon.ru/v2/posting/fbs/package-label/get',keys,'ozon',{task_id:task});const value=d.result??d;const url=value.file_url||value.url;
  if(!url)return response({pending:true,notice:'Этикетка ещё формируется. Повторите запрос позже.'});
  const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('Некорректная ссылка на этикетку');return response({label:{url,name:`ozon-${o.externalId}.pdf`}});
 }
 else if(b.action==='print-log'){const count=z.number().int().min(1).max(500).parse(b.count);await log(owner,mode,'Подготовлены этикетки',`${count} шт. Формат: ${z.enum(['58x40','100x150','A4']).parse(b.format)}. Факт печати подтверждается в диалоге принтера.`).run();}
 else throw new Error('Неизвестная операция');
 return response(await state(owner));
 }catch(e){return fail(e);}}
