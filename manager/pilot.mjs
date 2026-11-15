import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';

export const PILOT_IDS = Object.freeze(['S01','S09','S12']);

async function json(root,filename,fallback,errors){
  try{return JSON.parse(await readFile(path.join(root,filename),'utf8'));}
  catch(e){
    errors.push(filename+': '+(e.code==='ENOENT'?'файл отсутствует':'невозможно прочитать'));
    return fallback;
  }
}
const trimmed=x=>typeof x==='string'?x.trim():'';
function positiveNumber(x){const n=Number(x);return Number.isFinite(n)&&n>0?n:null;}
function fileList(value,id,type){
  if(!Array.isArray(value))return [];
  // Do not serve or stat untrusted absolute / traversal paths from project JSON.
  const valid=new RegExp('^cards/'+type+'/'+id+'/[0-9]{2}\\.jpg$');
  return value.filter(x=>typeof x==='string'&&valid.test(x));
}
async function countFiles(root,items){
  const found=await Promise.all(items.map(async rel=>{
    try {const s=await stat(path.join(root,rel));return s.isFile()?1:0;}
    catch{return 0;}
  }));
  return found.reduce((sum,v)=>sum+v,0);
}
function warningsFor(id,source,draft) {
  const notes=[];
  const description=trimmed(source?.description);
  const props=source?.props||{};
  if(id==='S01'&&/массив дуба/i.test(String(props['Материал столешницы']||''))&&/инженерн/i.test(description))
    notes.push('Уточнить состав столешницы: в характеристиках «массив дуба», в описании «инженерный массив дуба и ольхи».');
  if(id==='S09'&&/бук/i.test(String(props['Обивка']||''))&&/велюр/i.test(trimmed(source?.name)))
    notes.push('Уточнить материал и цвет обивки: название сообщает бежевый велюр, поле «Обивка» содержит «светлый бук».');
  if(id==='S12'&&/гарантия:\s*2 года/i.test(description)&&/18 месяц/i.test(String(draft.guarantee||'')))
    notes.push('Проверить срок гарантии: в исходном тексте сайта 2 года, в черновике 18 месяцев.');
  return notes;
}

export async function buildOzonPilot(root, now=new Date()){
  const errors=[];
  const [facts,skuRows,matches,readiness,validation,tariffs]=await Promise.all([
    json(root,'data/site_cards_input.json',[],errors),
    json(root,'data/skus.json',[],errors),
    json(root,'data/site_matches.json',[],errors),
    json(root,'data/site_readiness.json',{},errors),
    json(root,'reports/validation.json',[],errors),
    json(root,'data/tariffs.json',{},errors)
  ]);
  const availableSkus=new Set((Array.isArray(skuRows)?skuRows:[]).map(row=>String(row.code||'')));
  const cards=[];
  for(const id of PILOT_IDS){
    const draft=await json(root,'cards/upload/'+id+'_ozon.json',{},errors);
    const fact=(Array.isArray(facts)?facts:[]).find(x=>x.id===id);
    const selection=(Array.isArray(matches)?matches:[]).find(x=>x.site?.url&&x.site.url===fact?.url);
    const textCheck=(Array.isArray(validation)?validation:[]).find(x=>x.id===id&&x.platform==='ozon');
    const photos=fileList(draft.photos,id,'photos');
    const infographics=fileList(draft.infographics,id,'infographics');
    const [photoCount,infographicCount]=await Promise.all([countFiles(root,photos),countFiles(root,infographics)]);
    const title=trimmed(draft.title);
    const description=trimmed(draft.description);
    const textReady=Boolean(title&&description&&textCheck&&Array.isArray(textCheck.errors)&&textCheck.errors.length===0&&readiness[id]?.status==='готово');
    const candidateCodes=(selection?.cands||[]).slice(0,6).map(c=>({
      code:String(c.code||''),
      name:String(c.name||''),
      inCurrentSnapshot:availableSkus.has(c.code),
      autoMatched:false
    }));
    const warnings=warningsFor(id,fact,draft);
    const blocks=[
      {id:'mapping',label:'Сопоставить с полным готовым изделием в 1С. Комплектующие не использовать как SKU продажи.'},
      {id:'cost',label:'Подтвердить себестоимость готового изделия и актуальные комиссии/логистику Ozon.'},
      {id:'stock',label:'Получить свежий остаток и подтвердить склад отгрузки.'},
      {id:'packaging',label:'Заполнить размеры и массу товара В УПАКОВКЕ (не путать с габаритами изделия).'},
      {id:'documents',label:'Проверить и привязать применимые документы соответствия на мебель.'},
      {id:'category',label:'Проверить категорию Ozon и обязательные атрибуты через Seller API.'},
      {id:'fulfillment',label:'Определить FBS/FBO, маршрут и условия доставки.'},
      {id:'price',label:'Пересчитать цену по подтверждённой юнит-экономике и согласовать её.'}
    ];
    if(!textReady)blocks.push({id:'text',label:'Завершить подготовку текста и проверку валидатором.'});
    if(photoCount<1)blocks.push({id:'photos',label:'Подготовить изображения товара и проверить качество.'});
    if(warnings.length)blocks.push({id:'facts',label:'Снять противоречия в исходных характеристиках и гарантии.'});
    cards.push({
      id,
      name:trimmed(fact?.name)||trimmed(draft.name)||'Название не найдено',
      sourceUrl:trimmed(fact?.url),
      offerId:trimmed(draft.offer_id),
      sourceSitePrice:positiveNumber(fact?.price),
      proposedDraftPrice:positiveNumber(draft.price),
      netWeightKg:positiveNumber(draft.weight_kg),
      assembledDimensions:trimmed(draft.dimensions),
      packedDimensions:null,
      packedGrossWeightKg:null,
      confirmed1cSku:null,
      confirmedCost:null,
      confirmedStock:null,
      confirmedDocument:null,
      approvedSellingPrice:null,
      ozonCategoryId:null,
      fulfillment:null,
      textReady,photoCount,infographicCount,
      candidates:candidateCodes,
      warnings,
      blockers:blocks,
      publishAllowed:false,
      apiWriteAllowed:false
    });
  }
  return {
    generatedAt:now.toISOString(),
    source:'Локальный проект «МП Выход»; только предварительная проверка, не live-каталог Ozon',
    tariffsDate:trimmed(tariffs.updated),
    tariffsVerified:false,
    errors,
    summary:{total:cards.length,textReady:cards.filter(x=>x.textReady).length,publishReady:0},
    cards,
    publicationMode:'BLOCKED_READ_ONLY'
  };
}
