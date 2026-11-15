import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {buildSnapshot,applyApproval,summarizeOzon,checkOzon} from './core.mjs';

async function fixtures(){
  const root=await mkdtemp(path.join(os.tmpdir(),'mp-manager-test-'));
  const put=async(file,value)=>{
    const loc=path.join(root,file);await mkdir(path.dirname(loc),{recursive:true});
    await writeFile(loc,typeof value==='string'?value:JSON.stringify(value),'utf8');
    return loc;
  };
  await put('data/skus.json',[{code:'00-1',product:'Стул',variant:'серый',category:'Стулья',cost:1000,stock_total:5,stock_spb:3,stock_obuh:2,ozon:3200}]);
  await put('data/site_cards_input.json',[{id:'S01',section:'Столы',name:'Стол Бостон',url:'https://example.invalid/boston',price:9000,images:['a','b']}]);
  await put('cards/site_cards.json',[{id:'S01',ozon:{title:'Стол Бостон',description:'Описание'},wb:{title:'Бостон',description:'Описание WB'}}]);
  await put('data/site_readiness.json',{S01:{status:'готово',reasons:[],gaps:['Проверьте документы']}});
  await put('data/site_matches.json',[{site:{url:'https://example.invalid/boston'},cands:[{code:'00-2',name:'Столешница'}]}]);
  await put('reports/validation.json',[{id:'S01',platform:'ozon',errors:[]},{id:'S01',platform:'wb',errors:[]}]);
  await put('data/tariffs.json',{updated:'2026-11-13',status:'Ориентиры'});
  await put('cards/photos/S01/01.jpg','fake jpg bytes');
  const password=await put('password.txt','some-long-test-password\n');
  return {root,put,password};
}
test('snapshot reads 1C and site data without inventing cost or confirmed matching',async()=>{
  const f=await fixtures();
  try{
    const s=await buildSnapshot(f.root,new Date('2026-11-16T00:00:00Z'));
    assert.equal(s.stats.skuVariants,1);
    assert.equal(s.stats.oneCStock,5);
    assert.equal(s.stats.siteCards,1);
    assert.equal(s.stats.photos,2);
    assert.equal(s.stats.textValidated,1);
    assert.equal(s.stats.contentReady,1);
    assert.equal(s.cards[0].cost,null);
    assert.equal(s.cards[0].stock,null);
    assert.equal(s.cards[0].matched1cCode,null);
    assert.equal(s.cards[0].candidates[0].inSelected1C,false);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('approval saves a draft decision only, never a publication action',()=>{
  const data=applyApproval({},'S01','reviewed',new Date('2026-11-16T00:00:00Z'));
  assert.equal(data.S01.decision,'reviewed');
  assert.match(data.S01.note,/не публикация/);
  assert.equal(Object.hasOwn(data.S01,'published'),false);
  assert.throws(()=>applyApproval(data,'../bad','reviewed'));
  assert.throws(()=>applyApproval(data,'S01','publish'));
});
test('Ozon pagination response is read-only and guarded',async()=>{
  let called=false;
  const fakeFetch=async(url,options)=>{
    called=true;
    assert.equal(url,'https://api-seller.ozon.ru/v3/product/list');
    assert.equal(options.method,'POST');
    assert.equal(options.headers['Client-Id'],'6241845');
    assert.equal(options.headers['Api-Key'],'secret-in-test');
    assert.deepEqual(JSON.parse(options.body),{filter:{visibility:'ALL'},last_id:'',limit:100});
    return new Response(JSON.stringify({result:{items:[{offer_id:'S01',product_id:1234}],last_id:'',total_items:1}}),{status:200});
  };
  const result=await checkOzon('6241845','secret-in-test',fakeFetch);
  assert.equal(called,true);
  assert.equal(result.ok,true);
  assert.equal(result.countOnPage,1);
  assert.equal(result.products[0].offerId,'S01');
  assert.equal(JSON.stringify(result).includes('secret-in-test'),false);
  assert.equal(summarizeOzon(null,403).ok,false);
});
test('HTTP authentication, CSRF, approvals and missing key configuration',async()=>{
  const f=await fixtures();
  const previous={};
  const config={MP_SKIP_LISTEN:'1',MP_PROJECT_DIR:f.root,MP_PUBLIC_ORIGIN:'http://127.0.0.1:18777',MP_PORT:'18777',MP_ADMIN_PASSWORD_FILE:f.password,OZON_CLIENT_ID:'6241845',OZON_API_KEY_FILE:''};
  Object.keys(config).forEach(k=>{previous[k]=process.env[k];process.env[k]=config[k];});
  let server;
  try{
    ({server}=await import('./server.mjs?test='+Date.now()));
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18777,'127.0.0.1',resolve);});
    const base='http://127.0.0.1:18777';
    const unauth=await fetch(base+'/api/snapshot',{redirect:'manual'});
    assert.equal(unauth.status,401);
    const page=await fetch(base+'/login');assert.equal(page.status,200);
    assert.equal(page.headers.get('referrer-policy'),'same-origin');
    const bad=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{'Origin':base,'Content-Type':'application/x-www-form-urlencoded'},body:'password=incorrect'});
    assert.equal(bad.status,401);
    const ok=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:'password=some-long-test-password'});
    assert.equal(ok.status,303);
    const cookie=ok.headers.get('set-cookie').split(';')[0];
    const options={headers:{Cookie:cookie}};
    const snapshot=await fetch(base+'/api/snapshot',options);
    assert.equal(snapshot.status,200);
    const value=await snapshot.json();assert.equal(value.stats.siteCards,1);
    const csrf=await fetch(base+'/api/approvals',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:'https://attacker.invalid'},body:JSON.stringify({id:'S01',decision:'reviewed'})});
    assert.equal(csrf.status,403);
    const approved=await fetch(base+'/api/approvals',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:base},body:JSON.stringify({id:'S01',decision:'reviewed'})});
    assert.equal(approved.status,200);
    const persisted=JSON.parse(await readFile(path.join(f.root,'manager-approvals.json'),'utf8'));
    assert.equal(persisted.S01.decision,'reviewed');
    const ozon=await fetch(base+'/api/ozon/check',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:base},body:JSON.stringify({confirm:'read-only'})});
    assert.equal(ozon.status,409);
    assert.equal((await fetch(base+'/media/S01/01.jpg',options)).status,200);
    assert.equal((await fetch(base+'/media/S01/../../password.txt',options)).status,404);
  }finally{
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;
    await rm(f.root,{recursive:true,force:true});
  }
});