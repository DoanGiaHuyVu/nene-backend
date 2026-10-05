import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { fixture, started, eventually, live } from './helpers.mjs';

process.env.DO_MODEL_KEY = 'private-model-key-for-test';
const { safeAttributes, sanitizeEvent, sanitizeLog } = await import('../dist/telemetry-privacy.js');
const { AgentTelemetry, DETAIL_LIMITS, usageValues, operation } = await import('../dist/telemetry.js');
const envelopes = [];
Sentry.init({ dsn: 'https://public@localhost/1', tracesSampleRate: 1, traceLifecycle: 'stream', defaultIntegrations: false,
  integrations: [Sentry.spanStreamingIntegration()], transport: () => ({
    send: async envelope => { envelopes.push(structuredClone(envelope)); return { statusCode: 200 }; }, flush: async () => true,
  }), beforeSend: sanitizeEvent, beforeSendLog: sanitizeLog,
  beforeSendSpan: span => ({ ...span, attributes: safeAttributes(span.attributes) }),
  dataCollection: { userInfo: false, httpHeaders: false, httpBodies: [], cookies: false, urlQueryParams: false, genAI: { inputs: false, outputs: false }, frameContextLines: 0, stackFrameVariables: false },
});
after(async () => { await Sentry.close(1000); delete process.env.DO_MODEL_KEY; });
const spans = () => envelopes.flatMap(([,items]) => items.filter(([header])=>header.type==='span').flatMap(([,payload])=>payload.items));
const attributes = span => Object.fromEntries(Object.entries(span.attributes).map(([key, value])=>[key,value.value]));
const event = (type, payload, sequence) => ({type,payload,sequence,session_id:'fixture-session'});

test('real SDK traces initial, continuation, approval, same-service redeploy, and coding failure without raw content', async () => {
  const f=fixture();
  const initial=await started(f,'private-user-prompt');
  const emit=f.runner.work.get(initial.id).emit;
  await emit('backboard:event',event('turn:start',{turnId:'turn'},1));
  await emit('backboard:event',event('usage',{usage:{inputTokens:1000,outputTokens:100,cachedTokens:100,provider:'digitalocean',model:'gemma-4-31B-it'}},2));
  await emit('backboard:event',event('tool:requested',{calls:[{id:'cmd',name:'execute',input:{command:'npm test; echo private-model-key-for-test'}}]},3));
  await emit('backboard:event',event('tool:start',{toolCallId:'cmd',name:'execute',inputSummary:'private-user-prompt'},4));
  await emit('backboard:event',event('tool:result',{toolCallId:'cmd',name:'execute',agentOutput:'private-stdout\nexit code: 0'},5));
  f.runner.complete(initial.id);
  await eventually(async()=> (await f.store.getRun(initial.id)).telemetry);
  const approved=await f.backend.approve(initial.id);
  const deployed=await live(f,approved);
  const update=await started(f,'private-generated-source',initial.id);
  f.runner.complete(update.id);
  await eventually(async()=> (await f.store.getRun(update.id)).telemetry);
  const second=await live(f,await f.backend.approve(update.id));
  assert.equal(second.deployment.serviceId,deployed.deployment.serviceId);
  assert.equal(second.github.branch,approved.github.branch);
  const failure=await started(f,'private-user-prompt',second.id); f.runner.fail(failure.id);
  await eventually(async()=> (await f.store.getRun(failure.id)).telemetry);
  await Sentry.flush(1000);
  const observed=spans();
  const roots=observed.filter(s=>attributes(s)['gen_ai.operation.type']==='agent');
  assert.equal(roots.length,3);
  assert.equal(new Set(roots.map(s=>s.trace_id)).size,3);
  assert.equal(roots.filter(s=>attributes(s)['nene.run.type']==='continuation').length,2);
  assert.equal(roots.find(s=>attributes(s)['nene.run.id']===failure.id).status,'error');
  const root=roots.find(s=>attributes(s)['nene.run.id']===initial.id);
  assert.equal(attributes(root)['gen_ai.usage.total_tokens'],1100);
  assert.equal(attributes(root)['nene.verification.passed'],1);
  const tool=observed.find(s=>s.name==='execute_tool verify test');
  assert.equal(tool.parent_span_id,root.span_id);
  for(const name of ['ne-ne approval','ne-ne GitHub publish','ne-ne Render create service','ne-ne Render redeploy','ne-ne Render deployment result']) assert.ok(observed.some(s=>s.name===name),name);
  assert.notEqual(observed.find(s=>s.name==='ne-ne approval').trace_id,root.trace_id);
  const encoded=JSON.stringify(envelopes);
  for(const forbidden of ['private-user-prompt','private-generated-source','private-stdout','private-model-key-for-test']) assert.ok(!encoded.includes(forbidden),forbidden);
  await f.backend.shutdown();
});

test('runaway streams retain totals but cap detailed SDK spans and pending maps; no timeout',async()=>{
  const id=randomUUID(),run={id,projectId:id,createdAt:new Date().toISOString(),status:'running',progress:'coding',writeCount:0};
  let time=Date.now(),seq=0;
  const observer=new AgentTelemetry(run,()=>time);
  await observer.trace(async()=>{
    for(let i=0;i<1000;i++){
      observer.observe(event('turn:start',{},++seq));
      time+=10;
      observer.observe(event('usage',{usage:{inputTokens:100,outputTokens:10,cachedTokens:20,provider:'digitalocean',model:'gemma-4-31B-it'}},++seq));
      observer.observe(event('tool:start',{toolCallId:`tool-${i}`,name:'edit',inputSummary:'private-generated-source'},++seq));
      for(let j=0;j<5;j++) observer.observe(event('tool:pending',{detail:'private-stdout'},++seq));
      time+=10;
      observer.observe(event('tool:result',{toolCallId:`tool-${i}`,name:'edit'},++seq));
    }
    run.status='waiting_for_approval';
  });
  const summary=observer.summary();
  assert.equal(summary['nene.tools.total'],1000);
  assert.equal(summary['gen_ai.usage.total_tokens'],110000);
  assert.equal(summary['nene.telemetry.tool_spans'],DETAIL_LIMITS.tools);
  assert.equal(summary['nene.telemetry.model_spans'],DETAIL_LIMITS.models);
  assert.equal(summary['nene.telemetry.truncated'],true);
  assert.equal(observer.tools.size,0);assert.equal(observer.requested.size,0);
  await Sentry.flush(1000);
  assert.equal(spans().filter(s=>attributes(s)['nene.run.id']===id).length,81);
});

test('cache tokens are a subset; unknown/missing usage is explicit; recovered duplicate events are not added twice',async()=>{
  assert.ok(Math.abs(usageValues({inputTokens:1000,outputTokens:100,cachedTokens:100,provider:'digitalocean',model:'gemma-4-31B-it'}).cost-.0002156)<1e-12);
  assert.equal(usageValues({inputTokens:1000,outputTokens:100,totalTokens:999999}).total,1100);
  assert.equal(usageValues({inputTokens:10,outputTokens:1,cachedTokens:11}),undefined);
  assert.equal(usageValues({inputTokens:-1,outputTokens:1}),undefined);
  assert.equal(usageValues({inputTokens:1,outputTokens:1,model:'unknown'}).known,false);
  const id=randomUUID(),observer=new AgentTelemetry({id,projectId:id,createdAt:new Date().toISOString()});
  const usage=event('usage',{usage:{inputTokens:10,outputTokens:1}},1);
  observer.observe(usage,false);observer.observe(usage);
  observer.observe(event('usage',{usage:{}},2));
  assert.equal(observer.summary()['gen_ai.usage.total_tokens'],11);
  assert.equal(observer.summary()['nene.usage.invalid_events'],1);
  assert.equal(observer.summary()['nene.usage.unknown_model_events'],1);
});

test('verification needs an exit code, missing results stay unknown, and SDK transport failure never repeats a side effect',async()=>{
  const id=randomUUID(),run={id,projectId:id,createdAt:new Date().toISOString(),status:'running',progress:'testing'};
  const observer=new AgentTelemetry(run);let seq=0;
  await observer.trace(async()=>{
    for(const [tool,result] of [['unknown',{}],['failed',{agentOutput:'exit code: 2'}],['title-success',{title:'Success'}],['title-failure',{title:'Failed: private-stdout'}]]){
      observer.observe(event('tool:start',{toolCallId:tool,name:'execute',inputSummary:'npm test'},++seq));
      observer.observe(event('tool:result',{toolCallId:tool,...result},++seq));
    }
    observer.observe(event('tool:start',{toolCallId:'missing',name:'execute',inputSummary:'npm run build'},++seq));
    run.status='failed';
  });
  const summary=observer.summary();assert.equal(summary['nene.verification.failed'],2);assert.equal(summary['nene.verification.passed'],1);
  assert.equal(summary['nene.verification.unknown'],2);assert.equal(summary['nene.tools.unmatched'],1);
  const original=Sentry.getClient().getTransport().send;
  Sentry.getClient().getTransport().send=async()=>{throw new Error('Offline');};
  let writes=0; assert.equal(await operation(run,'test side effect','test',async()=>++writes),1);
  await Sentry.flush(1000).catch(()=>{});assert.equal(writes,1);
  Sentry.getClient().getTransport().send=original;
});
