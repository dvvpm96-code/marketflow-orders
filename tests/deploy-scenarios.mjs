import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Execute the real runner script with synthetic credentials and fake network
// commands. This checks the SSH boundary without contacting any server.
const root=path.resolve(import.meta.dirname,'..');
const directory=await mkdtemp(path.join(tmpdir(),'marketflow-deploy-test-'));
let count=0;
try {
  const bin=path.join(directory,'bin');
  await (await import('node:fs/promises')).mkdir(bin);
  const key=path.join(directory,'synthetic-key');
  assert.equal(spawnSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]).status,0);
  const publicKey=(await readFile(key+'.pub','utf8')).trim();
  const privateKey=await readFile(key,'utf8');
  const password='Synthetic deployment $password `not-code` 123';
  const log=path.join(directory,'commands.jsonl');
  const fake=`#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const name=path.basename(process.argv[1]),args=process.argv.slice(2);
appendFileSync(process.env.DEPLOY_TEST_LOG,JSON.stringify({name,args})+'\\n');
if(name==='sshpass') {const r=spawnSync(args[1],args.slice(2),{env:process.env,stdio:'inherit'});process.exit(r.status??1);}
if(name==='scp')process.exit(process.env.DEPLOY_TEST_FAIL==='transfer'?44:0);
if(name==='ssh'){
 const command=args.at(-1);
 if(command.includes('mktemp -d')){console.log('/var/tmp/marketflow-github.1234ABCD');process.exit(0);}
 if(command.includes('install.sh')){
  let stdin='';for await(const chunk of process.stdin)stdin+=chunk;
  appendFileSync(process.env.DEPLOY_TEST_LOG,JSON.stringify({stdinHash:createHash('sha256').update(stdin).digest('hex')})+'\\n');
  process.exit(process.env.DEPLOY_TEST_FAIL==='install'?45:0);
 }
 process.exit(0);
}
if(name==='curl'){
 if(process.env.DEPLOY_TEST_FAIL==='https')process.exit(60);
 const url=args.at(-1);if(args.includes('-w'))process.stdout.write(url.endsWith('/api/hub')?'401':'200');
}
`;
  for(const name of ['ssh','scp','sshpass','curl'])await writeFile(path.join(bin,name),fake,{mode:0o700});
  const archive=path.join(directory,'package.tar.gz');await writeFile(archive,'synthetic package; never unpacked');
  const base={...process.env,PATH:bin+':'+process.env.PATH,RUNNER_TEMP:directory,SERVER_HOST:'server.example.test',SERVER_PORT:'2222',SERVER_KNOWN_HOSTS:`[server.example.test]:2222 ${publicKey}`,SERVER_SSH_KEY:privateKey,SERVER_PASSWORD:'',CABINET_PASSWORD:password,SITE_DOMAIN:'orders.example.test',CABINET_USERNAME:'dmitry',DEPLOY_TEST_LOG:log,GITHUB_OUTPUT:path.join(directory,'outputs'),GITHUB_STEP_SUMMARY:path.join(directory,'summary')};
  async function run(extra={},check=false){
    await writeFile(log,'');
    const result=spawnSync('bash',[path.join(root,'selfhost/deploy/github-install.sh'),check?'--check':archive],{env:{...base,...extra},encoding:'utf8'});
    const output=result.stdout+result.stderr;
    const calls=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.ok(!output.includes(password));assert.ok(!output.includes(privateKey));
    assert.ok(!JSON.stringify(calls).includes(password));
    assert.ok(!(await readdir(directory)).some(name=>name.startsWith('marketflow-deploy.')),'temporary credentials must be removed');
    return {result,output,calls};
  }
  async function check(name,fn){await fn();count++;console.log('✓ '+name);}
  await check('Missing secrets and malformed domain are rejected before any connection',async()=>{
    for(const extra of [{SERVER_KNOWN_HOSTS:''},{SITE_DOMAIN:'orders.test; touch /tmp/unsafe'},{SERVER_PORT:'0'},{CABINET_PASSWORD:'short'},{CABINET_PASSWORD:'synthetic-password\nsecond-line'},{SERVER_PASSWORD:'synthetic'}]){
      const {result,calls}=await run(extra);assert.notEqual(result.status,0);assert.equal(calls.length,0);
    }
  });
  await check('Host key must match the configured host and port; config check does not connect',async()=>{
    const bad=await run({SERVER_KNOWN_HOSTS:`another.example.test ${publicKey}`});assert.notEqual(bad.result.status,0);assert.equal(bad.calls.length,0);
    const good=await run({},true);assert.equal(good.result.status,0,good.output);assert.equal(good.calls.length,0);
  });
  await check('Pinned SSH, password through stdin, HTTPS and unauthenticated API verification',async()=>{
    const {result,output,calls}=await run();assert.equal(result.status,0,output);
    const connections=calls.filter(call=>['ssh','scp'].includes(call.name));
    assert.ok(connections.length>=4);
    for(const call of connections){assert.ok(call.args.includes('StrictHostKeyChecking=yes'));assert.ok(call.args.includes('GlobalKnownHostsFile=/dev/null'));assert.ok(call.args.includes('Port=2222'));}
    const remote=calls.find(call=>call.name==='ssh'&&call.args.at(-1).includes('install.sh'));
    assert.ok(remote.args.at(-1).includes('--password-stdin --install-dependencies --domain orders.example.test --username dmitry'));
    const {createHash}=await import('node:crypto');assert.ok(calls.some(call=>call.stdinHash===createHash('sha256').update(password+'\n').digest('hex')));
    assert.ok(calls.some(call=>call.name==='curl'&&call.args.at(-1)==='https://orders.example.test/api/hub'));
    assert.ok(!(await readFile(base.GITHUB_STEP_SUMMARY,'utf8')).includes(password));
  });
  await check('SSH password transport also preserves host checking and keeps credentials out of argv',async()=>{
    const {result,output,calls}=await run({SERVER_SSH_KEY:'',SERVER_PASSWORD:'Synthetic-SSH-password'});assert.equal(result.status,0,output);
    assert.ok(calls.some(call=>call.name==='sshpass'));assert.ok(!JSON.stringify(calls).includes('Synthetic-SSH-password'));
  });
  await check('Failed upload never runs installer; remote failure propagates and staging is cleaned',async()=>{
    const failedUpload=await run({DEPLOY_TEST_FAIL:'transfer'});assert.equal(failedUpload.result.status,44);
    assert.ok(!failedUpload.calls.some(call=>call.name==='ssh'&&call.args.at(-1).includes('install.sh')));
    assert.ok(failedUpload.calls.some(call=>call.name==='ssh'&&call.args.at(-1)==='rm -rf -- /var/tmp/marketflow-github.1234ABCD'));
    const failedInstall=await run({DEPLOY_TEST_FAIL:'install'});assert.equal(failedInstall.result.status,45);assert.ok(!failedInstall.calls.some(call=>call.name==='curl'));
    const badHttps=await run({DEPLOY_TEST_FAIL:'https'});assert.equal(badHttps.result.status,60);assert.ok(!badHttps.output.includes('Кабинет доступен:'));
  });
  console.log(`\n${count} deployment scenarios passed. No real SSH or HTTPS requests were made.`);
} finally {await rm(directory,{recursive:true,force:true});}
