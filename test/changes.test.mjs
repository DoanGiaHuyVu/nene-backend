import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ChangesReader } from '../dist/changes.js';
import { Backend } from '../dist/backend.js';
import { createApp } from '../dist/app.js';
import { fixture } from './helpers.mjs';

async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nene-changes-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const f=fixture();
  const reader=new ChangesReader(root), backend=new Backend(f.store,f.runner,f.api,[],reader);
  const projectId=randomUUID();
  async function run(status='waiting_for_approval',source) {
    const id=randomUUID(),artifactPath=path.join(root,'artifacts',id);
    await fs.mkdir(path.join(artifactPath,'app'),{recursive:true});
    const r={id,projectId,status,artifactPath,sourceTaskId:source?.id,sourceCommit:source?.github?.commit};
    if(status==='completed')r.github={commit:'commit-'+id};
    f.store.taskMap.set(id,r); return r;
  }
  async function write(run,name,data) {
    const location=path.join(run.artifactPath,'app',name);
    await fs.mkdir(path.dirname(location),{recursive:true});await fs.writeFile(location,data);return location;
  }
  return {...f,root,reader,backend,run,write};
}

test('initial build reports added text and empty files, excludes secrets/caches and changes no state',async t=>{
  const f=await setup(t),r=await f.run();
  await f.write(r,'index.js','<h1>Hello</h1>\n');await f.write(r,'empty.txt','');
  for(const name of ['.env','.env.production','.env.example','x.log','.DS_Store','node_modules/package/x.js','.git/config','dist/x','build/x','coverage/x','tmp/x','.next/x','.backboard/x'])await f.write(r,name,'secret');
  const state=structuredClone([...f.store.taskMap]);
  const diff=await f.backend.getChanges(r.id);
  assert.equal(diff.initialBuild,true);assert.equal(diff.summary.filesChanged,2);
  assert.equal(diff.summary.additions,1);assert.equal(diff.summary.countsComplete,true);
  assert.deepEqual(diff.files.map(x=>x.status),['added','added']);
  assert.match(diff.files.find(x=>x.path==='app/index.js').patch,/\+<h1>Hello<\/h1>/);
  assert.ok(!JSON.stringify(diff).includes('secret'));
  assert.deepEqual([...f.store.taskMap],state);assert.equal(f.count.push,0);assert.equal(f.count.create,0);
  assert.equal(await fs.readFile(path.join(r.artifactPath,'app/index.js'),'utf8'),'<h1>Hello</h1>\n');
});

test('continuation uses its recorded approved baseline after newer approvals, with exact line counts',async t=>{
  const f=await setup(t),base=await f.run('completed'),r=await f.run('waiting_for_approval',base),newer=await f.run('completed');
  f.store.projectMap.set(r.projectId,{id:r.projectId,approvedRunId:newer.id});
  await f.write(base,'index.js','same\nold\nsame\n');await f.write(r,'index.js','same\nnew\nsame\n');
  await f.write(base,'deleted.txt','deleted\n');await f.write(r,'added.txt','added\n');
  await f.write(base,'unchanged','equal');await f.write(r,'unchanged','equal');
  const diff=await f.backend.getChanges(r.id);
  assert.equal(diff.baseTaskId,base.id);assert.equal(diff.initialBuild,false);
  assert.deepEqual(diff.summary,{filesChanged:3,additions:2,deletions:2,countsComplete:true});
  assert.deepEqual(diff.files.map(x=>x.status),['added','deleted','modified']);
  assert.match(diff.files.at(-1).patch,/-old\n\+new/);
  r.status='completed';r.github={commit:'new'};
  assert.equal((await f.backend.getChanges(r.id)).baseTaskId,base.id);
});

test('failed, interrupted and running tasks and unapproved/missing/mismatched baselines are rejected',async t=>{
  const f=await setup(t);
  for(const status of ['running','failed','interrupted','queued']) {
    const r=await f.run(status);await assert.rejects(f.backend.getChanges(r.id),e=>e.status===409);
  }
  const base=await f.run('failed'),r=await f.run('waiting_for_approval',base);
  await assert.rejects(f.backend.getChanges(r.id),e=>e.status===409);
  base.status='completed';base.github={commit:'abc'};r.sourceCommit='wrong';
  await assert.rejects(f.backend.getChanges(r.id),e=>e.status===409);
  r.sourceCommit='abc';base.projectId=randomUUID();await assert.rejects(f.backend.getChanges(r.id),e=>e.status===409);
  f.store.taskMap.delete(base.id);await assert.rejects(f.backend.getChanges(r.id),e=>e.status===409);
  await assert.rejects(f.backend.getChanges('bad-id'),e=>e.status===400);
  await assert.rejects(f.backend.getChanges(randomUUID()),e=>e.status===404);
});

test('missing or redirected application directories never become an empty baseline',async t=>{
  const f=await setup(t),base=await f.run('completed'),r=await f.run('waiting_for_approval',base);
  await fs.rm(path.join(base.artifactPath,'app'),{recursive:true});
  await assert.rejects(f.backend.getChanges(r.id),e=>e.status===409);
  await fs.symlink(os.tmpdir(),path.join(base.artifactPath,'app'));
  await assert.rejects(f.backend.getChanges(r.id),e=>e.status===409);
  r.sourceTaskId=undefined;r.artifactPath=os.tmpdir();await assert.rejects(f.backend.getChanges(r.id),e=>e.status===409);
});

test('binary and large files have explicit incomplete counts',async t=>{
  const f=await setup(t),r=await f.run();
  await f.write(r,'image.png',Buffer.from([0,255,10]));
  await f.write(r,'huge.txt','x'.repeat(300*1024));
  const diff=await f.backend.getChanges(r.id);
  assert.equal(diff.files.find(x=>x.path==='app/image.png').binary,true);
  assert.equal(diff.files.find(x=>x.path==='app/huge.txt').reason,'large_file');
  assert.equal(diff.summary.countsComplete,false);assert.equal(diff.truncated,true);
});

test('symlinks are reviewed as link text, never dereferenced; executable-only changes remain visible',async t=>{
  const f=await setup(t),base=await f.run('completed'),r=await f.run('waiting_for_approval',base);
  const secret=path.join(f.root,'private');await fs.writeFile(secret,'DO_NOT_EXPOSE');
  await fs.symlink(secret,path.join(r.artifactPath,'app','link'));
  await fs.symlink(f.root,path.join(r.artifactPath,'app','linked-directory'));
  await f.write(base,'script.sh','echo hello\n');const script=await f.write(r,'script.sh','echo hello\n');await fs.chmod(script,0o755);
  const diff=await f.backend.getChanges(r.id);
  assert.equal(diff.summary.filesChanged,3);assert.ok(!JSON.stringify(diff).includes('DO_NOT_EXPOSE'));
  assert.equal(diff.files.find(x=>x.path==='app/link').symlink,true);
  assert.match(diff.files.find(x=>x.path==='app/script.sh').patch,/File mode/);
});

test('patch and total response limits are enforced, partial counts and omitted files are explicit',async t=>{
  const f=await setup(t),r=await f.run();
  for(let i=0;i<8;i++)await f.write(r,`${i}.txt`,('quote"slash\\line '+i+'\n').repeat(10_000));
  const diff=await f.backend.getChanges(r.id);
  assert.equal(diff.summary.filesChanged,8);assert.equal(diff.truncated,true);assert.equal(diff.summary.countsComplete,false);
  assert.ok(diff.files.some(x=>x.reason==='response_limit'));
  for(const file of diff.files)assert.ok(Buffer.byteLength(file.patch??'')<=50*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(diff))<=200*1024);
  const small=await f.run();for(let i=0;i<305;i++)await f.write(small,`${i}.txt`,'');
  const limited=await f.backend.getChanges(small.id);
  assert.equal(limited.summary.filesChanged,305);assert.equal(limited.files.length,300);assert.equal(limited.omittedFiles,5);
  assert.equal(limited.summary.countsComplete,false);
});

test('oversized total reads and directory depth fail safely; single review admission releases after error',async t=>{
  const f=await setup(t),r=await f.run();
  const file=await f.write(r,'huge','');await fs.truncate(file,65*1024*1024);
  await assert.rejects(f.backend.getChanges(r.id),e=>e.status===413);
  await fs.rm(file);
  await f.write(r,Array(52).fill('deep').join('/')+'/file','text');
  await assert.rejects(f.backend.getChanges(r.id),e=>e.status===413);
  const clean=await f.run();await f.write(clean,'x','line\n');
  const first=f.backend.getChanges(clean.id);
  await assert.rejects(f.backend.getChanges(clean.id),e=>e.status===429);
  assert.equal((await first).summary.filesChanged,1);
  assert.equal((await f.backend.getChanges(clean.id)).summary.filesChanged,1);
});

test('authenticated changes route is read-only, uncached, and returns concise errors',async t=>{
  const f=await setup(t),r=await f.run();await f.write(r,'x','line\n');
  const server=createApp(f.backend,'review-token').listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/tasks/${r.id}/changes`;
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{Authorization:'Bearer review-token'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).taskId,r.id);assert.equal(f.count.push,0);
  r.status='failed';assert.equal((await fetch(url,{headers:{Authorization:'Bearer review-token'}})).status,409);
});
