import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
export function openDatabase(filename,migrations){
 mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
 const sqlite=new DatabaseSync(filename);chmodSync(filename,0o600);
 sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 sqlite.exec('CREATE TABLE IF NOT EXISTS _marketflow_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
 for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort()){
  if(sqlite.prepare('SELECT name FROM _marketflow_migrations WHERE name=?').get(name))continue;
  sqlite.exec('BEGIN IMMEDIATE');try{sqlite.exec(readFileSync(path.join(migrations,name),'utf8'));sqlite.prepare('INSERT INTO _marketflow_migrations VALUES (?,?)').run(name,new Date().toISOString());sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}
 }
 sqlite.exec('CREATE TABLE IF NOT EXISTS _sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS _login_limits (address TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL);');
 class Statement{
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){return new Statement(this.sql,values);}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.values)}}
  async first(){return sqlite.prepare(this.sql).get(...this.values)||null}
  async run(){const r=sqlite.prepare(this.sql).run(...this.values);return {success:true,meta:{changes:Number(r.changes)}}}
 }
 return {sqlite,DB:{prepare(sql){return new Statement(sql)},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements){const result=sqlite.prepare(statement.sql).run(...statement.values);results.push({success:true,meta:{changes:Number(result.changes)}});}sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}}};
}
