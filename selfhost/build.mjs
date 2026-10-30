import ts from 'typescript';
import {build} from 'vite';
import {readFile,writeFile,mkdir,cp,realpath,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'work/selfhost-release');
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
await build({configFile:path.join(root,'selfhost/vite.config.ts')});
await mkdir(path.join(output,'server'),{recursive:true});
for(const name of ['domain','crypto','marketplaces']){
 const source=await readFile(path.join(root,`lib/${name}.ts`),'utf8');
 await writeFile(path.join(output,`server/${name}.mjs`),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
}
let source=await readFile(path.join(root,'app/api/hub/route.ts'),'utf8');source=source.replace("'cloudflare:workers'","'./runtime.mjs'").replaceAll("'@/lib/domain'","'./domain.mjs'").replaceAll("'@/lib/crypto'","'./crypto.mjs'").replaceAll("'@/lib/marketplaces'","'./marketplaces.mjs'").replaceAll('import.meta.env.DEV','false');
await writeFile(path.join(output,'server/hub.mjs'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
for(const name of await readdir(path.join(root,'selfhost/server')))await cp(path.join(root,'selfhost/server',name),path.join(output,'server',name));
await cp(path.join(root,'drizzle'),path.join(output,'migrations'),{recursive:true});
await cp(await realpath(path.join(root,'node_modules/zod')),path.join(output,'node_modules/zod'),{recursive:true});
await cp(path.join(root,'selfhost/deploy'),output,{recursive:true});
await writeFile(path.join(output,'package.json'),JSON.stringify({name:'marketflow-selfhost',version:'1.0.0',private:true,type:'module',engines:{node:'>=24.12.0'}},null,2));
console.log('Self-hosted release:',output);
