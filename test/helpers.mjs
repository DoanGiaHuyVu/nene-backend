import { randomUUID } from 'node:crypto';
import { Backend } from '../dist/backend.js';
import { ApiError } from '../dist/model.js';

const copy = value => value === undefined ? value : structuredClone(value);
export class MemoryStore {
  taskMap = new Map(); projectMap = new Map(); eventMap = new Map(); agentOwner = null;
  async getRun(id) { return copy(this.taskMap.get(id)); }
  async getProject(id) { return copy(this.projectMap.get(id)); }
  async *runs() { for (const r of [...this.taskMap.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt))) yield copy(r); }
  async *pendingDeployments() { for await (const r of this.runs()) if (['creating','building'].includes(r.deployment?.status)) yield r; }
  async reserveRun(run, initial) {
    const project = initial ?? this.projectMap.get(run.projectId);
    if (!project || project.activeRunId || (project.approvedRunId ?? null) !== (run.sourceTaskId ?? null)) throw new ApiError(409, 'Project already has an active run');
    if (this.agentOwner) throw new ApiError(409, 'The coding agent is busy');
    if (initial) this.projectMap.set(initial.id, copy(initial));
    this.projectMap.get(run.projectId).activeRunId = run.id;
    this.agentOwner = run.id; this.taskMap.set(run.id, copy(run));
  }
  async patchRun(id, patch) { Object.assign(this.taskMap.get(id), copy(patch)); }
  async patchProject(id, patch) { Object.assign(this.projectMap.get(id), copy(patch)); }
  async putProject(project) { if (!this.projectMap.has(project.id)) this.projectMap.set(project.id, copy(project)); }
  async releaseRun(run, agentOnly=false) {
    if (this.agentOwner===run.id) this.agentOwner=null;
    const p=this.projectMap.get(run.projectId);
    if (!agentOnly && p?.activeRunId===run.id) p.activeRunId=null;
  }
  async promote(run, pub) {
    if (this.failPromotion) { this.failPromotion=false; throw new Error('Database failed after the successful Git push'); }
    const p=this.projectMap.get(run.projectId);
    if (p.activeRunId!==run.id || (p.approvedRunId ?? null)!==(run.sourceTaskId ?? null)) throw new ApiError(409,'Revision conflict');
    Object.assign(p,{approvedRunId:run.id,approvedCommit:pub.commit,githubBranch:pub.branch,activeRunId:null});
    Object.assign(this.taskMap.get(run.id),{status:'completed',progress:'completed',approval:'published',github:copy(pub),error:''});
  }
  async claimDeployment(run, deployment) {
    const p=this.projectMap.get(run.projectId);
    if (p.deploymentRunId || p.approvedRunId!==run.id) throw new ApiError(409,'Deployment conflict');
    p.deploymentRunId=run.id; this.taskMap.get(run.id).deployment=copy(deployment);
  }
  async recordDeployment(run, deployment) {
    const p=this.projectMap.get(run.projectId);
    if (p.deploymentRunId!==run.id) throw new ApiError(409,'Deployment conflict');
    if (p.render && deployment.serviceId && p.render.serviceId!==deployment.serviceId) throw new ApiError(409,'Service conflict');
    if (deployment.serviceId) p.render={serviceId:deployment.serviceId,url:deployment.url??p.render?.url,dashboardUrl:deployment.dashboardUrl??p.render?.dashboardUrl};
    if (deployment.status==='live') p.liveDeployment={...copy(deployment),runId:run.id,commit:run.github?.commit};
    if (['live','failed'].includes(deployment.status)) p.deploymentRunId=null;
    this.taskMap.get(run.id).deployment=copy(deployment);
  }
  async appendEvent(id,type,data) {
    const list=this.eventMap.get(id)??[];
    const event={taskId:id,seq:list.length+1,timestamp:new Date().toISOString(),type,data:copy(data)};
    list.push(event);this.eventMap.set(id,list);return copy(event);
  }
  async *events(id,after=0) {for(const e of this.eventMap.get(id)??[])if(e.seq>after)yield copy(e);}
  async setAgentOwner(owner) {this.agentOwner=owner;}
  async close() {}
}
export class FakeRunner {
  work=new Map(); sources=new Map(); cleaned=[]; shutdownCalled=false; missingArtifacts=new Set();
  async checkCapacity(){ if(this.diskFull)throw new ApiError(507,'Not enough free disk space'); }
  async hasArtifact(run){ return !!run.artifactPath && !this.missingArtifacts.has(run.id); }
  async run(run,source,emit){
    this.sources.set(run.id,source?.id);
    return new Promise((resolve,reject)=>this.work.set(run.id,{resolve,reject,emit}));
  }
  complete(id){this.work.get(id).resolve(`/artifacts/${id}`);this.work.delete(id);}
  fail(id){this.work.get(id).reject(new Error('Long internal Docker failure with model-secret'));this.work.delete(id);}
  async recover(run){return this.recoveredArtifact;}
  async cleanup(run){this.cleaned.push(run.id);}
  async maintenance(runs,active){this.maintained=[...active];}
  async shutdown(){this.shutdownCalled=true;for(const job of this.work.values())job.reject(new Error('Shutdown'));this.work.clear();}
}
export function fixture() {
  const store=new MemoryStore(), runner=new FakeRunner();
  const count={push:0,create:0,trigger:0};
  const publications=new Map(), services=new Map(), deploys=new Map();
  const api={
    async publish(id,path,options){
      if(api.publishError){const e=api.publishError;api.publishError=undefined;throw e;}
      if(!publications.has(id)){count.push++;publications.set(id,{branch:options.branch,commit:randomUUID().replaceAll('-',''),url:'https://github.test/project'});}
      return copy(publications.get(id));
    },
    async createService(projectId,branch){
      count.create++;if(api.createError){const e=api.createError;api.createError=undefined;throw e;}
      const service={serviceId:`srv-${projectId}`,url:'https://stable.example',dashboardUrl:'https://dashboard.example'};
      services.set(projectId,{...service,branch});
      const id=`dep-${count.create}-initial`;
      deploys.set(id,{id,status:'build_in_progress',commit:{id:store.projectMap.get(projectId).approvedCommit}});
      if(api.loseCreateResponse){api.loseCreateResponse=false;throw new Error('Connection lost after create');}
      return {...service,deployId:id,name:`nene-${projectId.slice(0,8)}`};
    },
    async triggerDeploy(serviceId,commit){
      count.trigger++;const id=`dep-${count.trigger}-update`;
      deploys.set(id,{id,status:'build_in_progress',commit:{id:commit}});
      if(api.loseTriggerResponse){api.loseTriggerResponse=false;throw new Error('Connection lost after trigger');}
      return copy(deploys.get(id));
    },
    async getDeploy(serviceId,id){return copy(deploys.get(id));},
    async getService(id){return copy([...services.values()].find(s=>s.serviceId===id));},
    async findService(id,branch){return copy(services.get(id));},
    async findDeploy(serviceId,commit){return copy([...deploys.values()].reverse().find(d=>d.commit?.id===commit));},
  };
  const backend=new Backend(store,runner,api,['model-secret']);
  return {backend,store,runner,api,count,deploys,services};
}
export async function eventually(fn){
  for(let i=0;i<200;i++){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('Condition did not become true');
}
export async function started(f,prompt='Build a project',previous){
  const run=await f.backend.create(prompt,previous);
  await eventually(()=>f.runner.work.has(run.id));return run;
}
export async function approved(f,previous){
  const run=await started(f,'Build a project',previous);
  f.runner.complete(run.id);
  await eventually(async()=> (await f.store.getRun(run.id)).status==='waiting_for_approval' && !f.backend.workerId);
  return await f.backend.approve(run.id);
}
export async function live(f,run){
  const pending=await f.backend.deploy(run.id);
  f.deploys.get(pending.deployment.deployId).status='live';
  await f.backend.pollDeployments();return await f.store.getRun(run.id);
}
