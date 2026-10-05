import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoStore } from '../dist/db.js';
import { newProject } from '../dist/model.js';

const uri=process.env.NENE_TEST_MONGODB_URI;
test('real MongoDB transactions serialize admission, promotion and live deployment metadata',{skip:!uri},async()=>{
  const database=`nene_test_${randomUUID().replaceAll('-','').slice(0,20)}`;
  const store=new MongoStore(uri,database);const cleanup=new MongoClient(uri,{maxPoolSize:1});
  try{
    await store.connect();const now=new Date().toISOString();
    const make=()=>{const id=randomUUID();return {id,projectId:id,prompt:'Test',status:'queued',progress:'planning',writeCount:0,
      createdAt:now,updatedAt:now,containerName:`nene-task-${id}`,volumeName:`nene-volume-${id}`,eventSeq:0,schemaVersion:1};};
    const candidates=Array.from({length:8},make);
    const results=await Promise.allSettled(candidates.map(r=>store.reserveRun(r,newProject(r.id,r.prompt,now))));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    let run=candidates[results.findIndex(r=>r.status==='fulfilled')];
    const all=[];for await(const task of store.runs())all.push(task);assert.equal(all.length,1);
    const duplicate={...make(),projectId:run.projectId};await assert.rejects(store.reserveRun(duplicate),/active run/);
    await store.patchRun(run.id,{status:'waiting_for_approval',artifactPath:`/artifacts/${run.id}`});
    await store.releaseRun(run,true);run=await store.getRun(run.id);
    assert.equal(run.sourceTaskId,undefined);
    assert.equal((await store.getProject(run.projectId)).activeRunId,run.id);
    const pub={branch:`task/${run.id.slice(0,8)}`,commit:'a'.repeat(40),url:'https://github.test'};
    await store.promote(run,pub);
    assert.equal((await store.getRun(run.id)).status,'completed');
    assert.equal((await store.getProject(run.projectId)).approvedCommit,pub.commit);
    run=await store.getRun(run.id);
    const deployment={provider:'render',status:'creating'};await store.claimDeployment(run,deployment);
    await assert.rejects(store.claimDeployment(run,deployment),/in progress/);
    await store.recordDeployment(run,{provider:'render',status:'live',serviceId:'srv-stable',url:'https://stable.example',deployId:'dep-good'});
    const before=(await store.getProject(run.projectId)).liveDeployment;
    await store.claimDeployment(run,deployment);
    await store.recordDeployment(run,{provider:'render',status:'failed',serviceId:'srv-stable',url:'https://stable.example',error:'Test failure'});
    assert.deepEqual((await store.getProject(run.projectId)).liveDeployment,before);
    assert.equal((await store.getProject(run.projectId)).deploymentRunId,null);
    const events=await Promise.all(Array.from({length:8},(_,i)=>store.appendEvent(run.id,'test:event',{i})));
    assert.equal(new Set(events.map(e=>e.seq)).size,8);
    const replay=[];for await(const e of store.events(run.id,2))replay.push(e);assert.equal(replay.length,6);
  }finally{
    await store.close();
    try { await cleanup.connect(); await cleanup.db(database).dropDatabase(); }
    finally { await cleanup.close(); }
  }
});
