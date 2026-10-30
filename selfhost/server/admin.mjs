import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,existsSync,mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {passwordHash} from './auth.mjs';
const [action,filename,originOrUsername,usernameArg]=process.argv.slice(2);
function stop(message){console.error(message);process.exit(1);}
if(!['init','password','origin'].includes(action)||!filename)stop('Usage: node admin.mjs init CONFIG ORIGIN USERNAME | password CONFIG [USERNAME] | origin CONFIG ORIGIN');
if(action==='init'&&existsSync(filename))stop('Config already exists; nothing overwritten');
let config=action==='init'?{}:JSON.parse(readFileSync(filename,'utf8'));
if(action==='origin'||action==='init'){
 const url=new URL(originOrUsername);if(url.pathname!=='/'||url.search||url.hash||url.username||url.password)stop('Invalid origin');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))stop('HTTPS is required for a non-local address');
 config.origin=url.origin;
}
if(action!=='origin'){
 let input='';for await(const chunk of process.stdin){input+=chunk.toString();if(input.length>4096)stop('Password too long');}
 const password=input.replace(/\r?\n$/,'');if(password.length<12)stop('Use a password with at least 12 characters');
 config.salt=randomBytes(16).toString('hex');config.passwordHash=await passwordHash(password,config.salt);config.username=(action==='init'?usernameArg:originOrUsername)||config.username||'dmitry';
 if(!/^[a-zA-Z0-9._-]{1,64}$/.test(config.username))stop('Invalid username');
}
if(action==='init'){config.masterKey=randomBytes(32).toString('hex');config.ownerId='selfhost-owner';}
mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});writeFileSync(filename,JSON.stringify(config,null,2)+'\n',{mode:0o600});chmodSync(filename,0o600);if(action==='password'){const database=path.join(path.dirname(filename),'orders.sqlite3');if(existsSync(database)){const db=new DatabaseSync(database);db.exec('PRAGMA busy_timeout=5000');db.exec('BEGIN; DELETE FROM _sessions; DELETE FROM _login_limits; COMMIT;');db.close();}}console.log('Configuration saved. No secrets were printed.');
