import type { GithubPublishResult } from "./github.js";
import type { ProgressStage } from "./progress.js";

export type RunStatus = "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "interrupted";
export interface Deployment {
  provider: "render";
  status: "creating" | "building" | "live" | "failed";
  serviceId?: string;
  deployId?: string;
  url?: string;
  dashboardUrl?: string;
  error?: string;
  requestedAt?: string;
  attempt?: number;
}

export interface Run {
  id: string;
  projectId: string;
  prompt: string;
  sourceTaskId?: string;
  sourceCommit?: string;
  status: RunStatus;
  progress: ProgressStage;
  writeCount: number;
  createdAt: string;
  updatedAt: string;
  containerName: string;
  volumeName: string;
  artifactPath?: string;
  github?: GithubPublishResult;
  deployment?: Deployment;
  approval?: "publishing" | "published";
  error?: string;
  internalError?: string;
  eventSeq?: number;
  schemaVersion?: number;
  telemetry?: Record<string, string | number | boolean>;
}

export interface Project {
  id: string;
  title: string;
  initialPrompt: string;
  githubBranch: string;
  approvedCommit?: string;
  approvedRunId?: string | null;
  activeRunId?: string | null;
  deploymentRunId?: string | null;
  render?: { serviceId: string; url?: string; dashboardUrl?: string };
  liveDeployment?: Deployment & { runId: string; commit?: string };
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  taskId: string;
  seq: number;
  timestamp: string;
  type: string;
  data: unknown;
}

// Existing task documents remain readable until the additive startup migration.
export type LegacyRun = Omit<Run, "projectId" | "status"> & { projectId?: string; status: string };

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "Invalid task or project ID");
  return value.toLowerCase();
}

export function validPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 20_000 || value.includes("\0")) {
    throw new ApiError(400, "prompt must contain 1–20000 characters");
  }
  return value.trim();
}

export function transition(run: Run, next: RunStatus): void {
  const allowed: Record<RunStatus, RunStatus[]> = {
    queued: ["running", "failed", "interrupted"],
    running: ["waiting_for_approval", "failed", "interrupted"],
    waiting_for_approval: ["completed", "failed", "interrupted"],
    completed: [], failed: [], interrupted: [],
  };
  if (!allowed[run.status]?.includes(next)) throw new ApiError(409, `Cannot change ${run.status} to ${next}`);
  run.status = next;
  run.updatedAt = new Date().toISOString();
}

export function publicRun(run: Run) {
  const { internalError, approval, eventSeq, schemaVersion, containerName, volumeName, telemetry, ...result } = run;
  return result;
}

export function newProject(id: string, prompt: string, now: string): Project {
  return { id, title: prompt.slice(0, 100), initialPrompt: prompt, githubBranch: `task/${id.slice(0, 8)}`,
    createdAt: now, updatedAt: now, activeRunId: null, deploymentRunId: null };
}

export interface Store {
  getRun(id: string): Promise<Run | undefined>;
  getProject(id: string): Promise<Project | undefined>;
  runs(): AsyncIterable<LegacyRun>;
  reserveRun(run: Run, initialProject?: Project): Promise<void>;
  patchRun(id: string, patch: Partial<Run>): Promise<void>;
  patchProject(id: string, patch: Partial<Project>): Promise<void>;
  putProject(project: Project): Promise<void>;
  releaseRun(run: Run, agentOnly?: boolean): Promise<void>;
  promote(run: Run, publication: GithubPublishResult): Promise<void>;
  claimDeployment(run: Run, deployment: Deployment): Promise<void>;
  recordDeployment(run: Run, deployment: Deployment): Promise<void>;
  appendEvent(id: string, type: string, data: unknown): Promise<TaskEvent>;
  events(id: string, after?: number): AsyncIterable<TaskEvent>;
  setAgentOwner(owner: string | null): Promise<void>;
  pendingDeployments(): AsyncIterable<Run>;
  close(): Promise<void>;
}
