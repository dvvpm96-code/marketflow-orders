import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {buildOzonPilot,PILOT_IDS} from './pilot.mjs';

test('Ozon pilot never approves publication using copywriting readiness alone',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mp-pilot-'));
 const save=async(rel,value)=>{
   const dest=path.join(root,rel);await mkdir(path.dirname(dest),{recursive:true});
   await writeFile(dest,typeof value==='string'?value:JSON.stringify(value));
 };
 try {
   await save('data/site_cards_input.json',[
     {id:'S01',url:'https://example.invalid/boston',name:'Бостон',price:42540,description:'инженерный массив дуба и ольхи',props:{'Материал столешницы':'массив дуба'}},
     {id:'S09',url:'https://example.invalid/grand',name:'Гранд бежевый велюр',price:8350,props:{'Обивка':'светлый бук'}},
     {id:'S12',url:'https://example.invalid/richi',name:'Ричи',price:4830,description:'Гарантия: 2 года.'}
   ]);
   await save('data/skus.json',[{code:'00-1',product:'Каркас Ричи',cost:300,stock_total:10}]);
   await save('data/site_matches.json',[{site:{url:'https://example.invalid/richi'},cands:[{code:'00-1',name:'Каркас Ричи'}]}]);
   await save('data/site_readiness.json',Object.fromEntries(PILOT_IDS.map(id=>[id,{status:'готово'}])));
   await save('reports/validation.json',PILOT_IDS.map(id=>({id,platform:'ozon',errors:[]})));
   await save('data/tariffs.json',{updated:'2026-11-13'});
   for(const id of PILOT_IDS){
     await save('cards/photos/'+id+'/01.jpg','not-real-photo');
     await save('cards/upload/'+id+'_ozon.json',{
       offer_id:'SB-'+id,title:id+' test title',description:id+' description',
       price:id==='S01'?42540:id==='S09'?8350:4830,
       guarantee:'18 месяцев',photos:['cards/photos/'+id+'/01.jpg'],
       infographics:['cards/infographics/'+id+'/01.jpg']
     });
   }
   const s=await buildOzonPilot(root,new Date('2026-11-16T00:00:00Z'));
   assert.equal(s.summary.total,3);
   assert.equal(s.summary.textReady,3);
   assert.equal(s.summary.publishReady,0);
   assert.equal(s.publicationMode,'BLOCKED_READ_ONLY');
   assert.deepEqual(s.cards.map(x=>x.id),PILOT_IDS);
   assert.equal(s.cards[0].sourceSitePrice,42540);
   assert.equal(s.cards[1].sourceSitePrice,8350);
   assert.equal(s.cards[2].sourceSitePrice,4830);
   for(const item of s.cards){
     assert.equal(item.publishAllowed,false);
     assert.equal(item.apiWriteAllowed,false);
     assert.equal(item.confirmed1cSku,null);
     assert.equal(item.confirmedCost,null);
     assert.equal(item.confirmedStock,null);
     assert.equal(item.packedDimensions,null);
     assert.equal(item.approvedSellingPrice,null);
     assert.equal(item.photoCount,1);
     assert.equal(item.infographicCount,0);
     assert.ok(item.blockers.length>=8);
   }
   assert.ok(s.cards[0].warnings.some(x=>/столешницы/.test(x)));
   assert.ok(s.cards[1].warnings.some(x=>/обивки/.test(x)));
   assert.ok(s.cards[2].warnings.some(x=>/гарантии/.test(x)));
   assert.equal(s.cards[2].candidates[0].autoMatched,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('missing files leave pilot blocked rather than report fake readiness',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mp-pilot-missing-'));
  try{
    const data=await buildOzonPilot(root);
    assert.equal(data.cards.length,3);
    assert.equal(data.summary.publishReady,0);
    assert.equal(data.summary.textReady,0);
    assert.ok(data.errors.length>=6);
  }finally{await rm(root,{recursive:true,force:true});}
});
