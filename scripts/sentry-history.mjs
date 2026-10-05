// Read-only production history analysis; --send replays bounded traces to Sentry.
// This never starts a model, publishes to GitHub, deploys to Render, or writes MongoDB.
import { MongoClient } from 'mongodb';
import * as Sentry from '@sentry/node';
import { promises as fs } from 'node:fs';
import { AgentTelemetry, currentAttributes } from '../dist/telemetry.js';

const send = process.argv.includes('--send');
if (send && (!Sentry.getClient() || process.env.SENTRY_ENVIRONMENT !== 'hackathon-replay')) throw new Error('Use hackathon-replay environment and preload instrument.js');
const reportPath = process.env.SENTRY_EVIDENCE_PATH ?? '/tmp/nene-sentry-history.json';
const spans = [], receipts = [];
if (send) {
  const transport = Sentry.getClient().getTransport();
  const original = transport.send.bind(transport);
  transport.send = async envelope => {
    for (const [header,payload] of envelope[1]) if (header.type === 'span') for (const span of payload.items) if (spans.length < 1000) spans.push(span);
    const response = await original(envelope);
    receipts.push({statusCode:response.statusCode});
    return response;
  };
}
const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 1, serverSelectionTimeoutMS: 10000 });
const reports = [];
try {
  await client.connect();
  const db=client.db('nene');
  const selected=new Set((await db.collection('tasks').find({}, {projection:{id:1,_id:0}}).sort({createdAt:-1}).limit(6).toArray()).map(r=>r.id));
  for await (const run of db.collection('tasks').find({}, {projection:{_id:0,prompt:0,internalError:0,error:0}}).sort({createdAt:1})) {
    if (!run.projectId) continue;
    let time = Date.parse(run.createdAt), first, last, rawEvents=0;
    const observer = new AgentTelemetry(run,()=>time,{ 'nene.evidence.kind':'historical_replay', 'nene.evidence.id':run.id });
    const shouldSend=send && selected.has(run.id);
    const consume = async () => {
      if (send) currentAttributes({ 'nene.github.branch':run.github?.branch, 'nene.github.commit':run.github?.commit,
        'nene.deployment.service_id':run.deployment?.serviceId,'nene.deployment.deploy_id':run.deployment?.deployId,
        'nene.deployment.status':run.deployment?.status });
      for await (const event of db.collection('events').find({taskId:run.id}).sort({seq:1})) {
        rawEvents++;
        if(event.type!=='backboard:event')continue;
        const observed = Date.parse(event.data?.timestamp ?? event.timestamp);
        if(Number.isFinite(observed)) time=observed;
        first ??= time; last=time;
        observer.observe(event.data,shouldSend);
      }
      // Historical completed runs were successful coding runs; approval happened later.
      if (run.status==='completed') run.status='waiting_for_approval';
      if (send) currentAttributes({ 'nene.agent.duration_ms':Math.max(0,(last??time)-(first??time)) });
    };
    const originalStatus=run.status;
    // Report aggregate metrics for all history, but send at most six useful examples.
    if(shouldSend) await observer.trace(consume); else await consume();
    reports.push({runId:run.id,projectId:run.projectId,sourceRunId:run.sourceTaskId,status:originalStatus,
      createdAt:run.createdAt,firstAgentEvent:first?new Date(first).toISOString():undefined,lastAgentEvent:last?new Date(last).toISOString():undefined,
      observedAgentDurationMs:first!==undefined&&last!==undefined?last-first:0,rawEvents,
      github:run.github?{branch:run.github.branch,commit:run.github.commit}:undefined,
      deployment:run.deployment?{serviceId:run.deployment.serviceId,deployId:run.deployment.deployId,status:run.deployment.status}:undefined,
      ...observer.summary()});
  }
} finally { await client.close(); }
if (send) {
  if(!await Sentry.flush(5000)) throw new Error('Sentry did not flush before deadline');
  await Sentry.close(1000);
}
await fs.writeFile(reportPath,JSON.stringify({kind:'historical_replay',generatedAt:new Date().toISOString(),reports,spans,receipts},null,2));
console.log(JSON.stringify({reportPath,runs:reports.length,spans:spans.length,receipts}));
if(send && (!receipts.length || receipts.some(r=>!(r.statusCode>=200&&r.statusCode<300))))process.exitCode=1;
