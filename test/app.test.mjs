import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../dist/app.js';
import { fixture, eventually } from './helpers.mjs';

test('HTTP compatibility, input errors, authentication, and complete persisted task responses',async()=>{
  const f=fixture();const server=createApp(f.backend,'test-token').listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(url,body)=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    assert.equal((await fetch(base+'/health')).status,200);assert.equal((await fetch(base+'/tasks/not-an-id')).status,401);
    assert.equal((await request('/tasks/not-an-id')).status,400);assert.equal((await request('/tasks',{prompt:''})).status,400);
    assert.equal((await request('/tasks',{prompt:'Build',projectId:'invalid'})).status,400);
    const created=await request('/tasks',{prompt:'Build'});assert.equal(created.status,202);const run=await created.json();
    await eventually(()=>f.runner.work.has(run.id));
    assert.equal((await request(`/tasks/${run.id}/approve`,{})).status,409);
    assert.equal((await request('/tasks',{prompt:'Concurrent'})).status,409);
    f.runner.complete(run.id);await eventually(async()=> (await f.store.getRun(run.id)).status==='waiting_for_approval');
    const approved=await (await request(`/tasks/${run.id}/approve`,{})).json();
    const persisted=await (await request(`/tasks/${run.id}`)).json();assert.deepEqual(persisted.github,approved.github);
    const ctrl=new AbortController();
    const stream=await fetch(base+`/tasks/${run.id}/events`,{headers:{Authorization:'Bearer test-token','Last-Event-ID':'0'},signal:ctrl.signal});
    const chunk=await stream.body.getReader().read();assert.match(new TextDecoder().decode(chunk.value),/id: 1\ndata:/);ctrl.abort();
    const invalid=await fetch(base+'/tasks',{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:'bad json'});
    assert.equal(invalid.status,400);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.backend.shutdown();}
});
