import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DockerRunner } from '../dist/runner.js';

test('Docker runner restricts secrets/resources, strips caches, and cleans success, failure and missing workers',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nene-runner-test-'));
  const log=path.join(root,'commands.jsonl'),mode=path.join(root,'mode');
  const before=process.env.PATH;
  const script=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),log=${JSON.stringify(log)},modeFile=${JSON.stringify(mode)};
fs.appendFileSync(log,JSON.stringify({args,env:{model:process.env.DO_MODEL_KEY,mongo:process.env.MONGODB_URI,render:process.env.RENDER_API_KEY,token:process.env.NENE_API_TOKEN}})+'\\n');
let mode='ok';try{mode=fs.readFileSync(modeFile,'utf8')}catch{}
if(args[0]==='inspect'){console.error('No such object');process.exit(1)}
if(args[0]==='run'&&args.includes('--print')){
 console.log(JSON.stringify({type:'tool:requested',payload:{calls:[{name:'write',input:{path:'app/index.js'}}]}}));
 if(mode==='fail')process.exit(9);
}
if(args[0]==='cp'){
 const dst=args[2];fs.mkdirSync(path.join(dst,'app','node_modules'),{recursive:true});
 fs.writeFileSync(path.join(dst,'app','index.js'),'valid');fs.writeFileSync(path.join(dst,'app','.env'),'secret');
 fs.writeFileSync(path.join(dst,'app','.env.example'),'PLACEHOLDER');fs.writeFileSync(path.join(dst,'app','node_modules','dep'),'cache');
 fs.symlinkSync('/etc/passwd',path.join(dst,'app','outside'));
}
`;
  try{
    await fs.writeFile(path.join(root,'docker'),script,{mode:0o755});process.env.PATH=root+path.delimiter+before;
    process.env.MONGODB_URI='host-only-mongo';process.env.RENDER_API_KEY='host-only-render';process.env.NENE_API_TOKEN='host-only-token';
    const runner=new DockerRunner(root,'model-key');
    const make=()=>{const id=randomUUID();return{id,projectId:id,containerName:`nene-task-${id}`,volumeName:`nene-volume-${id}`,prompt:'Build'};};
    const run=make(),events=[];await runner.checkCapacity();
    const artifact=await runner.run(run,undefined,async(type,data)=>events.push({type,data}));
    assert.equal(await runner.hasArtifact({...run,artifactPath:artifact}),true);
    const files=await fs.readdir(path.join(artifact,'app'));assert.deepEqual(files.sort(),['.env.example','index.js']);
    let commands=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    const coding=commands.find(c=>c.args.includes('--print'));
    assert.equal(coding.env.model,'model-key');assert.equal(coding.env.mongo,undefined);assert.equal(coding.env.render,undefined);assert.equal(coding.env.token,undefined);
    for(const flag of ['--read-only','--memory=512m','--memory-swap=640m','--cpus=0.75','--pids-limit=128','--cap-drop=ALL','--security-opt=no-new-privileges'])assert.ok(coding.args.includes(flag));
    assert.ok(!coding.args.join(' ').includes('docker.sock'));assert.ok(!coding.args.includes('--tmpfs'));
    const allowedMounts=coding.args.filter((_,i,a)=>a[i-1]==='--mount');assert.equal(allowedMounts.length,2);
    assert.ok(allowedMounts.every(m=>m.includes('target=/workspace')||m.includes('/seed/backboard-config.json,readonly')));
    const continuation=make();await runner.run(continuation,{...run,artifactPath:artifact},async()=>{});
    await fs.writeFile(mode,'fail');const failed=make();await assert.rejects(runner.run(failed,undefined,async()=>{}),/code 9/);
    const missing=make();assert.equal(await runner.recover(missing,async()=>{}),undefined);
    commands=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    for(const command of commands.filter(c=>c.args.includes('-c')))await promisify(execFile)('sh',['-n','-c',command.args.at(-1)]);
    for(const r of [run,continuation,failed,missing]){
      assert.ok(commands.some(c=>c.args[0]==='rm'&&c.args.includes(r.containerName)));
      assert.ok(commands.some(c=>c.args[0]==='volume'&&c.args[1]==='rm'&&c.args.includes(r.volumeName)));
    }
    assert.ok(events.some(e=>e.type==='backboard:event'));
  }finally{
    process.env.PATH=before;delete process.env.MONGODB_URI;delete process.env.RENDER_API_KEY;delete process.env.NENE_API_TOKEN;
    await fs.rm(root,{recursive:true,force:true});
  }
});
