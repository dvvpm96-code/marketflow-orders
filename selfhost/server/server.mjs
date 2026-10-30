import http from 'node:http';
import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {config,sqlite} from './runtime.mjs';
import {GET,POST} from './hub.mjs';
import {authenticated,cookieHeader,login,logout} from './auth.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../client');
const common={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'"};
const mimes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.ico':'image/x-icon'};
function send(res,status,body,headers={}){res.writeHead(status,{...common,...headers});res.end(body);}
function redirect(res,target,headers={}){send(res,303,'',{Location:target,...headers});}
function validOrigin(req){return req.headers.origin===config.origin;}
async function body(req,limit){const chunks=[];let count=0;for await(const chunk of req){count+=chunk.length;if(count>limit)throw new Error('TOO_LARGE');chunks.push(chunk);}return Buffer.concat(chunks);}
function loginPage(message=''){
 return `<!doctype html><html lang="ru"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход · Поток</title><style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f4f7f4;color:#264334;display:grid;place-items:center;min-height:100dvh;margin:0;padding:24px}.card{max-width:420px;width:100%;background:white;padding:38px;border:1px solid #e1e9e2;border-radius:18px;box-shadow:0 15px 60px #24452c0a}.brand{font-size:32px;font-weight:800;color:#306b59;margin-bottom:28px}h1{font-size:23px;margin:0 0 12px}p{font-size:13px;color:#87988b;line-height:1.8}label{display:block;font-size:13px;margin:22px 0 8px}input{width:100%;padding:13px;border:1px solid #dce5de;border-radius:8px;font:inherit}button{width:100%;background:#306b59;border:0;border-radius:8px;padding:14px;color:white;font-size:14px;margin-top:26px;cursor:pointer}.error{color:#ad665b;background:#fff2ee;padding:12px;border-radius:8px}</style><div class="card"><div class="brand">поток ®</div><h1>Вход в ваш кабинет</h1><p>Заказы и этапы сборки доступны с любого устройства после входа.</p>${message?`<p class="error">${message}</p>`:''}<form method="post" action="/auth/login"><label for="username">Логин</label><input id="username" name="username" required maxlength="64" autocomplete="username" value="dmitry"><label for="password">Пароль</label><input id="password" name="password" type="password" required maxlength="1024" autocomplete="current-password"><button type="submit">Войти</button></form><p>Приватный кабинет · ваши данные хранятся на сервере</p></div></html>`;
}
export const server=http.createServer(async(req,res)=>{
 try{
  if(!req.url||!req.url.startsWith('/')||req.url.startsWith('//'))return send(res,400,'Invalid path');
  const url=new URL(req.url,config.origin),pathname=url.pathname;
  if(pathname==='/healthz'&&req.method==='GET')return send(res,200,'ok',{'Content-Type':'text/plain'});
  if(pathname==='/auth/login'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,loginPage('Обновите страницу входа и повторите попытку.'),{'Content-Type':'text/html; charset=utf-8'});
   const fields=new URLSearchParams((await body(req,8192)).toString('utf8'));
   const username=fields.get('username')||'',password=fields.get('password')||'';
   if(username.length>64||password.length>1024)return send(res,400,'Invalid login request');
   const result=await login(sqlite,config,username,password,req.socket.remoteAddress||'local');
   if(result.status!==200)return send(res,result.status,loginPage(result.status===429?'Слишком много попыток. Повторите через 15 минут.':'Неверный логин или пароль.'),{'Content-Type':'text/html; charset=utf-8'});
   return redirect(res,'/',{'Set-Cookie':cookieHeader(result.token,config.secureCookie)});
  }
  if(pathname==='/auth/logout'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Forbidden');
   logout(sqlite,req.headers.cookie);return send(res,200,'{}',{'Set-Cookie':cookieHeader('',config.secureCookie,0),'Content-Type':'application/json'});
  }
  const signedIn=authenticated(sqlite,req.headers.cookie);
  if(pathname==='/login'&&req.method==='GET')return signedIn?redirect(res,'/'):send(res,200,loginPage(),{'Content-Type':'text/html; charset=utf-8'});
  if(!signedIn){if(pathname.startsWith('/api/'))return send(res,401,JSON.stringify({error:'Войдите в кабинет'}),{'Content-Type':'application/json'});return redirect(res,'/login');}
  if(pathname==='/api/hub'){
   if(!['GET','POST'].includes(req.method))return send(res,405,'Method not allowed',{'Allow':'GET, POST'});
   if(req.method==='POST'&&!validOrigin(req))return send(res,403,JSON.stringify({error:'Недопустимый источник запроса'}),{'Content-Type':'application/json'});
   const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value&&key.toLowerCase().startsWith('oai-')===false&&key.toLowerCase()!=='cookie')headers.set(key,Array.isArray(value)?value.join(', '):value);
   // Client-supplied identity headers are never trusted on a self-hosted server.
   headers.set('oai-authenticated-user-id',config.ownerId||'selfhost-owner');
   const payload=req.method==='POST'?await body(req,2_100_000):undefined;
   const request=new Request(new URL('/api/hub',config.origin),{method:req.method,headers,...(payload?{body:payload}:{} )});
   const result=await(req.method==='POST'?POST(request):GET(request));return send(res,result.status,Buffer.from(await result.arrayBuffer()),Object.fromEntries(result.headers));
  }
  if(!['GET','HEAD'].includes(req.method))return send(res,405,'Method not allowed');
  let requested;try{requested=decodeURIComponent(pathname);}catch{return send(res,400,'Invalid path');}
  const filename=path.resolve(root,'.'+(requested==='/'?'/index.html':requested));if(!filename.startsWith(root+path.sep))return send(res,404,'Not found');
  let metadata;try{metadata=await stat(filename);}catch{return send(res,404,'Not found');}if(!metadata.isFile())return send(res,404,'Not found');
  const contents=req.method==='HEAD'?null:await readFile(filename);return send(res,200,contents,{'Content-Type':mimes[path.extname(filename)]||'application/octet-stream','Cache-Control':pathname.startsWith('/assets/')?'private, max-age=31536000, immutable':'no-store'});
 }catch(e){console.error('Request failed:',e?.code||e?.name||'Error');send(res,e?.message==='TOO_LARGE'?413:500,'Не удалось обработать запрос');}
});
const port=Number(process.env.PORT||3000);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
server.listen(port,'127.0.0.1',()=>console.log(`Marketflow listening on 127.0.0.1:${port}`));
function shutdown(){server.close(()=>{sqlite.close();process.exit(0)});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
