import {openDatabase} from './sqlite.mjs';
import {loadConfig} from './config.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const config=loadConfig();
const migrations=path.join(path.dirname(fileURLToPath(import.meta.url)),'../migrations');
export const {DB,sqlite}=openDatabase(path.join(config.dataDirectory,'orders.sqlite3'),migrations);
export const env={DB,CREDENTIALS_MASTER_KEY:config.masterKey};
