// Execute the real launcher in a VM. All hardware, storage, child processes and
// listeners are synthetic; no production-only fixture switch exists in the app.
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { configuredTailscaleHostname, TAILSCALE_ADAPTER_PORT } from '../../scripts/tailscale-ingress.mjs';

async function run(enabled, failBind = false, accountsMode = false) {
  const events = [], bindings = [], logs = [], data = '/srv/spesesmart/data', hostname = 'spesesmart-pi.tailfixture.ts.net';
  let gateway, adapter, child, gatewayOptions, adapterOptions, childOptions, proof;
  class Edge extends EventEmitter {
    constructor(name) { super(); this.name = name; this.closed = false; }
    listen(port, ip) {
      bindings.push({ name:this.name, port, ip });
      queueMicrotask(() => this.emit(this.name === 'adapter' && failBind ? 'error' : 'listening', Error('synthetic bind failure')));
    }
    beginDrain() { events.push(this.name+':drain'); }
    waitForDrain() { return new Promise(resolve => setTimeout(() => { events.push(this.name+':drained'); resolve(true); }, 5)); }
    close() { if (!this.closed) { this.closed = true; queueMicrotask(() => this.emit('close')); } }
    closeAllConnections() {}
  }
  const fakeProcess = Object.assign(new EventEmitter(), {
    platform:'linux',arch:accountsMode?'x64':'arm64',argv:['/synthetic/node','/srv/spesesmart/app/scripts/lan-server.mjs',accountsMode?'accounts':'pi-production'],
    cwd:()=>'/srv/spesesmart/app',execPath:'/synthetic/node',pid:1234,getuid:process.getuid,
    env:{ NODE_ENV:'production',SPESESMART_LAN_DIR:data+'/lan',...(accountsMode?{SPESESMART_ACCOUNT_DIR:'/synthetic-accounts',OPENAI_API_KEY:'must-not-inherit',GOOGLE_SERVICE_ACCOUNT_JSON:'must-not-inherit',NODE_OPTIONS:'must-not-inherit'}:{}),...(enabled?{SPESESMART_PI_TAILSCALE_HOSTNAME:hostname}:{}) },
    kill:()=>{ throw Error('Unexpected forced kill'); },
  });
  const fsPromises = {
    lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:process.getuid(),mode:0o700}),
    realpath:async name=>name, access:async()=>{}, unlink:async()=>{events.push('proof:removed');},
    ...Object.fromEntries(['mkdir','mkdtemp','rename','chmod'].map(name=>[name,async()=>{throw Error('Unexpected filesystem mutation');}]))
  };
  const modules = {
    'node:os':{networkInterfaces:()=>({wlan0:[{family:'IPv4',internal:false,address:'192.168.250.91'}]}),homedir:()=>'/synthetic-home'},
    'node:path':path,'node:url':await import('node:url'),'node:fs':{existsSync:name=>!path.basename(name).startsWith('.env')},'node:fs/promises':fsPromises,
    'node:crypto':{...crypto,X509Certificate:accountsMode?class { checkIP(ip){return ip;} validTo='2099-01-01'; validFrom='2020-01-01'; fingerprint256='fixture'; }:crypto.X509Certificate},
    'node:tls':{createSecureContext:()=>{assert.equal(accountsMode,true);}},
    'node:readline/promises':{createInterface:()=>{throw Error('Unexpected interactive setup');}},
    'node:stream':{Writable:class {}},'node:events':await import('node:events'),
    'node:child_process':{
      execFileSync:(command)=>command==='ip'?JSON.stringify([{dst:'default',dev:'wlan0'}]):JSON.stringify({pending:0,unknownAI:0,aiDirectory:data+'/ai',updateDirectory:data+'/sheets-updates'}),
      spawn:(_command,args,options)=>{
        assert.equal(args[1],accountsMode?'dev':'start');assert.deepEqual(Array.from(args.slice(2,6)),['--hostname','127.0.0.1','--port','3444']);
        childOptions=options;
        child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:{resume(){}},exitCode:null,signalCode:null,pid:1235});
        child.kill=signal=>{events.push('backend:'+signal);queueMicrotask(()=>{child.exitCode=0;child.signalCode=signal;child.emit('exit',0,signal);});};
        setTimeout(()=>child.stdout.emit('data',Buffer.from('Ready in 1ms')),5);return child;
      }
    },
    './lan-gateway.mjs':{
      selectLAN:()=>({name:'wlan0',ip:'192.168.250.91'}),
      createLANGateway:options=>{gatewayOptions=options;gateway=new Edge('gateway');return gateway;}
    },
    './tailscale-ingress.mjs':{configuredTailscaleHostname,TAILSCALE_ADAPTER_PORT,
      createTailscaleAdapter:options=>{adapterOptions=options;adapter=new Edge('adapter');return adapter;}},
    './lan-credentials.mjs':{privateLANFile:async name=>{if(accountsMode)assert.notEqual(path.basename(name),'access.json');return JSON.stringify({username:'fixture',password:'synthetic-password'});},
      validateLANCredentials:x=>x,withLANCredentialsLock:async(_dir,work)=>work(),saveLANCredentials:async()=>{throw Error('Unexpected credentials write');}},
    './home-runtime.mjs':{withHomeWriterLock:async work=>{try{return await work(73,'/synthetic-runtime');}finally{events.push('lock:released');}},
      writeHomeProof:async(_dir,value)=>{proof=value;return data+'/runtime/synthetic-proof.json';}},
    './host-policy.mjs':{requireHostRole:role=>assert.equal(role,'raspberry')},
    './accounts.mjs':{accountDirectory:()=>'/synthetic-accounts',readAccounts:async()=>{assert.equal(accountsMode,true);return {accounts:[]};}},
    './pi-production-profile.mjs':{PI_DATA:data,PI_CA:'synthetic-ca-pin',privatePiDirectory:async()=>{},
      preparePiProduction:async()=>{events.push('pi:checked');},preparePiSetup:async()=>{throw Error('Unexpected setup');},
      piProductionTLS:async()=>({key:'synthetic-key',cert:'synthetic-leaf',ca:'synthetic-ca',certificate:{fingerprint256:'synthetic-fingerprint'}})},
    '@next/env':{default:{loadEnvConfig:()=>{throw Error('Unexpected project env load');}}}
  };
  const context=createContext({process:fakeProcess,Buffer,setTimeout,clearTimeout,queueMicrotask,
    console:{log:message=>{logs.push(message);if(message.startsWith('Apri https:'))queueMicrotask(()=>fakeProcess.emit('SIGTERM'));},error:message=>logs.push(message)}});
  const source=readFileSync(new URL('../../scripts/lan-server.mjs',import.meta.url),'utf8');
  // Export only the completion promise in this isolated VM, without changing the launcher file.
  const entrypoint=/^if \(process\.argv\[1\][^\n]*\) main\(\)\.catch\(error =>/m;
  assert.match(source,entrypoint);
  const launcherModule=new SourceTextModule(source.replace(entrypoint,'export const completion = main().catch(error =>'),{context});
  await launcherModule.link(specifier=>{
    const values=modules[specifier];if(!values)throw Error('Unexpected import '+specifier);
    return new SyntheticModule(Object.keys(values),function(){for(const[name,value]of Object.entries(values))this.setExport(name,value);},{context});
  });
  await launcherModule.evaluate();
  await launcherModule.namespace.completion;
  if(failBind){assert.equal(fakeProcess.exitCode,1);assert.ok(gateway.closed&&adapter.closed);assert.notEqual(child.exitCode,null);}
  else{
    assert.equal(fakeProcess.exitCode,undefined);
    assert.equal(events.at(-1),'lock:released');
    assert.ok(events.indexOf('backend:SIGTERM')>events.indexOf('gateway:drained'));
    if(enabled)assert.ok(events.indexOf('backend:SIGTERM')>events.indexOf('adapter:drained'));
  }
  assert.deepEqual(bindings[0],{name:'gateway',port:3443,ip:'192.168.250.91'});
  assert.equal(childOptions.stdio[3],73);
  assert.equal(childOptions.env.SPESESMART_LAN_ORIGIN,'https://192.168.250.91:3443');
  if(accountsMode){
    assert.equal(proof,undefined);
    assert.equal(gatewayOptions.accountsDirectory,'/synthetic-accounts');
    assert.equal(childOptions.env.SPESESMART_MULTIUSER,'true');
    assert.equal(childOptions.env.SPESESMART_SHEETS_WRITES_ENABLED,'false');
    assert.equal(childOptions.env.SPESESMART_ACCOUNT_DIR,'/synthetic-accounts');
    for(const name of ['OPENAI_API_KEY','GOOGLE_SERVICE_ACCOUNT_JSON','NODE_OPTIONS'])assert.equal(childOptions.env[name],undefined);
  }else assert.equal(proof.capability,gatewayOptions.capability);
  if(enabled){
    assert.deepEqual(bindings[1],{name:'adapter',port:3445,ip:'127.0.0.1'});
    assert.equal(adapterOptions.ip,'192.168.250.91');assert.equal(adapterOptions.port,3443);
    assert.equal(adapterOptions.ca,'synthetic-ca');assert.equal(adapterOptions.expectedCA,'synthetic-ca-pin');
    assert.equal(gatewayOptions.tailscale.capability,adapterOptions.capability);
    assert.notEqual(adapterOptions.capability,gatewayOptions.capability);
    assert.ok(!Object.values(childOptions.env).includes(adapterOptions.capability));
    assert.ok(logs.every(line=>!line.includes(adapterOptions.capability)));
  }else{assert.equal(adapter,undefined);assert.equal(gatewayOptions.tailscale,undefined);assert.equal(bindings.length,1);}
}
await run(false);await run(true);await run(true,true);await run(false,false,true);
console.log('Launcher production: LAN invariata, adattatore loopback, capability separata, drain e fallimento bind verificati in VM.');
