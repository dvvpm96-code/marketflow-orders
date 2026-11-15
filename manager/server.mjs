import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile, rename} from 'node:fs/promises';
import {randomBytes, createHmac, scryptSync, timingSafeEqual} from 'node:crypto';
import {buildSnapshot, checkOzon, applyApproval, DEFAULT_PROJECT} from './core.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(process.env.MP_PROJECT_DIR || DEFAULT_PROJECT);
const origin=process.env.MP_PUBLIC_ORIGIN || '';
const port=Number(process.env.MP_PORT || 8777);
const bindHost=process.env.MP_BIND_HOST || '127.0.0.1';
const clientId=process.env.OZON_CLIENT_ID || '';
const passwordFile=process.env.MP_ADMIN_PASSWORD_FILE || '';
const keyFile=process.env.OZON_API_KEY_FILE || '';
const approvalsFile=process.env.MP_APPROVALS_FILE || path.join(root,'manager-approvals.json');
const sessionKey=randomBytes(32);
const loginAttempts=new Map();
if(!passwordFile || !/^https?:\/\/[^/]+$/.test(origin) || !Number.isInteger(port) || port<1024 || port>65535 || !/^(?:127\.0\.0\.1|100\.(?:\d{1,3}\.){2}\d{1,3})$/.test(bindHost)) throw new Error('Configure MP_ADMIN_PASSWORD_FILE, MP_PUBLIC_ORIGIN, MP_PORT, MP_BIND_HOST first');
const cookieSecure=origin.startsWith('https://') ? '; Secure' : '';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"};
function send(res,status,payload,extra={}) {
  res.writeHead(status,{...headers,...extra});
  res.end(Buffer.isBuffer(payload)||typeof payload==='string'?payload:JSON.stringify(payload));
}
function json(res,status,payload){send(res,status,payload,{'Content-Type':'application/json; charset=utf-8'});}
function mac(s){return createHmac('sha256',sessionKey).update(s).digest('base64url');}
function sessionValid(req) {
  const m=(req.headers.cookie||'').match(/(?:^|;\s*)mp_session=([^;]+)/);
  if(!m)return false;
  const parts=m[1].split('.');
  if(parts.length!==3)return false;
  const [expiry,nonce,signature]=parts;
  if(!/^\d{12,14}$/.test(expiry)||Number(expiry)<Date.now()||Number(expiry)>Date.now()+13*3600_000||!/^[a-f0-9]{32}$/.test(nonce))return false;
  const want=Buffer.from(mac(expiry+'.'+nonce)),have=Buffer.from(signature);
  return have.length===want.length&&timingSafeEqual(have,want);
}
function makeCookie(){
  const expiry=String(Date.now()+12*3600_000),nonce=randomBytes(16).toString('hex');
  return 'mp_session='+expiry+'.'+nonce+'.'+mac(expiry+'.'+nonce)+'; Max-Age=43200; HttpOnly; SameSite=Strict; Path=/'+cookieSecure;
}
function checkPassword(input,expected){
  const a=scryptSync(input,'mp-manager-password-v1',64),b=scryptSync(expected,'mp-manager-password-v1',64);
  return timingSafeEqual(a,b);
}
async function body(req,max=8192) {
  let size=0;const parts=[];
  for await(const part of req){size+=part.length;if(size>max)throw new Error('TOO_LARGE');parts.push(part);}
  return Buffer.concat(parts).toString('utf8');
}
function error(res,code,message){return json(res,code,{ok:false,error:message});}
async function approvalsRead(){
  try{const data=JSON.parse(await readFile(approvalsFile,'utf8'));return data&&typeof data==='object'&&!Array.isArray(data)?data:{};}
  catch(e){if(e.code==='ENOENT')return {};throw e;}
}
async function approvalsSave(data){
  const target=approvalsFile,temp=target+'.'+randomBytes(6).toString('hex')+'.tmp';
  await writeFile(temp,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
  await rename(temp,target);
}
async function staticFile(res,pathname) {
  const name=pathname==='/'?'index.html':pathname.substring(1);
  if(!['index.html','app.js','style.css'].includes(name))return error(res,404,'Не найдено');
  const contents=await readFile(path.join(directory,'web',name));
  const mime=name.endsWith('html')?'text/html; charset=utf-8':name.endsWith('css')?'text/css; charset=utf-8':'application/javascript; charset=utf-8';
  return send(res,200,contents,{'Content-Type':mime});
}
function photoPath(p){
  const m=p.match(/^\/media\/(S(?:0[1-9]|1[0-6]))\/(0[1-9]|1[0-7])\.jpg$/);
  return m?path.join(root,'cards','photos',m[1],m[2]+'.jpg'):null;
}
const loginPage='<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>МП Управляющий — вход</title><link rel="stylesheet" href="/style.css"></head><body class="login-page"><main class="login-card"><p class="eyebrow">STOLBERI / MARKETPLACES</p><h1>МП Управляющий</h1><p>Защищённый кабинет владельца.</p><form method="post" action="/login"><label>Пароль<input type="password" name="password" autocomplete="current-password" required></label><button class="primary" type="submit">Войти</button></form></main></body></html>';
async function handler(req,res){
  try{
    const u=new URL(req.url||'/',origin),p=u.pathname;
    if(req.headers.host!==new URL(origin).host)return error(res,421,'Неверный адрес');
    if(req.method==='GET'&&p==='/healthz')return json(res,200,{ok:true,service:'mp-manager'});
    if(req.method==='GET'&&p==='/style.css')return staticFile(res,p);
    if(req.method==='GET'&&p==='/login')return send(res,200,loginPage,{'Content-Type':'text/html; charset=utf-8'});
    if(req.method==='POST'&&p==='/login'){
      if(req.headers.origin!==origin)return error(res,403,'Источник запроса не совпадает');
      const addr=req.socket.remoteAddress||'unknown',prior=loginAttempts.get(addr)||{count:0,until:0};
      if(prior.count>=8&&prior.until>Date.now())return error(res,429,'Слишком много попыток входа');
      const pass=new URLSearchParams(await body(req)).get('password')||'';
      const expected=(await readFile(passwordFile,'utf8')).trimEnd();
      if(pass.length>1024||expected.length<16||!checkPassword(pass,expected)){
        loginAttempts.set(addr,{count:prior.count+1,until:Date.now()+15*60_000});
        return send(res,401,'Неверный пароль. <a href="/login">Повторить</a>',{'Content-Type':'text/html; charset=utf-8'});
      }
      loginAttempts.delete(addr);res.writeHead(303,{Location:'/', 'Set-Cookie':makeCookie(),'Cache-Control':'no-store'});return res.end();
    }
    if(!sessionValid(req)){
      if(p.startsWith('/api/'))return error(res,401,'Войдите в кабинет');
      res.writeHead(303,{Location:'/login','Cache-Control':'no-store'});return res.end();
    }
    if(req.method==='POST'&&(req.headers.origin!==origin||req.headers['content-type']!=='application/json'))return error(res,403,'Недопустимый запрос');
    if(req.method==='GET'&&p==='/api/snapshot'){
      const [snapshot,approvals]=await Promise.all([buildSnapshot(root),approvalsRead()]);
      return json(res,200,{...snapshot,approvals,ozon:{clientIdConfigured:Boolean(clientId),keyFileConfigured:Boolean(keyFile),status:'Не проверен'}});
    }
    if(req.method==='POST'&&p==='/api/ozon/check'){
      const data=JSON.parse(await body(req));
      if(data.confirm!=='read-only')return error(res,400,'Только чтение');
      if(!clientId||!keyFile)return error(res,409,'Client ID и путь к файлу API-ключа не настроены');
      const key=(await readFile(keyFile,'utf8')).trim();
      try{return json(res,200,{...(await checkOzon(clientId,key)),checkedAt:new Date().toISOString()});}
      catch(e){return error(res,502,e.name==='TimeoutError'?'Ozon не ответил за 12 секунд':'Проверить Ozon не удалось');}
    }
    if(req.method==='POST'&&p==='/api/approvals'){
      const data=JSON.parse(await body(req)),snapshot=await buildSnapshot(root);
      if(!snapshot.cards.some(x=>x.id===data.id))return error(res,404,'Карточка не найдена');
      const updated=applyApproval(await approvalsRead(),data.id,data.decision);
      await approvalsSave(updated);
      return json(res,200,{ok:true,approvals:updated});
    }
    if(req.method==='GET'&&p.startsWith('/media/')){
      const target=photoPath(p);
      if(!target)return error(res,404,'Фото не найдено');
      const bytes=await readFile(target);return send(res,200,bytes,{'Content-Type':'image/jpeg'});
    }
    if(req.method==='GET'&&(p==='/'||p==='/app.js'))return staticFile(res,p);
    return error(res,404,'Не найдено');
  }catch(e){
    console.error('MP Manager error:',e.code||e.name||'Error');
    return error(res,e.message==='TOO_LARGE'?413:500,'Ошибка сервера');
  }
}
export const server=http.createServer(handler);
if(process.env.MP_SKIP_LISTEN!=='1')server.listen(port,bindHost,()=>console.log('MP Manager service started on configured interface'));
