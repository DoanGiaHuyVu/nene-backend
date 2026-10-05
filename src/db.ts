import { MongoClient, type Db, type ClientSession } from "mongodb";
import { ApiError, type Store, type Run, type Project, type LegacyRun, type TaskEvent, type Deployment } from "./model.js";
import type { GithubPublishResult } from "./github.js";

export type StoredTask = LegacyRun;
export type StoredEvent = TaskEvent;

export class MongoStore implements Store {
  private client: MongoClient;
  private db!: Db;
  constructor(uri: string, private databaseName = "nene") {
    this.client = new MongoClient(uri, { ignoreUndefined: true, maxPoolSize: 5, minPoolSize: 0, serverSelectionTimeoutMS: 15000 });
  }
  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
    await this.tasks.createIndex({ id: 1 }, { unique: true });
    await this.tasks.createIndex({ projectId: 1, createdAt: 1 });
    await this.tasks.createIndex({ "deployment.status": 1 });
    await this.eventCollection.createIndex({ taskId: 1, seq: 1 }, { unique: true });
    await this.projects.createIndex({ id: 1 }, { unique: true });
    await this.locks.updateOne({ id: "agent" }, { $setOnInsert: { id: "agent", owner: null } }, { upsert: true });
    // Old versions kept the sequence only in events. Initialize it once before replay.
    for await (const task of this.tasks.find({ eventSeq: { $exists: false } }, { projection: { id: 1 } })) {
      const last = await this.eventCollection.findOne({ taskId: task.id }, { sort: { seq: -1 } });
      await this.tasks.updateOne({ id: task.id, eventSeq: { $exists: false } }, { $set: { eventSeq: last?.seq ?? 0 } });
    }
  }
  private get tasks() { return this.db.collection<LegacyRun>("tasks"); }
  private get projects() { return this.db.collection<Project>("projects"); }
  private get eventCollection() { return this.db.collection<TaskEvent>("events"); }
  private get locks() { return this.db.collection<{ id: string; owner: string | null }>("locks"); }
  private async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try { return await session.withTransaction(() => operation(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); }
    finally { await session.endSession(); }
  }
  async getRun(id: string) {
    return (await this.tasks.findOne({ id }, { projection: { _id: 0 } }) ?? undefined) as Run | undefined;
  }
  async getProject(id: string) {
    return await this.projects.findOne({ id }, { projection: { _id: 0 } }) ?? undefined;
  }
  async *runs() {
    for await (const run of this.tasks.find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 })) yield run;
  }
  async reserveRun(run: Run, initialProject?: Project) {
    await this.transaction(async (session) => {
      if (initialProject) await this.projects.insertOne(initialProject, { session });
      const project = await this.projects.findOneAndUpdate({ id: run.projectId, activeRunId: null, approvedRunId: run.sourceTaskId ?? null },
        { $set: { activeRunId: run.id, updatedAt: run.updatedAt } }, { session, returnDocument: "after" });
      if (!project) throw new ApiError(409, "Project already has an active run");
      // Null matches both unset and explicit null, and the document already exists.
      const slot = await this.locks.updateOne({ id: "agent", owner: null }, { $set: { owner: run.id } }, { session });
      if (!slot.modifiedCount) throw new ApiError(409, "The coding agent is busy. Try again when the current run finishes.");
      await this.tasks.insertOne(run, { session });
    });
  }
  async patchRun(id: string, patch: Partial<Run>) {
    await this.tasks.updateOne({ id }, { $set: patch });
  }
  async patchProject(id: string, patch: Partial<Project>) {
    await this.projects.updateOne({ id }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
  }
  async putProject(project: Project) {
    await this.projects.updateOne({ id: project.id }, { $setOnInsert: project }, { upsert: true });
  }
  async releaseRun(run: Run, agentOnly = false) {
    await this.transaction(async (session) => {
      await this.locks.updateOne({ id: "agent", owner: run.id }, { $set: { owner: null } }, { session });
      if (!agentOnly) await this.projects.updateOne({ id: run.projectId, activeRunId: run.id },
        { $set: { activeRunId: null } }, { session });
    });
  }
  async promote(run: Run, publication: GithubPublishResult) {
    await this.transaction(async (session) => {
      const project = await this.projects.findOneAndUpdate({ id: run.projectId, activeRunId: run.id,
        approvedRunId: run.sourceTaskId ?? null }, { $set: {
        approvedRunId: run.id, approvedCommit: publication.commit, githubBranch: publication.branch,
        activeRunId: null, updatedAt: new Date().toISOString(),
      } }, { session, returnDocument: "after" });
      if (!project) throw new ApiError(409, "Project revision changed. Reload the project before approving.");
      const promoted = await this.tasks.updateOne({ id: run.id, status: "waiting_for_approval" }, { $set: {
        status: "completed", progress: "completed", approval: "published", github: publication,
        error: "", updatedAt: new Date().toISOString(),
      } }, { session });
      if (!promoted.matchedCount) throw new ApiError(409, "Run is no longer waiting for approval");
    });
  }
  async claimDeployment(run: Run, deployment: Deployment) {
    await this.transaction(async (session) => {
      const project = await this.projects.updateOne({ id: run.projectId, approvedRunId: run.id, deploymentRunId: null },
        { $set: { deploymentRunId: run.id } }, { session });
      if (!project.modifiedCount) throw new ApiError(409, "A project deployment is already in progress, or this revision is no longer current.");
      await this.tasks.updateOne({ id: run.id, status: "completed" }, { $set: { deployment, updatedAt: new Date().toISOString() } }, { session });
    });
  }
  async recordDeployment(run: Run, deployment: Deployment) {
    await this.transaction(async (session) => {
      const project = await this.projects.findOne({ id: run.projectId, deploymentRunId: run.id }, { session });
      if (!project) throw new ApiError(409, "Deployment ownership changed");
      if (project.render && deployment.serviceId && project.render.serviceId !== deployment.serviceId) {
        throw new ApiError(409, "A project must keep its existing Render service");
      }
      const patch: Partial<Project> = { updatedAt: new Date().toISOString() };
      if (deployment.serviceId) patch.render = { serviceId: deployment.serviceId,
        url: deployment.url ?? project.render?.url, dashboardUrl: deployment.dashboardUrl ?? project.render?.dashboardUrl };
      if (deployment.status === "live") patch.liveDeployment = { ...deployment, runId: run.id, commit: run.github?.commit };
      if (deployment.status === "live" || deployment.status === "failed") patch.deploymentRunId = null;
      await this.projects.updateOne({ id: run.projectId, deploymentRunId: run.id }, { $set: patch }, { session });
      await this.tasks.updateOne({ id: run.id }, { $set: { deployment, updatedAt: patch.updatedAt } }, { session });
    });
  }
  async appendEvent(id: string, type: string, data: unknown) {
    const run = await this.tasks.findOneAndUpdate({ id }, { $inc: { eventSeq: 1 } }, { returnDocument: "after" });
    if (!run) throw new Error("Task disappeared while persisting its event");
    const event: TaskEvent = { taskId: id, seq: run.eventSeq!, timestamp: new Date().toISOString(), type, data };
    await this.eventCollection.insertOne(event);
    return event;
  }
  async *events(id: string, after = 0) {
    for await (const event of this.eventCollection.find({ taskId: id, seq: { $gt: after } },
      { projection: { _id: 0 } }).sort({ seq: 1 })) yield event;
  }
  async setAgentOwner(owner: string | null) {
    await this.locks.updateOne({ id: "agent" }, { $set: { owner } });
  }
  async *pendingDeployments() {
    for await (const run of this.tasks.find({ "deployment.status": { $in: ["creating", "building"] } }, { projection: { _id: 0 } })) yield run as Run;
  }
  async close() { await this.client.close(); }
}
