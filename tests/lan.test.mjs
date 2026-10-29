import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat, symlink, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createLANGateway, selectLAN } from '../scripts/lan-gateway.mjs';
import { googleSheetsWritesEnabled } from '../src/lib/google-sheets.ts';
import { aiAccess } from '../src/lib/ai-access.ts';
import { GET, POST, PATCH, DELETE } from '../src/app/api/archive/route.ts';
import { validateLANCredentials, privateLANFile, saveLANCredentials, withLANCredentialsLock } from '../scripts/lan-credentials.mjs';

test('LAN domestica: password di 7 rifiutata, 8 e 16 ammesse senza requisiti di composizione', () => {
  assert.throws(()=>validateLANCredentials({username:'fixture',password:'a'.repeat(7)}));
  for(const password of ['a'.repeat(8),'a'.repeat(16),'a'.repeat(64),'12345678','        ','àèìòùéñü','🔐'.repeat(8),'a !:é?z_']) {
    assert.doesNotThrow(()=>validateLANCredentials({username:'fixture',password}));
  }
  assert.throws(()=>validateLANCredentials({username:'fixture',password:'🔐'.repeat(7)}));
  assert.throws(()=>validateLANCredentials({username:'fixture',password:'a'.repeat(257)}));
  assert.throws(()=>validateLANCredentials({username:'fixture',password:'password\n'}));
});

test('LAN: sostituzione atomica credenziali, file 0600, certificato e chiave invariati', async () => {
  const dir=await mkdtemp(join(tmpdir(),'spesesmart-lan-rotation-'));
  try {
    const first={username:'previous-user',password:'a'.repeat(16)},next={username:'new-user',password:'b'.repeat(8)};
    await writeFile(join(dir,'cert.pem'),'fixture certificate',{mode:0o600});await writeFile(join(dir,'key.pem'),'fixture key',{mode:0o600});
    const cert=await stat(join(dir,'cert.pem')),key=await stat(join(dir,'key.pem'));
    await withLANCredentialsLock(dir,()=>saveLANCredentials(dir,first));
    const before=await privateLANFile(join(dir,'access.json'));
    await withLANCredentialsLock(dir,()=>saveLANCredentials(dir,next,before));
    const saved=JSON.parse(await privateLANFile(join(dir,'access.json')));
    assert.equal(saved.username===next.username&&saved.password===next.password,true);
    assert.equal((await stat(join(dir,'access.json'))).mode&0o777,0o600);
    assert.equal((await stat(join(dir,'cert.pem'))).mtimeMs,cert.mtimeMs);assert.equal((await stat(join(dir,'key.pem'))).mtimeMs,key.mtimeMs);
    assert.equal(await readFile(join(dir,'cert.pem'),'utf8'),'fixture certificate');assert.equal(await readFile(join(dir,'key.pem'),'utf8'),'fixture key');
    assert.equal((await readdir(dir)).some(name=>name.endsWith('.tmp')),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('LAN: password non valida, conflitto e symlink non sostituiscono le credenziali', async () => {
  const dir=await mkdtemp(join(tmpdir(),'spesesmart-lan-preserve-'));
  try {
    const first={username:'fixture',password:'a'.repeat(16)},next={username:'other',password:'b'.repeat(8)};
    await saveLANCredentials(dir,first);const before=await privateLANFile(join(dir,'access.json'));
    await assert.rejects(saveLANCredentials(dir,{username:'fixture',password:'1234567'},before));
    await assert.rejects(saveLANCredentials(dir,first,before),/identiche/);
    await assert.rejects(saveLANCredentials(dir,next,'stale-version'));
    assert.equal((await privateLANFile(join(dir,'access.json')))===before,true);
    await chmod(join(dir,'access.json'),0o644);await assert.rejects(saveLANCredentials(dir,next,before));
    await rm(join(dir,'access.json'));await writeFile(join(dir,'target.json'),before,{mode:0o600});await symlink(join(dir,'target.json'),join(dir,'access.json'));
    await assert.rejects(saveLANCredentials(dir,next,before));assert.equal((await readFile(join(dir,'target.json'),'utf8'))===before,true);
    await rm(join(dir,'access.json'));
    const malformed='{"password":"fixture-private-fragment",';
    await writeFile(join(dir,'access.json'),malformed,{mode:0o600});
    await assert.rejects(saveLANCredentials(dir,next,malformed),error=>!error.message.includes('fixture-private-fragment'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('LAN: lock condiviso blocca setup/server concorrenti e si libera alla chiusura', async () => {
  const dir=await mkdtemp(join(tmpdir(),'spesesmart-lan-lock-'));
  try {
    await withLANCredentialsLock(dir,async()=>{
      await assert.rejects(withLANCredentialsLock(dir,()=>assert.fail('Secondo server/setup ammesso')),/occupata/);
      const child=spawnSync(process.execPath,['--input-type=module','-e',`import {withLANCredentialsLock} from ${JSON.stringify(new URL('../scripts/lan-credentials.mjs',import.meta.url).href)};try{await withLANCredentialsLock(process.env.LAN_FIXTURE_DIR,async()=>{});process.exitCode=2;}catch{process.exitCode=0;}`],{env:{...process.env,LAN_FIXTURE_DIR:dir},stdio:'ignore'});
      assert.equal(child.status,0);
    });
    await withLANCredentialsLock(dir,async()=>{});
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('LAN: interfaccia dalla rotta reale, DHCP, scelta esplicita e ambiguità', () => {
  const interfaces = { lo: [{family:'IPv4',internal:true,address:'127.0.0.1'}], wifi: [{family:'IPv4',internal:false,address:'192.168.250.115'}], vpn: [{family:'IPv4',internal:false,address:'10.1.0.2'}] };
  assert.deepEqual(selectLAN(interfaces,[{dst:'default',dev:'wifi',prefsrc:'192.168.250.115',metric:600}]),{name:'wifi',ip:'192.168.250.115'});
  interfaces.wifi[0].address='192.168.250.128';
  assert.equal(selectLAN(interfaces,[{dst:'default',dev:'wifi'}]).ip,'192.168.250.128');
  assert.equal(selectLAN(interfaces,[],'wifi').name,'wifi');
  assert.throws(()=>selectLAN(interfaces,[]));
  assert.throws(()=>selectLAN({wan:[{family:'IPv4',internal:false,address:'8.8.8.8'}]},[],'wan'));
});

test('LAN HTTPS: autenticazione, sole letture, Host/Origin, nessun segreto o mutazione inoltrata', async () => {
  const dir=await mkdtemp(join(tmpdir(),'spesesmart-lan-test-'));
  let gateway, upstream;
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-noenc','-days','1','-subj','/CN=fixture','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
    const key=await readFile(join(dir,'key.pem')),cert=await readFile(join(dir,'cert.pem'));
    let forwarded=0,lastHeaders;
    upstream=createServer((req,res)=>{forwarded++;lastHeaders=req.headers;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','public');res.end(JSON.stringify({fixture:true,lanReadOnly:true}));});
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    const username='fixture-user',password='fixture-password-only',auth='Basic '+Buffer.from(username+':'+password).toString('base64');
    await saveLANCredentials(dir,{username,password});
    gateway=createLANGateway({ip:'127.0.0.1',port:3443,upstreamPort:upstream.address().port,username,password,key,cert});
    gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
    const call=(path='/',headers={},method='GET')=>new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',servername:'localhost',port:gateway.address().port,ca:cert,path,method,headers:{host:'127.0.0.1:3443',...headers}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();
    });
    for(const path of ['/','/api/archive?view=dashboard','/api/ai/usage','/_next/static/chunks/example.js']) {
      const denied=await call(path);assert.equal(denied.status,401);assert.match(denied.headers['www-authenticate'],/Basic/);assert.equal(forwarded,0);
    }
    const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-user':'?1'};
    assert.equal((await call('/',navigation)).status,401);
    assert.equal((await call('/',{...navigation,authorization:auth})).status,200);
    assert.equal((await call('/',{...navigation,authorization:auth,origin:'https://127.0.0.1:3443'})).status,200);
    assert.equal((await call('/',{authorization:auth,'sec-fetch-site':'none','sec-fetch-mode':'navigate','sec-fetch-dest':'document'})).status,200);
    assert.equal((await call('/',{authorization:'Basic invalid'})).status,401);
    const allowed=await call('/api/archive?view=dashboard',{authorization:auth,'x-forwarded-host':'evil.invalid','x-forwarded-proto':'http'});
    assert.equal(allowed.status,200);assert.equal(allowed.headers['cache-control'],'no-store');assert.equal(allowed.headers['access-control-allow-origin'],undefined);
    assert.equal(lastHeaders['x-forwarded-host'],undefined);assert.equal(lastHeaders['x-forwarded-proto'],undefined);
    assert.equal(allowed.body.includes(password),false);assert.equal(allowed.body.includes('PRIVATE KEY'),false);
    const before=forwarded;
    for(const method of ['POST','PATCH','DELETE','PUT','OPTIONS']) for(const path of ['/api/archive','/api/receipts/analyze']) assert.equal((await call(path,{authorization:auth,origin:'https://127.0.0.1:3443'},method)).status,403);
    for(const path of ['/api/archive','/api/archive?view=backup','/.env.local','/scripts/lan-server.mjs','/api/other','/_next/static/chunk.js.map','http://evil.invalid/']) assert.ok([400,403].includes((await call(path,{authorization:auth})).status));
    assert.equal((await call('/',{authorization:auth,host:'evil.invalid'})).status,421);
    assert.equal((await call('/',{authorization:auth,origin:'https://evil.invalid'})).status,403);
    assert.equal((await call('/',{authorization:auth,'sec-fetch-site':'cross-site'})).status,403);
    for (const headers of [
      {...navigation,host:'127.0.0.2:3443'}, {...navigation,host:'127.0.0.1:3444'},
      {...navigation,host:'127.0.0.1'}, {...navigation,host:'localhost:3443'},
    ]) assert.equal((await call('/',{authorization:auth,...headers})).status,421);
    for (const headers of [
      {...navigation,origin:'http://127.0.0.1:3443'}, {...navigation,origin:'https://127.0.0.1:3444'},
      {...navigation,origin:'https://evil.invalid'}, {...navigation,'sec-fetch-mode':'cors'},
      {...navigation,'sec-fetch-dest':'iframe'}, {...navigation,'sec-fetch-dest':'image'},
    ]) assert.equal((await call('/',{authorization:auth,...headers})).status,403);
    for(const path of ['/api/archive?view=dashboard','/api/ai/usage','/_next/static/chunks/example.js']) assert.equal((await call(path,{authorization:auth,...navigation})).status,403);
    for(const method of ['POST','PATCH','DELETE','PUT','OPTIONS','HEAD']) assert.equal((await call('/',{authorization:auth,...navigation},method)).status,403);
    assert.ok([400,403].includes((await call('http://127.0.0.1:3443/',{authorization:auth})).status));
    const plaintext=await new Promise(resolve=>{
      const req=httpRequest({hostname:'127.0.0.1',port:gateway.address().port,path:'/',headers:{host:'127.0.0.1:3443'}},res=>{res.resume();resolve(res.statusCode);});
      req.on('error',()=>resolve(null));req.end();
    });
    assert.notEqual(plaintext,200);
    assert.equal(forwarded,before);
    assert.equal((await call('/',{authorization:auth},'HEAD')).status,200);
    // Rotation occurs with the server stopped; the next instance accepts only the new pair.
    gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));gateway=undefined;
    const previous=await privateLANFile(join(dir,'access.json'));
    await withLANCredentialsLock(dir,()=>saveLANCredentials(dir,{username:'new-owner',password:'abcdefgh'},previous));
    const current=JSON.parse(await privateLANFile(join(dir,'access.json')));
    gateway=createLANGateway({ip:'127.0.0.1',port:3443,upstreamPort:upstream.address().port,...current,key,cert});
    gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
    assert.equal((await call('/',{authorization:auth})).status,401);
    const newAuth='Basic '+Buffer.from(`${current.username}:${current.password}`).toString('base64');
    assert.equal((await call('/',{authorization:newAuth})).status,200);
    assert.equal((await call('/api/archive',{authorization:newAuth},'DELETE')).status,403);
    assert.equal((await readFile(join(dir,'cert.pem'))).equals(cert),true);
    assert.equal((await readFile(join(dir,'key.pem'))).equals(key),true);
  } finally {gateway?.closeAllConnections();upstream?.closeAllConnections();await Promise.all([gateway&&new Promise(r=>gateway.close(r)),upstream&&new Promise(r=>upstream.close(r))]);await rm(dir,{recursive:true,force:true});}
});

test('LAN: navigazione HTTPS autenticata solo per IP e porta configurati, SAN verificato', async () => {
  const dir=await mkdtemp(join(tmpdir(),'spesesmart-lan-navigation-'));
  let gateway,upstream;
  try {
    const ip='192.168.250.115',host=`${ip}:3443`,origin=`https://${host}`;
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-noenc','-days','1','-subj','/CN=fixture','-addext',`subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost`,'-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
    const key=await readFile(join(dir,'key.pem')),cert=await readFile(join(dir,'cert.pem'));
    const certificate=new X509Certificate(cert);assert.equal(certificate.checkIP(ip),ip);assert.equal(certificate.checkIP('192.168.250.116'),undefined);
    assert.ok(Date.parse(certificate.validFrom)<=Date.now()&&Date.parse(certificate.validTo)>Date.now());
    upstream=createServer((_req,res)=>res.end('fixture-only'));upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    const username='fixture',password='abcdefgh',authorization='Basic '+Buffer.from(`${username}:${password}`).toString('base64');
    gateway=createLANGateway({ip,port:3443,upstreamPort:upstream.address().port,username,password,key,cert});
    gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
    const navigate=(headers={},method='GET',path='/')=>new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',servername:'localhost',port:gateway.address().port,ca:cert,method,path,headers:{host,authorization,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document',...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
    });
    assert.equal(await navigate(),200);assert.equal(await navigate({origin}),200);
    assert.equal(await navigate({authorization:''}),401);
    assert.equal(await navigate({host:'192.168.250.116:3443'}),421);assert.equal(await navigate({host:`${ip}:3444`}),421);
    assert.equal(await navigate({origin:`http://${host}`}),403);assert.equal(await navigate({origin:'https://external.invalid'}),403);
    assert.equal(await navigate({'sec-fetch-mode':'cors'}),403);assert.equal(await navigate({'sec-fetch-dest':'iframe'}),403);
    assert.equal(await navigate({},'GET','/api/archive?view=dashboard'),403);
    for(const method of ['POST','PATCH','DELETE'])assert.equal(await navigate({},method,'/api/archive'),403);
  } finally {gateway?.closeAllConnections();upstream?.closeAllConnections();await Promise.all([gateway&&new Promise(r=>gateway.close(r)),upstream&&new Promise(r=>upstream.close(r))]);await rm(dir,{recursive:true,force:true});}
});

test('LAN: secondo blocco server su writer e AI, senza Google/OpenAI; letture non protette respinte', async () => {
  const keys=['NODE_ENV','SPESESMART_LAN_READ_ONLY','SPESESMART_SHEETS_WRITES_ENABLED','SPESESMART_ACCESS_USER','SPESESMART_ACCESS_PASSWORD','VERCEL'];
  const before=keys.map(key=>process.env[key]);
  try {
    process.env.NODE_ENV='development';process.env.SPESESMART_LAN_READ_ONLY='true';process.env.SPESESMART_SHEETS_WRITES_ENABLED='true';delete process.env.VERCEL;
    assert.equal(googleSheetsWritesEnabled(),false);
    const req=()=>new Request('http://localhost:3000/api/archive',{method:'POST',headers:{host:'localhost:3000',origin:'http://localhost:3000'},body:'not-json'});
    for(const mutate of [POST,PATCH,DELETE]) assert.equal((await mutate(req())).status,403);
    assert.equal(aiAccess(req(),true).status,403);
    assert.equal((await GET(new Request('http://192.168.250.115:3000/api/archive'))).status,403);
    process.env.NODE_ENV='production';delete process.env.SPESESMART_ACCESS_USER;delete process.env.SPESESMART_ACCESS_PASSWORD;
    assert.equal((await GET(new Request('http://localhost:3444/api/archive'))).status,503);
    process.env.SPESESMART_ACCESS_USER='fixture';process.env.SPESESMART_ACCESS_PASSWORD='fixture-password';
    assert.equal((await GET(new Request('http://localhost:3444/api/archive'))).status,401);
  } finally {keys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];});}
});

test('LAN: avvio senza configurazione privata fallisce prima di esporre porte', async () => {
  const dir=await mkdtemp(join(tmpdir(),'spesesmart-lan-missing-'));
  try {
    const result=spawnSync(process.execPath,['scripts/lan-server.mjs'],{encoding:'utf8',env:{...process.env,SPESESMART_LAN_DIR:join(dir,'missing'),VERCEL:''}});
    assert.equal(result.status,1);assert.match(result.stderr,/lan:setup/);assert.equal(result.stdout,'');
  } finally {await rm(dir,{recursive:true,force:true});}
});
