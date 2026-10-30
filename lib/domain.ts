import {z} from 'zod';
export type Market='ozon'|'wb';
export type Mode='demo'|'live';
export type Stage='new'|'assembling'|'packed'|'shipped';
export const stageNames:Record<string,string>={new:'Новые',assembling:'На сборке',packed:'Готовы к отгрузке',shipped:'Переданы'};
export const itemSchema=z.object({sku:z.string().min(1).max(100),name:z.string().min(1).max(200),quantity:z.number().int().min(1).max(9999),price:z.number().min(0).max(1e9).default(0),barcode:z.string().regex(/^[\x20-\x7E]{0,48}$/,'Штрихкод: от 1 до 48 латинских символов').optional().default('')});
export const importOrderSchema=z.object({externalId:z.string().trim().min(1).max(100),market:z.enum(['ozon','wb']),scheme:z.enum(['FBS','FBO','FBW']),status:z.string().max(100).default('new'),created:z.string().datetime({offset:true}).optional(),deadline:z.string().datetime({offset:true}).nullable().optional(),warehouse:z.string().max(100).default('Основной склад'),items:z.array(itemSchema).min(1).max(100)}).superRefine((v,c)=>{if((v.market==='ozon'&&v.scheme==='FBW')||(v.market==='wb'&&v.scheme==='FBO'))c.addIssue({code:z.ZodIssueCode.custom,message:'Для Ozon используйте FBS/FBO, для Wildberries — FBS/FBW'});});
export type ImportOrder=z.infer<typeof importOrderSchema>;
export type Order=ImportOrder & {id:string,stage:Stage,mode:Mode,source:'demo'|'file'|'api',updated:string};
export type Event={id:number,mode:Mode,action:string,detail:string,created:string};
export function nextStage(o:Order,action:string):Stage {
 if(o.scheme!=='FBS')throw new Error('FBO/FBW обрабатывает маркетплейс. Локальная сборка недоступна.');
 if(['cancelled','canceled','delivered'].includes(o.status))throw new Error('Заказ завершён или отменён. Сборка недоступна.');
 const flow:Record<string,{from:Stage,to:Stage}>={assemble:{from:'new',to:'assembling'},pack:{from:'assembling',to:'packed'},ship:{from:'packed',to:'shipped'}};
 const transition=flow[action];
 if(!transition||transition.from!==o.stage)throw new Error('Недопустимый переход. Обновите список заказов.');
 if(action==='ship'&&o.mode!=='demo')throw new Error('Внешняя отгрузка в v1 выполняется в кабинете маркетплейса. Здесь доступна подготовка.');
 return transition.to;
}
export const money=(v:number)=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0}).format(v);
export const orderTotal=(o:ImportOrder)=>o.items.reduce((a,i)=>a+i.price*i.quantity,0);
export function demoOrders():ImportOrder[]{
 const names=[['ST-101','Стол журнальный «Лофт»',6490,'chair'],['ST-202','Стол приставной, дуб натуральный',4290,'table'],['PL-301','Полка настенная, 60 см',1890,'shelf'],['TM-401','Тумба прикроватная «Норд»',5790,'box'],['ST-105','Стол обеденный «Осло»',12990,'table'],['PL-302','Полка угловая, белая',2190,'shelf']];
 const now=Date.now();
 return Array.from({length:16},(_,i)=>{const p=names[i%6];const market:Market=i%3===1?'wb':'ozon';const scheme=i%5===4?(market==='ozon'?'FBO':'FBW'):'FBS';return {externalId:market==='ozon'?`032849${String(i+1).padStart(2,'0')}-0042-1`:`483920${String(i+1).padStart(3,'0')}`,market,scheme,status:scheme==='FBS'?'awaiting_packaging':i%2===0?'delivering':'delivered',created:new Date(now-(i+2)*3600000).toISOString(),deadline:scheme==='FBS'?new Date(now+(i===0?-2:i+2)*3600000).toISOString():null,warehouse:scheme==='FBS'?'Мой склад · Москва':market==='ozon'?'Ozon · Хоругвино':'WB · Коледино',items:[{sku:String(p[0]),name:String(p[1]),quantity:i%7===0?2:1,price:Number(p[2]),barcode:`DEMO-${String(10000+i)}`},...(i===2?[{sku:'PL-302',name:'Полка угловая, белая',quantity:1,price:2190,barcode:'DEMO-20002'}]:[])]};});
}
// RFC 4180-style CSV parser; accepts semicolon or comma, BOM, quoted cells and line breaks.
export function parseCSV(text:string):ImportOrder[]{
 const first=text.replace(/^\uFEFF/,'').split(/\r?\n/)[0]; const delimiter=first.includes(';')?';':',';
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
 if(quoted)throw new Error('Незакрытая кавычка в CSV');
 row.push(cell.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);
 if(rows.length<2)throw new Error('В CSV нет строк с заказами');
 const headers=rows.shift()!.map(x=>x.replace(/^\uFEFF/,'').trim());
 const required=['externalId','market','scheme','sku','name','quantity','price'];
 if(required.some(x=>!headers.includes(x)))throw new Error('Нужны колонки: '+required.join(', '));
 const grouped=new Map<string,any>();
 for(const [index,cols] of rows.entries()){
 if(cols.length!==headers.length)throw new Error(`Строка ${index+2}: число колонок не совпадает с заголовком`);
 const v=Object.fromEntries(headers.map((h,j)=>[h,cols[j].trim()]));const key=[v.market,v.scheme,v.externalId].join('|');
 const base={externalId:v.externalId,market:v.market,scheme:v.scheme,status:v.status||'new',warehouse:v.warehouse||'Основной склад',deadline:v.deadline||null,items:[]};
 const o=grouped.get(key)||base;
 if(o.scheme!==v.scheme)throw new Error('Несовпадение схемы');
 o.items.push({sku:v.sku,name:v.name,quantity:Number(v.quantity),price:Number(v.price.replace(',','.')),barcode:v.barcode||''});grouped.set(key,o);
 }
 return z.array(importOrderSchema).min(1).max(500).parse([...grouped.values()]);
}
export function parseImport(text:string,filename:string):ImportOrder[]{
 if(text.length>2_000_000)throw new Error('Файл больше 2 МБ');
 if(filename.toLowerCase().endsWith('.csv'))return parseCSV(text);
 const value=JSON.parse(text.replace(/^\uFEFF/,''));
 return z.array(importOrderSchema).min(1).max(500).parse(Array.isArray(value)?value:value.orders);
}
