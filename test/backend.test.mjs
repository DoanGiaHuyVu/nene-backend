import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Backend } from '../dist/backend.js';
import { ApiError, transition, validId, validPrompt } from '../dist/model.js';
import { RenderApiError } from '../dist/render.js';
import { fixture, started, approved, live, eventually } from './helpers.mjs';

const rejects = (operation,status) => assert.rejects(operation,e=>e instanceof ApiError && e.status===status);

test('one global coder; waiting approval retains the project lock but releases the global slot',async()=>{
  const f=fixture();
  const results=await Promise.allSettled(Array.from({length:20},()=>f.backend.create('Build')));
  const accepted=results.filter(r=>r.status==='fulfilled');assert.equal(accepted.length,1);
  assert.equal(f.store.taskMap.size,1);assert.equal(f.store.projectMap.size,1);
  const run=accepted[0].value;
  await eventually(()=>f.runner.work.has(run.id));
  await rejects(f.backend.create('Follow up',run.id),409);
  f.runner.complete(run.id);
  await eventually(async()=> (await f.store.getRun(run.id)).status==='waiting_for_approval' && !f.backend.workerId);
  assert.equal(f.store.agentOwner,null);
  await rejects(f.backend.create('Follow up',run.id),409);
  const independent=await started(f);assert.notEqual(independent.projectId,run.projectId);
  f.runner.fail(independent.id);
  await eventually(async()=> (await f.store.getRun(independent.id)).status==='failed');
});

test('approval is idempotent under concurrent double clicks',async()=>{
  const f=fixture(),run=await started(f);f.runner.complete(run.id);
  await eventually(async()=> (await f.store.getRun(run.id)).status==='waiting_for_approval');
  const results=await Promise.all(Array.from({length:20},()=>f.backend.approve(run.id)));
  assert.equal(f.count.push,1);assert.equal(new Set(results.map(r=>r.github.commit)).size,1);
  const p=await f.store.getProject(run.projectId);assert.equal(p.approvedRunId,run.id);assert.equal(p.activeRunId,null);
});

test('failed revisions remain isolated; a continuation from a failed run uses latest approved source',async()=>{
  const f=fixture(),root=await approved(f);await live(f,root);
  const before=await f.store.getProject(root.projectId);
  const failed=await started(f,'Break something',root.id);f.runner.fail(failed.id);
  await eventually(async()=> (await f.store.getRun(failed.id)).status==='failed' && !f.backend.workerId);
  const after=await f.store.getProject(root.projectId);
  for(const key of ['approvedCommit','approvedRunId','githubBranch','render','liveDeployment'])assert.deepEqual(after[key],before[key]);
  assert.equal(f.count.push,1);assert.equal(f.count.create,1);assert.equal(f.count.trigger,0);
  const retry=await started(f,'Try again',failed.id);assert.equal(retry.sourceTaskId,root.id);assert.equal(f.runner.sources.get(retry.id),root.id);
  f.runner.fail(retry.id);await eventually(async()=> (await f.store.getRun(retry.id)).status==='failed');
});

test('selecting an older successful run still continues the newest approved revision on the same branch',async()=>{
  const f=fixture(),root=await approved(f),second=await approved(f,root.id);
  assert.equal(second.github.branch,root.github.branch);
  const third=await started(f,'Next',root.id);assert.equal(third.sourceTaskId,second.id);assert.equal(third.sourceCommit,second.github.commit);
  f.runner.fail(third.id);await eventually(async()=> (await f.store.getRun(third.id)).status==='failed');
});

test('GitHub failure cannot promote; lost database acknowledgement reuses the pushed publication',async()=>{
  const f=fixture(),root=await approved(f),run=await started(f,'Update',root.id);
  f.runner.complete(run.id);await eventually(async()=> (await f.store.getRun(run.id)).status==='waiting_for_approval');
  f.api.publishError=new Error('Push refused');await rejects(f.backend.approve(run.id),502);
  assert.equal((await f.store.getProject(root.projectId)).approvedCommit,root.github.commit);
  assert.equal((await f.store.getRun(run.id)).status,'waiting_for_approval');
  f.store.failPromotion=true;await rejects(f.backend.approve(run.id),502);
  assert.equal((await f.store.getProject(root.projectId)).approvedCommit,root.github.commit);
  const pushed=f.count.push;const result=await f.backend.approve(run.id);assert.equal(f.count.push,pushed);
  assert.equal((await f.store.getProject(root.projectId)).approvedCommit,result.github.commit);
});

test('deployment clicks create one service and later revisions keep the service and public URL',async()=>{
  const f=fixture(),root=await approved(f);
  const results=await Promise.all(Array.from({length:20},()=>f.backend.deploy(root.id)));
  assert.equal(f.count.create,1);assert.equal(new Set(results.map(r=>r.deployment.deployId)).size,1);
  f.deploys.get(results[0].deployment.deployId).status='live';await f.backend.pollDeployments();
  const second=await approved(f,root.id);
  const update=await f.backend.deploy(second.id);
  assert.equal(f.count.create,1);assert.equal(f.count.trigger,1);assert.equal(update.deployment.serviceId,results[0].deployment.serviceId);
  assert.equal(update.deployment.url,results[0].deployment.url);
  await f.backend.deploy(second.id);assert.equal(f.count.trigger,1);
});

test('a failed Render update preserves known-good live metadata and can be retried',async()=>{
  const f=fixture(),root=await approved(f);await live(f,root);
  const previous=(await f.store.getProject(root.projectId)).liveDeployment;
  const second=await approved(f,root.id),pending=await f.backend.deploy(second.id);
  f.deploys.get(pending.deployment.deployId).status='build_failed';await f.backend.pollDeployments();
  assert.equal((await f.store.getRun(second.id)).deployment.status,'failed');
  assert.deepEqual((await f.store.getProject(root.projectId)).liveDeployment,previous);
  assert.equal((await f.store.getRun(second.id)).status,'completed');
  const retry=await f.backend.deploy(second.id);assert.equal(f.count.create,1);assert.equal(f.count.trigger,2);
  assert.equal(retry.deployment.serviceId,previous.serviceId);assert.equal(retry.deployment.url,previous.url);
});

test('definitive Render rejection releases its deployment lock for retry',async()=>{
  const f=fixture(),root=await approved(f);f.api.createError=new RenderApiError(400,'Invalid Render config');
  await rejects(f.backend.deploy(root.id),502);assert.equal((await f.store.getProject(root.projectId)).deploymentRunId,null);
  const retry=await f.backend.deploy(root.id);assert.equal(retry.deployment.status,'building');
});

test('ambiguous create/trigger responses are reconciled without duplicate POSTs',async()=>{
  const f=fixture(),root=await approved(f);f.api.loseCreateResponse=true;
  const uncertain=await f.backend.deploy(root.id);assert.equal(uncertain.deployment.status,'creating');
  await f.backend.deploy(root.id);assert.equal(f.count.create,1);
  const pending=await f.store.getRun(root.id);f.deploys.get(pending.deployment.deployId).status='live';await f.backend.pollDeployments();
  const next=await approved(f,root.id);f.api.loseTriggerResponse=true;
  await f.backend.deploy(next.id);await f.backend.deploy(next.id);assert.equal(f.count.trigger,1);
});

test('missing workers become interrupted after restart and stale run locks are cleared',async()=>{
  const f=fixture(),root=await approved(f),run=await started(f,'Update',root.id);
  const recovered=new Backend(f.store,f.runner,f.api);await recovered.recover();
  await eventually(async()=> (await f.store.getRun(run.id)).status==='interrupted' && !recovered.workerId);
  assert.equal((await f.store.getProject(root.projectId)).activeRunId,null);assert.equal(f.store.agentOwner,null);
  assert.equal((await f.store.getProject(root.projectId)).approvedCommit,root.github.commit);
  assert.ok(f.runner.cleaned.includes(run.id));
  // Simulate the original process being gone; its deferred mock cannot write again.
  f.runner.work.delete(run.id);
  const retry=await recovered.create('Retry',run.id);assert.equal(retry.sourceTaskId,root.id);
  await eventually(()=>f.runner.work.has(retry.id));f.runner.fail(retry.id);
  await eventually(async()=> (await f.store.getRun(retry.id)).status==='failed');
});

test('restart resumes a finished successful container and persisted Render monitoring',async()=>{
  const f=fixture(),root=await approved(f);const pending=await f.backend.deploy(root.id);
  f.deploys.get(pending.deployment.deployId).status='live';
  const restarted=new Backend(f.store,f.runner,f.api);await restarted.recover();
  assert.equal((await f.store.getRun(root.id)).deployment.status,'live');
  assert.equal((await f.store.getProject(root.projectId)).liveDeployment.runId,root.id);
  assert.equal(f.count.create,1);
  const run=await started(f,'Update',root.id);f.runner.work.delete(run.id);f.runner.recoveredArtifact=`/artifacts/${run.id}`;
  const restored=new Backend(f.store,f.runner,f.api);await restored.recover();
  await eventually(async()=> (await f.store.getRun(run.id)).status==='waiting_for_approval' && !restored.workerId);
  assert.equal((await f.store.getProject(root.projectId)).activeRunId,run.id);assert.equal(f.store.agentOwner,null);
});

test('legacy migration preserves newest approved branch and newest actual live service, including historic splits',async()=>{
  const f=fixture();const root=randomUUID(),second=randomUUID(),third=randomUUID(),failed=randomUUID();
  const make=(id,time,source,branch,commit,service)=>({id,prompt:'Old project',sourceTaskId:source,status:'completed',progress:'completed',writeCount:1,
    createdAt:time,updatedAt:time,containerName:`nene-task-${id}`,volumeName:`nene-volume-${id}`,artifactPath:`/artifacts/${id}`,
    github:{branch,commit,url:'https://github.test'},deployment:{provider:'render',status:'live',serviceId:service,url:`https://${service}.example`}});
  f.store.taskMap.set(root,make(root,'2026-10-01T00:00:00Z',null,'task/old','old','srv-old'));
  f.store.taskMap.set(second,make(second,'2026-10-02T00:00:00Z',root,'task/new','second','srv-new'));
  f.store.taskMap.set(third,make(third,'2026-10-03T00:00:00Z',second,'task/new','third','srv-latest'));
  f.store.taskMap.set(failed,{...make(failed,'2026-10-04T00:00:00Z',third,'bad','bad','srv-bad'),status:'failed',github:undefined,deployment:undefined});
  await f.backend.recover();const project=await f.store.getProject(root);
  assert.equal(project.approvedRunId,third);assert.equal(project.approvedCommit,'third');assert.equal(project.githubBranch,'task/new');
  assert.equal(project.render.serviceId,'srv-latest');assert.equal(project.liveDeployment.url,'https://srv-latest.example');
  await f.backend.recover();assert.deepEqual(await f.store.getProject(root),project);
  const retry=await started(f,'Retry',failed);assert.equal(retry.sourceTaskId,third);f.runner.fail(retry.id);
  await eventually(async()=> (await f.store.getRun(retry.id)).status==='failed');
});

test('validation and state machine reject invalid IDs, prompts, relationships, and operations',async()=>{
  assert.throws(()=>validId('../../etc/passwd'));assert.throws(()=>validPrompt(' '));assert.throws(()=>validPrompt('x'.repeat(20001)));
  assert.throws(()=>transition({status:'completed'},'running'));assert.throws(()=>transition({status:'running'},'completed'));
  const f=fixture(),run=await started(f);
  await rejects(f.backend.approve(run.id),409);await rejects(f.backend.deploy(run.id),409);
  await rejects(f.backend.create('Next',run.id,randomUUID()),400);
  f.runner.fail(run.id);await eventually(async()=> (await f.store.getRun(run.id)).status==='failed' && !f.backend.workerId);
  await rejects(f.backend.approve(run.id),409);await rejects(f.backend.deploy(run.id),409);await rejects(f.backend.create('Next',run.id),409);
});

test('low disk rejects admission without persisting a task or taking locks; errors are concise and redacted',async()=>{
  const f=fixture();f.runner.diskFull=true;await rejects(f.backend.create('Build'),507);assert.equal(f.store.taskMap.size,0);assert.equal(f.store.agentOwner,null);
  f.runner.diskFull=false;const run=await started(f);f.runner.fail(run.id);
  await eventually(async()=> (await f.store.getRun(run.id)).status==='failed');
  const stored=await f.store.getRun(run.id);assert.ok(!stored.internalError.includes('model-secret'));
  const { publicRun }=await import('../dist/model.js');assert.ok(!('internalError' in publicRun(stored)));
  assert.ok(stored.error.length<200);
});
