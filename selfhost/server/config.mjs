import {readFileSync} from 'node:fs';
import path from 'node:path';
export const configPath=process.env.MARKETFLOW_CONFIG||'/var/lib/marketflow/config.json';
export function loadConfig(){
 const value=JSON.parse(readFileSync(configPath,'utf8'));
 if(!/^[a-f0-9]{64}$/.test(value.masterKey||''))throw new Error('Invalid master key configuration');
 const url=new URL(value.origin);
 if(url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('Origin must have no path, query, credentials or fragment');
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw new Error('HTTPS is required outside loopback');
 if(!value.passwordHash||!value.salt||!value.username)throw new Error('Login must be configured');
 return {...value,origin:url.origin,dataDirectory:value.dataDirectory||path.dirname(configPath),secureCookie:url.protocol==='https:'};
}
