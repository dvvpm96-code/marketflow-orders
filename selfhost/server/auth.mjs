import {randomBytes,scrypt as rawScrypt,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(rawScrypt);
export async function passwordHash(password,salt){return Buffer.from(await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024})).toString('hex');}
export function sessionHash(value){return createHash('sha256').update(value).digest('hex');}
export function sessionToken(cookie){const value=String(cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('marketflow_session='))?.slice(19);return value&&/^[a-f0-9]{64}$/.test(value)?value:null;}
export function authenticated(sqlite,cookie){const token=sessionToken(cookie);if(!token)return false;return !!sqlite.prepare('SELECT 1 FROM _sessions WHERE token_hash=? AND expires>?').get(sessionHash(token),Date.now());}
export function cookieHeader(token,secure,age=7*86400){return `marketflow_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;}
export async function login(sqlite,config,username,password,address){
 const now=Date.now(),limit=sqlite.prepare('SELECT * FROM _login_limits WHERE address=?').get(address);
 if(limit&&now-limit.window_start<15*60*1000&&limit.failures>=8)return {status:429};
 const actual=Buffer.from(await passwordHash(password,config.salt),'hex'),expected=Buffer.from(config.passwordHash,'hex');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||username!==config.username){
  sqlite.prepare('INSERT INTO _login_limits(address,failures,window_start) VALUES (?,1,?) ON CONFLICT(address) DO UPDATE SET failures=CASE WHEN ?-window_start>=900000 THEN 1 ELSE failures+1 END,window_start=CASE WHEN ?-window_start>=900000 THEN ? ELSE window_start END').run(address,now,now,now,now);return {status:401};
 }
 sqlite.prepare('DELETE FROM _login_limits WHERE address=?').run(address);
 sqlite.prepare('DELETE FROM _sessions WHERE expires<=?').run(now);
 const token=randomBytes(32).toString('hex');sqlite.prepare('INSERT INTO _sessions VALUES (?,?)').run(sessionHash(token),now+7*86400000);return {status:200,token};
}
export function logout(sqlite,cookie){const token=sessionToken(cookie);if(token)sqlite.prepare('DELETE FROM _sessions WHERE token_hash=?').run(sessionHash(token));}
