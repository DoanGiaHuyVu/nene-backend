import { randomUUID } from "node:crypto";
import { ApiError, newProject, publicRun, transition, validId, validPrompt, UUID,
  type Store, type Run, type Project, type TaskEvent, type Deployment, type LegacyRun } from "./model.js";
import { inferProgress, PROGRESS_ORDER } from "./progress.js";
import type { Runner } from "./runner.js";
import { publishArtifactToGithub } from "./github.js";
import * as render from "./render.js";
import { ChangesReader } from "./changes.js";
import { AgentTelemetry, captureFailure, currentAttributes, lifecycle, operation } from "./telemetry.js";

export interface Integrations {
  publish: typeof publishArtifactToGithub;
  createService: typeof render.createRenderService;
  triggerDeploy: typeof render.triggerRenderDeploy;
  getDeploy: typeof render.getRenderDeploy;
  getService: typeof render.getRenderService;
  findService: typeof render.findRenderService;
  findDeploy: typeof render.findRenderDeploy;
}
export const integrations: Integrations = {
  publish: publishArtifactToGithub, createService: render.createRenderService,
  triggerDeploy: render.triggerRenderDeploy, getDeploy: render.getRenderDeploy,
  getService: render.getRenderService, findService: render.findRenderService, findDeploy: render.findRenderDeploy,
};

const now = () => new Date().toISOString();
const deploying = (deployment?: Deployment) => deployment && ["creating", "building"].includes(deployment.status);

export class Backend {
  private gates = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<(event: TaskEvent) => void>>();
  private jobs = new Set<Promise<void>>();
  private monitor?: NodeJS.Timeout;
  private stopping = false;
  private workerId?: string;
  constructor(public store: Store, private runner: Runner, private api: Integrations = integrations,
    private secrets: string[] = [], private changes = new ChangesReader()) {}

  private redact(value: unknown): string {
    let text = value instanceof Error ? value.stack ?? value.message : typeof value === "string" ? value : JSON.stringify(value);
    for (const secret of this.secrets) if (secret.length >= 6) text = text.split(secret).join("[REDACTED]");
    return text;
  }
  private log(runId: string, error: unknown) {
    console.error(`Backend operation failed for ${runId}: ${this.redact(error)}`);
    captureFailure(UUID.test(runId) ? "backend operation" : runId, error);
  }
  reportError(context: string, error: unknown) { this.log(context, error); }
  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.gates.set(key, pending);
    try { return await pending; }
    finally { if (this.gates.get(key) === pending) this.gates.delete(key); }
  }
  async getTask(value: unknown) {
    const id = validId(value);
    const task = await this.store.getRun(id);
    if (!task) throw new ApiError(404, "Task not found");
    return task;
  }
  async getChanges(value: unknown) {
    const run = await this.getTask(value);
    if (run.status !== "waiting_for_approval" && !(run.status === "completed" && run.github)) {
      throw new ApiError(409, "Changes are available after a successful build is ready for approval.");
    }
    let base: Run | undefined;
    if (run.sourceTaskId) {
      try { base = await this.store.getRun(run.sourceTaskId); }
      catch (error) { this.log(run.id, error); throw error; }
      if (!base || base.projectId !== run.projectId || base.status !== "completed" || !base.github ||
        (run.sourceCommit && base.github.commit !== run.sourceCommit)) {
        throw new ApiError(409, "The approved baseline for this revision is unavailable.");
      }
    }
    try { return await this.changes.read(run, base); }
    catch (error) { if (!(error instanceof ApiError)) this.log(run.id, error); throw error; }
  }
  private async projectFor(run: Run) {
    if (!UUID.test(run.projectId ?? "")) throw new ApiError(409, "Project migration is incomplete. Try again after backend recovery.");
    const project = await this.store.getProject(run.projectId);
    if (!project) throw new ApiError(409, "Project state is unavailable");
    return project;
  }
  async emit(id: string, type: string, data: unknown) {
    const encoded = this.redact(data);
    const safe = encoded.length > 32_768 ? { truncated: true, text: encoded.slice(0, 32_768) } : JSON.parse(encoded);
    const event = await this.store.appendEvent(id, type, safe);
    for (const listener of this.listeners.get(id) ?? []) listener(event);
  }
  subscribe(id: string, listener: (event: TaskEvent) => void) {
    let listeners = this.listeners.get(id);
    if (!listeners) { listeners = new Set(); this.listeners.set(id, listeners); }
    listeners.add(listener);
    return () => { listeners!.delete(listener); if (!listeners!.size) this.listeners.delete(id); };
  }
  private track(job: Promise<void>) {
    this.jobs.add(job);
    void job.catch(error => this.log("background", error)).finally(() => this.jobs.delete(job));
  }
  async create(promptValue: unknown, previousId?: unknown, projectValue?: unknown) {
    const prompt = validPrompt(promptValue);
    return this.exclusive("admission", async () => {
      if (this.stopping) throw new ApiError(503, "Backend is shutting down. Try again shortly.");
      let project: Project;
      let source: Run | undefined;
      let initialProject: Project | undefined;
      const id = randomUUID();
      const timestamp = now();
      if (previousId !== undefined) {
        const previous = await this.getTask(previousId);
        project = await this.projectFor(previous);
        if (projectValue !== undefined && validId(projectValue) !== project.id) throw new ApiError(400, "Task does not belong to this project");
        if (project.activeRunId) throw new ApiError(409, "Project already has an active run");
        source = project.approvedRunId ? await this.store.getRun(project.approvedRunId) : undefined;
        if (!source || source.projectId !== project.id || source.status !== "completed" || !source.github ||
          source.github.commit !== project.approvedCommit || !await this.runner.hasArtifact(source)) {
          throw new ApiError(409, "Project has no available approved successful revision to continue from");
        }
      } else {
        if (projectValue !== undefined) throw new ApiError(400, "Use a task continuation to update an existing project");
        project = initialProject = newProject(id, prompt, timestamp);
      }
      if (this.workerId) throw new ApiError(409, "The coding agent is busy. Try again when the current run finishes.");
      const persistedWorkers = new Set<string>();
      for await (const existing of this.store.runs()) if (["queued", "running"].includes(existing.status)) persistedWorkers.add(existing.id);
      await this.runner.maintenance(this.store.runs(), persistedWorkers);
      await this.runner.checkCapacity();
      const run: Run = { id, projectId: project.id, prompt, sourceTaskId: source?.id, sourceCommit: source?.github?.commit,
        status: "queued", progress: "planning", writeCount: 0, createdAt: timestamp, updatedAt: timestamp,
        containerName: `nene-task-${id}`, volumeName: `nene-volume-${id}`, eventSeq: 0, schemaVersion: 1 };
      await this.store.reserveRun(run, initialProject);
      try {
        await this.emit(id, "task:created", { prompt, sourceTaskId: source?.id });
        await this.emit(id, "task:progress", { stage: "planning", message: source ? "Loading your latest approved project" : "Understanding your request" });
      } catch (error) {
        await this.fail(run, error);
        throw new ApiError(503, "Could not persist the new task. Try again shortly.");
      }
      this.workerId = id;
      this.track(this.execute(run, source));
      return publicRun(run);
    });
  }
  private async agentEvent(run: Run, type: string, data: unknown, telemetry: AgentTelemetry) {
    await this.emit(run.id, type, data);
    if (type === "backboard:event") {
      telemetry.observe(data);
      const decision = inferProgress(data, run);
      run.writeCount = decision.writeCount;
      if (decision.stage && PROGRESS_ORDER[decision.stage] > PROGRESS_ORDER[run.progress]) {
        run.progress = decision.stage;
        await this.emit(run.id, "task:progress", { stage: decision.stage, message: decision.message });
      }
      await this.store.patchRun(run.id, { progress: run.progress, writeCount: run.writeCount, updatedAt: now() });
    }
  }
  private async fail(run: Run, error: unknown, interrupted = false) {
    this.log(run.id, error);
    if (["completed", "failed", "interrupted"].includes(run.status)) return;
    transition(run, interrupted ? "interrupted" : "failed");
    run.error = interrupted ? "This run was interrupted. Continue from your last approved revision." :
      "Project update failed. Your previous approved revision and live deployment are unchanged.";
    await this.store.patchRun(run.id, { status: run.status, error: run.error,
      internalError: this.redact(error).slice(0, 8192), updatedAt: run.updatedAt });
    try { await this.emit(run.id, "task:error", { message: run.error }); }
    finally { await this.store.releaseRun(run); }
  }
  private async execute(run: Run, source?: Run, recovery = false) {
    const telemetry = new AgentTelemetry(run, Date.now, { "nene.recovered": recovery });
    try { await telemetry.trace(async () => this.executeObserved(run, source, recovery, telemetry)); }
    finally { await this.store.patchRun(run.id, { telemetry: telemetry.summary() }).catch(error => this.log(run.id, error)); }
  }
  private async executeObserved(run: Run, source: Run | undefined, recovery: boolean, telemetry: AgentTelemetry) {
    try {
      if (!recovery) {
        transition(run, "running");
        await this.store.patchRun(run.id, { status: run.status, updatedAt: run.updatedAt });
        await this.emit(run.id, "task:status", { status: run.status });
      }
      if (recovery) {
        // Rebuild numeric totals from the existing cursor without sending old details
        // again. Docker recovery follows only new log lines.
        for await (const event of this.store.events(run.id)) if (event.type === "backboard:event") telemetry.observe(event.data, false);
      }
      const emit = (type: string, data: unknown) => this.agentEvent(run, type, data, telemetry);
      const artifact = recovery ? await this.runner.recover(run, emit) : await this.runner.run(run, source, emit);
      if (!artifact) { await this.fail(run, new Error("Persisted worker container no longer exists"), true); return; }
      if (this.stopping) { await this.fail(run, new Error("Backend shutdown"), true); return; }
      transition(run, "waiting_for_approval");
      run.artifactPath = artifact;
      run.progress = "waiting_for_approval";
      await this.store.patchRun(run.id, { status: run.status, artifactPath: artifact, progress: run.progress, updatedAt: run.updatedAt });
      await this.store.releaseRun(run, true);
      await this.emit(run.id, "task:progress", { stage: run.progress, message: "Build finished. Waiting for your approval." });
      await this.emit(run.id, "task:status", { status: run.status, artifactPath: artifact });
    } catch (error) {
      captureFailure("coding run", error, run);
      await this.fail(run, error, this.stopping);
    } finally {
      if (this.workerId === run.id) this.workerId = undefined;
      // DockerRunner also cleans in finally. This covers pre-spawn and persistence failures.
      await this.runner.cleanup(run).catch(error => this.log(run.id, error));
    }
  }
  async approve(id: unknown) {
    const original = await this.getTask(id);
    return this.exclusive(original.projectId, async () => {
      const run = await this.getTask(original.id);
      if (run.status === "completed" && run.github) return publicRun(run);
      if (run.status !== "waiting_for_approval") throw new ApiError(409, "Task is not waiting for approval");
      const project = await this.projectFor(run);
      if (project.activeRunId !== run.id || (project.approvedRunId ?? undefined) !== (run.sourceTaskId ?? undefined)) throw new ApiError(409, "This is not the project's active revision");
      if (!await this.runner.hasArtifact(run)) throw new ApiError(409, "Generated project artifact is unavailable");
      return operation(run, "approval", "nene.approval", async () => {
      lifecycle("Approval received", run);
      await this.store.patchRun(run.id, { approval: "publishing", updatedAt: now() });
      try {
        const publication = await operation(run, "GitHub publish", "nene.github.publish", async () => {
          const result = await this.api.publish(run.id, run.artifactPath!, { branch: project.githubBranch,
            expectedCommit: project.approvedCommit, commitMessage: run.sourceTaskId ? `Update: ${run.prompt.replace(/\s+/g, " ").slice(0, 72)}` : undefined });
          currentAttributes({ "nene.github.branch": result.branch, "nene.github.commit": result.commit });
          lifecycle("GitHub revision published", run, { "nene.github.branch": result.branch, "nene.github.commit": result.commit });
          return result;
        });
        // The transaction updates both the project pointer and the run only after a successful push.
        await this.store.promote(run, publication);
        const approved = await this.getTask(run.id);
        await this.emit(run.id, "task:progress", { stage: "completed", message: "Task published to GitHub and completed." }).catch(error => this.log(run.id, error));
        await this.emit(run.id, "task:completed", { message: "Approved project published to GitHub", github: publication }).catch(error => this.log(run.id, error));
        return publicRun(approved);
      } catch (error) {
        this.log(run.id, error);
        await this.store.patchRun(run.id, { error: "Publication could not be confirmed. Your previous approved revision is unchanged; retry Approve.",
          internalError: this.redact(error).slice(0, 8192) });
        throw new ApiError(502, "Could not confirm GitHub publication. Retry Approve; duplicate commits are prevented.");
      }
      }, { "nene.approval.wait_ms": Math.max(0, Date.now() - Date.parse(run.updatedAt)), "nene.github.branch": project.githubBranch }, true);
    });
  }
  async deploy(id: unknown) {
    const original = await this.getTask(id);
    return this.exclusive(original.projectId, async () => {
      const run = await this.getTask(original.id);
      if (run.status !== "completed" || !run.github) throw new ApiError(409, "Task must be approved before deployment");
      if (run.deployment?.status === "live") return publicRun(run);
      if (deploying(run.deployment)) {
        await this.reconcileDeployment(run);
        return publicRun(await this.getTask(run.id));
      }
      let project = await this.projectFor(run);
      if (project.approvedRunId !== run.id) throw new ApiError(409, "Only the latest approved project revision can be deployed");
      return operation(run, "Render deployment request", "nene.render.request", async () => {
      const deployment: Deployment = { provider: "render", status: "creating", requestedAt: now(), attempt: (run.deployment?.attempt ?? 0) + 1 };
      await this.store.claimDeployment(run, deployment);
      run.deployment = deployment;
      let requestIssued = false;
      try {
        let service = project.render;
        // A creation response may have been lost in an older version. Discover before POSTing.
        if (!service) service = await this.api.findService(project.id, project.githubBranch);
        let deployId: string;
        if (service) {
          const metadata = await this.api.getService(service.serviceId);
          service = { ...service, ...metadata };
          // Persist the stable service identity before a potentially ambiguous request.
          Object.assign(deployment, service);
          await this.store.recordDeployment(run, deployment);
          requestIssued = true;
          const result = await operation(run, "Render redeploy", "nene.render.redeploy", async () => {
            const result = await this.api.triggerDeploy(service!.serviceId, run.github!.commit);
            currentAttributes({ "nene.deployment.deploy_id": result.id }); return result;
          }, { "nene.deployment.kind": "existing_service", "nene.deployment.service_id": service.serviceId,
            "nene.github.branch": project.githubBranch, "nene.github.commit": run.github!.commit });
          deployId = result.id;
        } else {
          requestIssued = true;
          const result = await operation(run, "Render create service", "nene.render.create", async () => {
            const result = await this.api.createService(project.id, project.githubBranch, "app");
            currentAttributes({ "nene.deployment.service_id": result.serviceId, "nene.deployment.deploy_id": result.deployId }); return result;
          }, { "nene.deployment.kind": "initial_service", "nene.github.branch": project.githubBranch });
          service = { serviceId: result.serviceId, url: result.url, dashboardUrl: result.dashboardUrl };
          deployId = result.deployId;
        }
        Object.assign(deployment, service, { deployId, status: "building" });
        await this.store.recordDeployment(run, deployment);
        await this.emit(run.id, "deployment:building", { message: "Render is building the application", ...deployment });
        lifecycle("Render deployment started", run, { "nene.deployment.service_id": deployment.serviceId, "nene.deployment.deploy_id": deployment.deployId });
      } catch (error) {
        this.log(run.id, error);
        // Only a definitive API rejection permits another POST. Network errors/5xx
        // leave the intent pending and reconcile through GETs, avoiding duplicate services.
        if (!requestIssued || error instanceof render.RenderApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
          deployment.status = "failed";
          deployment.error = "Render rejected this deployment. Your previous live version is unchanged; retry Deploy after resolving the error.";
          await this.store.recordDeployment(run, deployment);
          await this.emit(run.id, "deployment:failed", { message: deployment.error });
          throw new ApiError(502, deployment.error);
        }
        deployment.error = "Checking whether Render accepted the request. Your previous live version is unchanged.";
        await this.store.recordDeployment(run, deployment);
      }
      return publicRun(await this.getTask(run.id));
      }, {}, true);
    });
  }
  private async reconcileDeployment(run: Run) {
    const deployment = run.deployment;
    if (!deployment || !deploying(deployment) || !run.github) return;
    let project = await this.projectFor(run);
    if (project.deploymentRunId !== run.id) return;
    try {
      if (!deployment.serviceId) {
        const service = project.render ?? await this.api.findService(project.id, project.githubBranch);
        if (!service) return; // Uncertain create: never issue another POST blindly.
        Object.assign(deployment, service);
        await this.store.recordDeployment(run, deployment);
      }
      if (!deployment.url) Object.assign(deployment, await this.api.getService(deployment.serviceId!));
      if (!deployment.deployId) {
        const result = await this.api.findDeploy(deployment.serviceId!, run.github.commit, deployment.requestedAt ?? run.createdAt);
        if (!result) return;
        deployment.deployId = result.id;
        deployment.status = "building";
        await this.store.recordDeployment(run, deployment);
      }
      const result = await this.api.getDeploy(deployment.serviceId!, deployment.deployId!);
      const terminal = ["live", "build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"].includes(result.status);
      if (terminal) await operation(run, "Render deployment result", "nene.render.result", async () => {
        if (result.status !== "live") captureFailure("Render build", new Error("Render deployment failed"), run);
        lifecycle(result.status === "live" ? "Deployment live" : "Deployment failed", run, { "nene.deployment.status": result.status });
      }, { "nene.deployment.service_id": deployment.serviceId, "nene.deployment.deploy_id": deployment.deployId,
        "nene.deployment.status": result.status, "nene.success": result.status === "live",
        "nene.deployment.elapsed_ms": Math.max(0, Date.now() - Date.parse(deployment.requestedAt ?? run.createdAt)) }, true);
      if (result.status === "live") {
        deployment.status = "live";
        deployment.error = undefined;
        await this.store.recordDeployment(run, deployment);
        await this.emit(run.id, "deployment:live", { message: "Deployment is live", url: deployment.url });
      } else if (["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"].includes(result.status)) {
        deployment.status = "failed";
        deployment.error = "Deployment failed. Your previous live version is unchanged; retry Deploy.";
        await this.store.recordDeployment(run, deployment);
        await this.emit(run.id, "deployment:failed", { message: deployment.error, renderStatus: result.status });
      }
    } catch (error) {
      this.log(run.id, error);
      if (error instanceof render.RenderApiError && error.status === 404) {
        deployment.status = "failed";
        deployment.error = "Render could not find this deployment. Your previous live metadata is preserved; retry Deploy.";
        await this.store.recordDeployment(run, deployment);
      }
      // A temporary API/MongoDB outage must not erase an in-progress attempt or live metadata.
    }
  }
  async pollDeployments() {
    for await (const legacy of this.store.pendingDeployments()) {
      const run = legacy as Run;
      if (deploying(run.deployment)) await this.exclusive(run.projectId, async () => this.reconcileDeployment(await this.getTask(run.id)));
    }
  }
  startMonitoring() {
    const tick = async () => {
      if (this.stopping) return;
      try { await this.pollDeployments(); } catch (error) { this.log("deployment-monitor", error); }
      if (!this.stopping) { this.monitor = setTimeout(tick, 15_000); this.monitor.unref(); }
    };
    this.monitor = setTimeout(tick, 0);
  }
  private async migrate() {
    // Additive, idempotent migration: old tasks/events and their artifacts are retained.
    for await (const legacy of this.store.runs()) {
      if (!UUID.test(legacy.id)) { this.log(legacy.id, new Error("Skipping invalid legacy task ID")); continue; }
      if (legacy.schemaVersion === 1 && legacy.projectId && await this.store.getProject(legacy.projectId)) continue;
      let root: LegacyRun = legacy;
      const seen = new Set([root.id]);
      while (root.sourceTaskId) {
        if (!UUID.test(root.sourceTaskId) || seen.has(root.sourceTaskId)) throw new Error(`Invalid legacy continuation chain for ${legacy.id}`);
        seen.add(root.sourceTaskId);
        const previous = await this.store.getRun(root.sourceTaskId);
        if (!previous) throw new Error(`Missing legacy source for ${legacy.id}; migration requires reconciliation`);
        root = previous;
      }
      const projectId = root.projectId ?? root.id;
      const initial = newProject(projectId, root.prompt, root.createdAt);
      await this.store.putProject(initial);
      const run = { ...legacy, projectId } as Run;
      const project = (await this.store.getProject(projectId))!;
      const patch: Partial<Project> = {};
      if (run.status === "completed" && run.github) {
        const latest = project.approvedRunId ? await this.store.getRun(project.approvedRunId) : undefined;
        if (!latest || run.createdAt >= latest.createdAt) {
          patch.approvedRunId = run.id; patch.approvedCommit = run.github.commit; patch.githubBranch = run.github.branch;
        }
      }
      if (run.deployment?.serviceId) {
        if (!project.render) patch.render = { serviceId: run.deployment.serviceId, url: run.deployment.url, dashboardUrl: run.deployment.dashboardUrl };
        else if (project.render.serviceId === run.deployment.serviceId) patch.render = { ...project.render,
          url: run.deployment.url ?? project.render.url, dashboardUrl: run.deployment.dashboardUrl ?? project.render.dashboardUrl };
        if (run.deployment.status === "live" && (!project.liveDeployment || run.createdAt >= ((await this.store.getRun(project.liveDeployment.runId))?.createdAt ?? ""))) {
          patch.liveDeployment = { ...run.deployment, runId: run.id, commit: run.github?.commit };
          // Legacy code sometimes created replacement services. Preserve the latest
          // actual live service/URL, then keep that service stable for future revisions.
          patch.render = { serviceId: run.deployment.serviceId, url: run.deployment.url, dashboardUrl: run.deployment.dashboardUrl };
        }
      }
      if (deploying(run.deployment)) patch.deploymentRunId = run.id;
      if (Object.keys(patch).length) await this.store.patchProject(projectId, patch);
      await this.store.patchRun(legacy.id, { projectId, schemaVersion: 1 });
    }
  }
  async recover() {
    await this.migrate();
    const active = new Set<string>();
    let recoveredWorker: Run | undefined;
    for await (const legacy of this.store.runs()) {
      const run = legacy as Run;
      if (!run.projectId) continue;
      let project = await this.projectFor(run);
      if (project.activeRunId) {
        const owner = await this.store.getRun(project.activeRunId);
        if (!owner || ["completed", "failed", "interrupted"].includes(owner.status)) {
          await this.store.patchProject(project.id, { activeRunId: null }); project.activeRunId = null;
        }
      }
      if (project.deploymentRunId) {
        const owner = await this.store.getRun(project.deploymentRunId);
        if (!owner || !deploying(owner.deployment)) await this.store.patchProject(project.id, { deploymentRunId: null });
      }
      if (run.status === "queued") {
        await this.runner.cleanup(run);
        await this.fail(run, new Error("Queued worker was lost during restart"), true);
      } else if (run.status === "running") {
        if (recoveredWorker || project.activeRunId && project.activeRunId !== run.id) {
          await this.runner.cleanup(run);
          await this.fail(run, new Error("Extra legacy worker interrupted to enforce one global worker"), true);
        } else {
          recoveredWorker = run; active.add(run.id);
          await this.store.patchProject(project.id, { activeRunId: run.id });
        }
      } else if (run.status === "waiting_for_approval") {
        if ((project.activeRunId && project.activeRunId !== run.id) || (project.approvedRunId ?? undefined) !== (run.sourceTaskId ?? undefined)) {
          // Old concurrent revisions remain isolated, and cannot override the chosen active revision.
          await this.store.patchRun(run.id, { status: "interrupted", error: "This older pending revision was superseded during recovery.", updatedAt: now() });
        } else await this.store.patchProject(project.id, { activeRunId: run.id });
      } else await this.store.releaseRun(run);
    }
    await this.store.setAgentOwner(recoveredWorker?.id ?? null);
    await this.runner.maintenance(this.store.runs(), active);
    if (recoveredWorker) {
      this.workerId = recoveredWorker.id;
      this.track(this.execute(recoveredWorker, undefined, true));
    }
    await this.pollDeployments();
    for await (const legacy of this.store.runs()) {
      if (legacy.status === "waiting_for_approval" && legacy.approval === "publishing") {
        await this.approve(legacy.id).catch(error => this.log(legacy.id, error));
      }
    }
  }
  async shutdown() {
    this.stopping = true;
    if (this.monitor) clearTimeout(this.monitor);
    await this.runner.shutdown();
    await Promise.allSettled([...this.jobs, ...this.gates.values()]);
    await this.store.close();
  }
}
