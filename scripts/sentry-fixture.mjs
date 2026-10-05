// Exercises the real Backend with in-memory fake providers. Only Sentry receives
// network traffic; no paid model call, production task, Git push, or Render deploy.
import * as Sentry from '@sentry/node';
import { promises as fs } from 'node:fs';
import { fixture, started, eventually, live } from '../test/helpers.mjs';

if (!Sentry.getClient() || process.env.SENTRY_ENVIRONMENT !== 'hackathon-verification') throw new Error('Preload instrument.js with SENTRY_ENVIRONMENT=hackathon-verification');
Sentry.getIsolationScope().setAttributes({ 'nene.evidence.kind': 'fixture' });
Sentry.getIsolationScope().setTag('nene.evidence.kind','fixture');
const spans=[], receipts=[];
const transport=Sentry.getClient().getTransport(), original=transport.send.bind(transport);
transport.send=async envelope=>{
  for(const [header,payload] of envelope[1]) if(header.type==='span') for(const span of payload.items) if(spans.length<500)spans.push(span);
  const response=await original(envelope);receipts.push({statusCode:response.statusCode});return response;
};
const f=fixture();
async function build(previous,fail=false){
  const run=await started(f,'Synthetic Sentry verification fixture',previous);
  const emit=f.runner.work.get(run.id).emit;
  let sequence=0;
  const send=(type,payload)=>emit('backboard:event',{type,payload,session_id:'synthetic-session',sequence:++sequence});
  await send('turn:start',{});
  await send('usage',{usage:{inputTokens:1200,outputTokens:120,cachedTokens:100,provider:'digitalocean',model:'gemma-4-31B-it'}});
  for(const [id,name,command] of [['read','read'],['edit','edit'],['build','execute','npm run build'],['test','execute','npm test']]){
    await send('tool:requested',{calls:[{id,name,input:{command}}]});
    await send('tool:start',{toolCallId:id,name,inputSummary:command});
    await send('tool:result',{toolCallId:id,name,agentOutput:name==='execute'?`exit code: ${fail&&id==='test'?1:0}`:undefined});
  }
  if(fail)f.runner.fail(run.id);else f.runner.complete(run.id);
  await eventually(async()=>(await f.store.getRun(run.id)).telemetry);
  return await f.store.getRun(run.id);
}
const initial=await build();const first=await live(f,await f.backend.approve(initial.id));
const update=await build(initial.id);const second=await live(f,await f.backend.approve(update.id));
const failed=await build(second.id,true);
await f.backend.shutdown();
const flushed=await Sentry.flush(5000);await Sentry.close(1000);
const reportPath=process.env.SENTRY_EVIDENCE_PATH??'/tmp/nene-sentry-fixture.json';
await fs.writeFile(reportPath,JSON.stringify({kind:'fixture',generatedAt:new Date().toISOString(),runIds:[initial.id,update.id,failed.id],
  sameBranch:first.github.branch===second.github.branch,sameService:first.deployment.serviceId===second.deployment.serviceId,
  spans,receipts,flushed},null,2));
console.log(JSON.stringify({reportPath,spans:spans.length,receipts,flushed}));
if(!flushed||!receipts.length||receipts.some(r=>!(r.statusCode>=200&&r.statusCode<300)))process.exitCode=1;
