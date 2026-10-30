import type {ImportOrder,Market} from './domain';
export type Keys={clientId?:string,apiKey:string};
export async function api(url:string,keys:Keys,market:Market,body?:unknown){
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(market==='ozon'){headers['Client-Id']=keys.clientId||'';headers['Api-Key']=keys.apiKey;}else headers.Authorization=keys.apiKey;
 let r:Response;try{r=await fetch(url,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000),redirect:'error'});}catch{throw new Error('Маркетплейс не ответил. Повторите запрос позже.');}
 if(!r.ok){const hints:Record<number,string>={401:'Проверьте ключ API',403:'Недостаточно прав у ключа API',429:'Достигнут лимит запросов. Повторите позже',400:'Проверьте параметры запроса и права API',404:'Метод API или отправление недоступны'};throw new Error(`API ${market==='ozon'?'Ozon':'Wildberries'}: HTTP ${r.status}. ${hints[r.status]||'Временная ошибка сервиса'}`);}
 const data=await r.json();return data as any;
}
export function normalizeOzon(x:any,scheme:'FBS'|'FBO'):ImportOrder{
 return {externalId:String(x.posting_number),market:'ozon',scheme,status:String(x.status||'unknown'),created:x.in_process_at||x.created_at||new Date().toISOString(),deadline:scheme==='FBS'?(x.shipment_date||null):null,warehouse:String(x.delivery_method?.warehouse||x.analytics_data?.warehouse_name||'Ozon'),items:(x.products||[]).map((p:any)=>({sku:String(p.offer_id||p.sku),name:String(p.name||p.offer_id||p.sku),quantity:Number(p.quantity),price:Number(p.price)||0,barcode:''}))};
}
export function normalizeWB(x:any,scheme:'FBS'|'FBW',status?:string):ImportOrder{
 return {externalId:String(scheme==='FBS'?x.id:x.srid||x.gNumber),market:'wb',scheme,status:status|| (x.isCancel?'cancelled':scheme==='FBS'?'new':'ordered'),created:x.createdAt||x.date||new Date().toISOString(),deadline:scheme==='FBS'?(x.sellerDate||null):null,warehouse:String(x.warehouseName||x.warehouseId||'Wildberries'),items:[{sku:String(x.article||x.supplierArticle||x.nmId||x.nmID),name:String(x.subject||x.article||x.supplierArticle||`Товар ${x.nmId||x.nmID}`),quantity:1,price:Number(scheme==='FBS'?((x.convertedPrice??x.price??0)/100):(x.finishedPrice??x.priceWithDisc??x.totalPrice??0)),barcode:String(x.barcode||x.skus?.[0]||'')}]};
}
export async function fetchOrders(market:Market,scheme:'FBS'|'FBO'|'FBW',keys:Keys){
 const to=new Date().toISOString(),since=new Date(Date.now()-7*86400000).toISOString();let orders:ImportOrder[]=[];let truncated=false;
 if(market==='ozon'){
  let cursor='';let offset=0;
  for(let page=0;page<10;page++){
   const d=await api(`https://api-seller.ozon.ru/${scheme==='FBS'?'v4/posting/fbs/list':'v3/posting/fbo/list'}`,keys,market,{filter:{since,to},limit:100,offset,cursor,dir:'ASC',sort_dir:'asc',with:{analytics_data:true,financial_data:false}});
   const root=d.result??d; const list=Array.isArray(root)?root:root.postings;
   if(!Array.isArray(list))throw new Error('Ответ Ozon изменился. Импорт остановлен без записи данных.');
   orders.push(...list.map(x=>normalizeOzon(x,scheme as 'FBS'|'FBO')));
   const next=root.cursor||root.next_cursor||'';const more=root.has_next??(list.length===100);
   if(!more||list.length===0)break;
   if(next&&next===cursor){truncated=true;break;}
   cursor=next;offset+=list.length;if(page===9)truncated=true;
  }
 }else if(scheme==='FBS'){
  const d=await api('https://marketplace-api.wildberries.ru/api/v3/orders/new',keys,market);
  if(!Array.isArray(d.orders))throw new Error('Некорректный ответ Wildberries');
  orders=d.orders.map((x:any)=>normalizeWB(x,'FBS'));
  // This read endpoint returns all NEW assembly orders. Completed orders stay in local history.
 }else{
  const d=await api(`https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${encodeURIComponent(since)}&flag=0`,keys,market);
  if(!Array.isArray(d))throw new Error('Некорректный отчёт Wildberries');
  orders=d.filter((x:any)=>x.warehouseType==='Склад WB'||x.warehouseType==='WB'||x.deliveryType==='FBW'||x.delivery_method==='FBW').map((x:any)=>normalizeWB(x,'FBW'));
  if(d.length>=80000)truncated=true;
 }
 // Hard cap is visible to the operator; never silently claim a full import.
 if(orders.length>1000){orders=orders.slice(0,1000);truncated=true;}
 return {orders,truncated,note:market==='wb'&&scheme==='FBS'?'Загружены новые сборочные задания FBS. Для полного архива используйте импорт файла.':market==='wb'?'Отчёт FBW за 7 дней; данные статистики могут поступать с задержкой.':'Период: последние 7 дней.'};
}
