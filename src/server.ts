import express, { type Response } from "express";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";

import {
  inferProgress,
  PROGRESS_ORDER,
  type ProgressStage,
} from "./progress.js";

import {
  connectDatabase,
  saveTask,
  saveEvent,
  findTask,
  findEvents,
  type StoredTask,
} from "./db.js";

import {
  publishArtifactToGithub,
  type GithubPublishResult,
} from "./github.js";


import {
  createRenderService,
  getRenderDeploy,
  triggerRenderDeploy,
} from "./render.js";

const app = express();
app.use(express.json());

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,
      service: "ne-ne",
    });
  }
);

app.use(
  (req, res, next) => {
    const authorization =
      req.get("authorization");

    if (
      authorization !==
      `Bearer ${API_TOKEN}`
    ) {
      return res
        .status(401)
        .json({
          error: "Unauthorized",
        });
    }

    next();
  }
);

const PORT = 3001;

const NENE_ROOT = "/home/nene/ne-ne";
const AGENT_IMAGE = "nene-agent:0.2";

const BACKBOARD_CONFIG =
  "/home/nene/ne-ne/agent-image/backboard-config.json";

const ARTIFACT_ROOT =
  path.join(NENE_ROOT, "artifacts");

fs.mkdirSync(ARTIFACT_ROOT, {
  recursive: true,
});

if (!process.env.DO_MODEL_KEY) {
  throw new Error(
    "DO_MODEL_KEY is missing. Export it before starting ne-ne."
  );
}

const API_TOKEN =
  process.env.NENE_API_TOKEN;

if (!API_TOKEN) {
  throw new Error(
    "NENE_API_TOKEN is missing"
  );
}

type TaskStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed";

interface TaskEvent {
  seq: number;
  timestamp: string;
  type: string;
  data: unknown;
}

interface DeploymentInfo {
  provider: "render";
  status:
    | "creating"
    | "building"
    | "live"
    | "failed";

  serviceId?: string;
  deployId?: string;
  url?: string;
  dashboardUrl?: string;
  error?: string;
}

interface Task {
  id: string;
  prompt: string;
	
  sourceTaskId?: string;

  status: TaskStatus;
  progress: ProgressStage;
  writeCount: number;

  createdAt: string;
  updatedAt: string;

  containerName: string;
  volumeName: string;

  artifactPath?: string;
  github?: GithubPublishResult;
  deployment?: DeploymentInfo;
  error?: string;

  events: TaskEvent[];
}

function toStoredTask(
  task: Task
): StoredTask {
  return {
    id: task.id,
    prompt: task.prompt,

    sourceTaskId: task.sourceTaskId,
 
    status: task.status,
    progress: task.progress,

    writeCount: task.writeCount,

    createdAt: task.createdAt,
    updatedAt: task.updatedAt,

    containerName: task.containerName,
    volumeName: task.volumeName,

    artifactPath: task.artifactPath,
    github: task.github,
    deployment: task.deployment,
    error: task.error,
  };
}

const tasks =
  new Map<string, Task>();

const subscribers =
  new Map<string, Set<Response>>();

const persistenceQueues =
  new Map<string, Promise<void>>();

function persistEventAndTask(
  task: Task,
  event: TaskEvent
) {
  const taskSnapshot =
    toStoredTask(task);

  const eventSnapshot = {
    taskId: task.id,
    seq: event.seq,
    timestamp: event.timestamp,
    type: event.type,
    data: event.data,
  };

  const previous =
    persistenceQueues.get(task.id) ??
    Promise.resolve();

  const next =
    previous
      .then(async () => {
        await saveEvent(
          eventSnapshot
        );

        await saveTask(
          taskSnapshot
        );
      })
      .catch((error) => {
        console.error(
          `MongoDB persistence failed for task ${task.id}:`,
          error
        );
      });

  persistenceQueues.set(
    task.id,
    next
  );

  void next.finally(() => {
    if (
      persistenceQueues.get(task.id) ===
      next
    ) {
      persistenceQueues.delete(
        task.id
      );
    }
  });
}

function publicTask(task: Task) {
  return {
    id: task.id,
    prompt: task.prompt,
    sourceTaskId: task.sourceTaskId,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    artifactPath: task.artifactPath,
    github: task.github,
    deployment: task.deployment,
    error: task.error,
  };
}

async function getTask(
  id: string
): Promise<Task | undefined> {
  /*
   * Fast path: task is still in RAM.
   */
  const existing =
    tasks.get(id);

  if (existing) {
    return existing;
  }

  /*
   * Backend may have restarted.
   * Recover task and event history from MongoDB.
   */
  const storedTask =
    await findTask(id);

  if (!storedTask) {
    return undefined;
  }

  const storedEvents =
    await findEvents(id);

  const restoredTask: Task = {
    id: storedTask.id,
    prompt: storedTask.prompt,

    status:
      storedTask.status as TaskStatus,

    sourceTaskId: 
      storedTask.sourceTaskId,

    progress:
      storedTask.progress as ProgressStage,

    writeCount:
      storedTask.writeCount,

    createdAt:
      storedTask.createdAt,

    updatedAt:
      storedTask.updatedAt,

    containerName:
      storedTask.containerName,

    volumeName:
      storedTask.volumeName,

    artifactPath:
      storedTask.artifactPath,
 
    github:
      storedTask.github,
    
    deployment: 
      storedTask.deployment,
    
    error:
      storedTask.error,

    events:
      storedEvents.map(
        (event) => ({
          seq: event.seq,
          timestamp: event.timestamp,
          type: event.type,
          data: event.data,
        })
      ),
  };

  /*
   * Put it back into RAM so subsequent requests
   * behave exactly like a normal live task.
   */
  tasks.set(
    id,
    restoredTask
  );

  return restoredTask;
}

function emitEvent(
  task: Task,
  type: string,
  data: unknown
) {
  const event: TaskEvent = {
    seq: task.events.length + 1,
    timestamp: new Date().toISOString(),
    type,
    data,
  };

  task.events.push(event);
  task.updatedAt = event.timestamp;

  persistEventAndTask(
    task,
    event
  );

  const clients =
    subscribers.get(task.id);

  if (!clients) {
    return;
  }

  for (const response of clients) {
    response.write(
      `data: ${JSON.stringify(event)}\n\n`
    );
  }
}

function setProgress(
  task: Task,
  next: ProgressStage,
  message: string
) {
  /*
   * Never move progress backwards.
   */
  if (
    PROGRESS_ORDER[next] <=
    PROGRESS_ORDER[task.progress]
  ) {
    return;
  }

  task.progress = next;

  emitEvent(
    task,
    "task:progress",
    {
      stage: next,
      message,
    }
  );
}

function cleanupDocker(task: Task) {
  spawnSync(
    "docker",
    [
      "rm",
      "-f",
      task.containerName,
    ],
    {
      stdio: "ignore",
    }
  );

  spawnSync(
    "docker",
    [
      "volume",
      "rm",
      "-f",
      task.volumeName,
    ],
    {
      stdio: "ignore",
    }
  );
}

async function runTask(task: Task) {
  task.status = "running";

  emitEvent(
    task,
    "task:status",
    {
      status: "running",
    }
  );

  /*
   * Create a disposable workspace for this task.
   */
  const volumeResult = spawnSync(
    "docker",
    [
      "volume",
      "create",
      task.volumeName,
    ],
    {
      encoding: "utf8",
    }
  );

  if (task.sourceTaskId) {
    const sourceTask =
      await getTask(
        task.sourceTaskId
      );

    if (
      !sourceTask ||
      !sourceTask.artifactPath
    ) {
      task.status = "failed";
      task.error =
        "Previous project artifact could not be found.";

      emitEvent(
        task,
        "task:error",
        {
          message: task.error,
        }
      );

    cleanupDocker(task);
    return;
  }

  const sourceApp =
    path.join(
      sourceTask.artifactPath,
      "app"
    );

  if (!fs.existsSync(sourceApp)) {
    task.status = "failed";
    task.error =
      "Previous project does not contain an app directory.";

    emitEvent(
      task,
      "task:error",
      {
        message: task.error,
      }
    );

    cleanupDocker(task);
    return;
  }

  const seedResult =
    spawnSync(
      "docker",
      [
        "run",
        "--rm",

        "--entrypoint",
        "sh",

        "--mount",
        `type=volume,source=${task.volumeName},target=/workspace`,

        "--mount",
        `type=bind,src=${sourceApp},dst=/source-app,readonly`,

        AGENT_IMAGE,

        "-c",
        "mkdir -p /workspace/app && cp -R --no-preserve=ownership /source-app/. /workspace/app/ && chmod -R a+rwX /workspace/app",
      ],
      {
        encoding: "utf8",
      }
    );

  if (seedResult.status !== 0) {
    task.status = "failed";
    task.error =
      seedResult.stderr ||
      "Failed to load previous project.";

    emitEvent(
      task,
      "task:error",
      {
        message: task.error,
      }
    );

    cleanupDocker(task);
    return;
  }

  emitEvent(
    task,
    "project:loaded",
    {
      sourceTaskId:
        task.sourceTaskId,

      message:
        "Previous project loaded into workspace.",
    }
  );
}

  if (volumeResult.status !== 0) {
    task.status = "failed";

    task.error =
      volumeResult.stderr ||
      "Failed to create Docker volume.";

    emitEvent(
      task,
      "task:error",
      {
        message: task.error,
      }
    );

    return;
  }

  /*
   * Give Gemma the original task plus an explicit
   * verification requirement.
   */
  const taskInstruction =
  task.sourceTaskId
    ? `
You are modifying an existing project.

The existing application has already been loaded into:

/workspace/app

Inspect the existing project before changing anything.

Do not recreate the application from scratch unless absolutely necessary.

Preserve existing working functionality.

The user wants this change:

${task.prompt}
`.trim()
    : task.prompt;

  const agentPrompt = `
${task.prompt}

Before you declare the task complete, run an appropriate
build, test, lint, type-check, or syntax check for the project.
Fix any errors you discover.

Deployment requirements for web applications:

- Create the deployable application inside /workspace/app.
- The application must include /workspace/app/Dockerfile.
- The application must listen on 0.0.0.0, not localhost.
- Read the HTTP port from the PORT environment variable.
- If PORT is not provided, default to 10000.
- The Dockerfile must contain a CMD or ENTRYPOINT that starts the production app.
- The application must not require secrets merely to show its basic functionality.
- Run the normal project build/tests before declaring the task complete.
- Do not attempt to run Docker yourself.
`.trim();

  const dockerArgs = [
    "run",

    "--name",
    task.containerName,

    "--read-only",

    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=128m",

    "--mount",
    `type=volume,source=${task.volumeName},target=/workspace`,

    "--mount",
    `type=bind,src=${BACKBOARD_CONFIG},dst=/seed/backboard-config.json,readonly`,

    "--memory=700m",
    "--memory-swap=1g",

    "--cpus=0.85",

    "--pids-limit=128",

    "--cap-drop=ALL",

    "--security-opt=no-new-privileges",

    "--network=bridge",

    "-e",
    "DO_MODEL_KEY",

    AGENT_IMAGE,

    "--cwd",
    "/workspace",

    "--format",
    "json",

    "--permission-mode",
    "bypass",

    "--print",
    agentPrompt,
  ];

  const child = spawn(
    "docker",
    dockerArgs,
    {
      env: process.env,

      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    }
  );

  /*
   * Read Backboard's JSON stream.
   */
  const stdout =
    createInterface({
      input: child.stdout,
    });

  stdout.on(
    "line",
    (line) => {
      try {
        const event =
          JSON.parse(line);

        /*
         * Keep the original Backboard event
         * for debugging.
         */
        emitEvent(
          task,
          "backboard:event",
          event
        );

        /*
         * Translate it into human-readable progress.
         */
        const decision =
          inferProgress(
            event,
            {
              progress: task.progress,
              writeCount:
                task.writeCount,
            }
          );

        task.writeCount =
          decision.writeCount;

        if (decision.stage) {
          setProgress(
            task,
            decision.stage,
            decision.message ??
              decision.stage
          );
        }
      } catch {
        emitEvent(
          task,
          "backboard:stdout",
          {
            line,
          }
        );
      }
    }
  );

  const stderr =
    createInterface({
      input: child.stderr,
    });

  stderr.on(
    "line",
    (line) => {
      emitEvent(
        task,
        "backboard:stderr",
        {
          line,
        }
      );
    }
  );

  child.on(
    "error",
    (error) => {
      task.status =
        "failed";

      task.error =
        error.message;

      emitEvent(
        task,
        "task:error",
        {
          message:
            error.message,
        }
      );

      cleanupDocker(task);
    }
  );

  child.on(
    "close",
    (code) => {
      if (
        task.status ===
        "failed"
      ) {
        return;
      }

      if (code !== 0) {
        task.status =
          "failed";

        task.error =
          `Agent exited with code ${code}`;

        emitEvent(
          task,
          "task:error",
          {
            message:
              task.error,
          }
        );

        cleanupDocker(task);

        return;
      }

      /*
       * Preserve the successfully generated artifact
       * before destroying the sandbox.
       */
      const artifactPath =
        path.join(
          ARTIFACT_ROOT,
          task.id
        );

      fs.mkdirSync(
        artifactPath,
        {
          recursive: true,
        }
      );

      const copyResult =
        spawnSync(
          "docker",
          [
            "cp",
            `${task.containerName}:/workspace/.`,
            artifactPath,
          ],
          {
            encoding:
              "utf8",
          }
        );

      if (
        copyResult.status !== 0
      ) {
        task.status =
          "failed";

        task.error =
          copyResult.stderr ||
          "Failed to copy workspace.";

        emitEvent(
          task,
          "task:error",
          {
            message:
              task.error,
          }
        );

        cleanupDocker(task);

        return;
      }

      task.artifactPath =
        artifactPath;

      task.status =
        "waiting_for_approval";

      setProgress(
        task,
        "waiting_for_approval",
        "Build finished. Waiting for your approval."
      );

      emitEvent(
        task,
        "task:status",
        {
          status:
            task.status,

          artifactPath,
        }
      );

      /*
       * The generated result is preserved.
       * The agent environment is disposable.
       */
      cleanupDocker(task);
    }
  );
}

/*
 * Create a task.
 */
app.post(
  "/tasks",
  (req, res) => {
    const prompt =
      req.body?.prompt;

    if (
      typeof prompt !==
        "string" ||
      !prompt.trim()
    ) {
      return res
        .status(400)
        .json({
          error:
            "prompt is required",
        });
    }

    const id =
      randomUUID();

    const now =
      new Date()
        .toISOString();

    const task: Task = {
      id,

      prompt:
        prompt.trim(),

      status: "queued",

      progress:
        "planning",

      writeCount: 0,

      createdAt: now,
      updatedAt: now,

      containerName:
        `nene-task-${id}`,

      volumeName:
        `nene-volume-${id}`,

      events: [],
    };

    tasks.set(
      id,
      task
    );

    emitEvent(
      task,
      "task:created",
      {
        prompt:
          task.prompt,
      }
    );

    /*
     * Initial human-facing progress state.
     */
    emitEvent(
      task,
      "task:progress",
      {
        stage:
          "planning",

        message:
          "Understanding your request",
      }
    );

    res
      .status(202)
      .json(
        publicTask(task)
      );

    void runTask(task);
  }
);

/*
 * Continue working on an existing project.
 */
app.post(
  "/tasks/:id/continue",
  async (req, res) => {
    const previousTask =
      await getTask(
        req.params.id
      );

    if (!previousTask) {
      return res
        .status(404)
        .json({
          error:
            "Previous task not found",
        });
    }

    if (
      previousTask.status !==
      "completed"
    ) {
      return res
        .status(409)
        .json({
          error:
            "Previous task must be completed before continuing",
        });
    }

    if (!previousTask.artifactPath) {
      return res
        .status(409)
        .json({
          error:
            "Previous project artifact is unavailable",
        });
    }

    const prompt =
      req.body?.prompt;

    if (
      typeof prompt !==
        "string" ||
      !prompt.trim()
    ) {
      return res
        .status(400)
        .json({
          error:
            "prompt is required",
        });
    }

    const id =
      randomUUID();

    const now =
      new Date()
        .toISOString();

    const task: Task = {
      id,

      prompt:
        prompt.trim(),

      sourceTaskId:
        previousTask.id,

      status:
        "queued",

      progress:
        "planning",

      writeCount:
        0,

      createdAt:
        now,

      updatedAt:
        now,

      containerName:
        `nene-task-${id}`,

      volumeName:
        `nene-volume-${id}`,

      events:
        [],
    };

    tasks.set(
      id,
      task
    );

    emitEvent(
      task,
      "task:created",
      {
        prompt:
          task.prompt,

        sourceTaskId:
          previousTask.id,
      }
    );

    emitEvent(
      task,
      "task:progress",
      {
        stage:
          "planning",

        message:
          "Loading your existing project",
      }
    );

    res
      .status(202)
      .json(
        publicTask(task)
      );

    void runTask(task);
  }
);

/*
 * Current task state.
 */
app.get(
  "/tasks/:id",
  async (req, res) => {
    /*
     * Fast path: task still exists in RAM.
     */
    const task =
      tasks.get(
        req.params.id
      );

    if (task) {
      return res.json(
        publicTask(task)
      );
    }

    /*
     * Backend may have restarted.
     * Recover persisted task from MongoDB.
     */
    const storedTask =
      await findTask(
        req.params.id
      );

    if (!storedTask) {
      return res
        .status(404)
        .json({
          error:
            "Task not found",
        });
    }

    return res.json({
      id: storedTask.id,
      prompt: storedTask.prompt,

      status:
        storedTask.status,

      progress:
        storedTask.progress,

      createdAt:
        storedTask.createdAt,

      updatedAt:
        storedTask.updatedAt,

      artifactPath:
        storedTask.artifactPath,

      error:
        storedTask.error,
    });
  }
);

/*
 * Live task event stream.
 */
app.get(
  "/tasks/:id/events",
  async (req, res) => {
    const task =
     await getTask(
      req.params.id
     );

    if (!task) {
      return res
        .status(404)
        .json({
          error:
            "Task not found",
        });
    }

    res.setHeader(
      "Content-Type",
      "text/event-stream"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    res.flushHeaders();

    /*
     * Replay events that happened before
     * the client connected.
     */
    for (
      const event
      of task.events
    ) {
      res.write(
        `data: ${JSON.stringify(event)}\n\n`
      );
    }

    let clients =
      subscribers.get(
        task.id
      );

    if (!clients) {
      clients =
        new Set<Response>();

      subscribers.set(
        task.id,
        clients
      );
    }

    clients.add(res);

    const heartbeat =
      setInterval(
        () => {
          res.write(
            ": ping\n\n"
          );
        },
        15000
      );

    req.on(
      "close",
      () => {
        clearInterval(
          heartbeat
        );

        clients?.delete(
          res
        );
      }
    );
  }
);

/*
 * Human approval gate.
 */
app.post(
  "/tasks/:id/approve",
  async (req, res) => {
    const task =
      await getTask(
        req.params.id
      );

    if (!task) {
      return res
        .status(404)
        .json({
          error:
            "Task not found",
        });
    }

    if (
      task.status !==
      "waiting_for_approval"
    ) {
      return res
        .status(409)
        .json({
          error:
            "Task is not waiting for approval",

          status:
            task.status,
        });
    }

    if (!task.artifactPath) {
      return res
        .status(409)
        .json({
          error:
            "Task has no generated artifact to publish",
        });
    }

    try {
      let existingBranch:
  string | undefined;

if (task.sourceTaskId) {
  const sourceTask =
    await getTask(
      task.sourceTaskId
    );

  if (
    !sourceTask ||
    !sourceTask.github?.branch
  ) {
    return res
      .status(409)
      .json({
        error:
          "Previous project has no GitHub branch",
      });
  }

  existingBranch =
    sourceTask.github.branch;
}

const commitMessage =
  task.sourceTaskId
    ? `Update: ${task.prompt
        .replace(/\s+/g, " ")
        .slice(0, 72)}`
    : undefined;

const publication =
  await publishArtifactToGithub(
    task.id,
    task.artifactPath,
    {
      branch:
        existingBranch,

      commitMessage,
    }
  );

      task.github =
        publication;

      task.status =
        "completed";

      setProgress(
        task,
        "completed",
        "Task published to GitHub and completed."
      );

      emitEvent(
        task,
        "task:completed",
        {
          message:
            "User approved generated project and it was published to GitHub.",

          github:
            publication,
        }
      );

      return res.json(
        publicTask(task)
      );
    } catch (error) {
      console.error(
        "GitHub publication failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to publish generated project to GitHub",
        });
    }
  }
);

async function findPreviousDeployment(
  task: Task
): Promise<DeploymentInfo | undefined> {
  let sourceTaskId =
    task.sourceTaskId;

  const visited =
    new Set<string>();

  while (
    sourceTaskId &&
    !visited.has(sourceTaskId)
  ) {
    visited.add(
      sourceTaskId
    );

    const sourceTask =
      await getTask(
        sourceTaskId
      );

    if (!sourceTask) {
      return undefined;
    }

    if (
      sourceTask.deployment
        ?.serviceId
    ) {
      return sourceTask.deployment;
    }

    sourceTaskId =
      sourceTask.sourceTaskId;
  }

  return undefined;
}
       
/*
 * Deploy an approved project to Render.
 */
app.post(
  "/tasks/:id/deploy",
  async (req, res) => {
    const task =
      await getTask(
        req.params.id
      );

    if (!task) {
      return res
        .status(404)
        .json({
          error:
            "Task not found",
        });
    }

    if (
      task.status !==
      "completed"
    ) {
      return res
        .status(409)
        .json({
          error:
            "Task must be completed before deployment",

          status:
            task.status,
        });
    }

    if (!task.github) {
      return res
        .status(409)
        .json({
          error:
            "Task has not been published to GitHub",
        });
    }

    if (task.deployment) {
      return res
        .status(409)
        .json({
          error:
            "Deployment has already been started",

          deployment:
            task.deployment,
        });
    }

    /*
     * First state:
     * we are asking Render to create
     * the service.
     */
    task.deployment = {
      provider: "render",
      status: "creating",
    };

    task.updatedAt =
      new Date().toISOString();

    await saveTask(
      toStoredTask(task)
    );

    emitEvent(
      task,
      "deployment:creating",
      {
        message:
          "Creating Render service.",
      }
    );

    try {
      const previousDeployment =
  await findPreviousDeployment(
    task
  );

let serviceId: string;
let deployId: string;
let url: string | undefined;
let dashboardUrl:
  string | undefined;

if (
  previousDeployment?.serviceId
) {
  /*
   * Existing project:
   * deploy the new commit to the
   * SAME Render service.
   */
  const deploy =
    await triggerRenderDeploy(
      previousDeployment.serviceId,
      task.github.commit
    );

  serviceId =
    previousDeployment.serviceId;

  deployId =
    deploy.id;

  url =
    previousDeployment.url;

  dashboardUrl =
    previousDeployment.dashboardUrl;
} else {
  /*
   * First deployment:
   * create the Render service once.
   */
  const renderService =
    await createRenderService(
      task.id,
      task.github.branch,
      "app"
    );

  serviceId = renderService.serviceId;

  deployId = renderService.deployId;

  url =url;

  dashboardUrl =
    dashboardUrl;
}

      /*
       * Render accepted the service
       * and started its first deploy.
       */
      task.deployment = {
        provider: "render",
        status: "building",

        serviceId,
        deployId,
        url,
        dashboardUrl,
        //serviceId:
          //renderService.serviceId,

        //deployId:
          //renderService.deployId,

        //url:
         // renderService.url,

       // dashboardUrl:
       //   renderService.dashboardUrl,
      };

      task.updatedAt =
        new Date().toISOString();

      await saveTask(
        toStoredTask(task)
      );

      emitEvent(
        task,
        "deployment:building",
        {
          message:
            "Render is building the application.",

          serviceId: serviceId,

          deployId: deployId,

          url: url,
        }
      );

      /*
       * Return immediately.
       *
       * The phone does not need to keep
       * this HTTP request open while
       * Render builds the application.
       */
      res
        .status(202)
        .json(
          publicTask(task)
        );

      /*
       * Continue monitoring Render
       * in the background.
       */
      void (async () => {
        try {
          for (
            let attempt = 0;
            attempt < 120;
            attempt += 1
          ) {
            await new Promise(
              (resolve) =>
                setTimeout(
                  resolve,
                  5000
                )
            );

            const deploy =
              await getRenderDeploy(
                serviceId,
                deployId
              );

            if (
              deploy.status ===
              "live"
            ) {
              task.deployment = {
                provider:
                  "render",

                status:
                  "live",

                serviceId: serviceId,

                deployId:deployId,

                url:url,

                dashboardUrl:dashboardUrl,
              };

              task.updatedAt =
                new Date().toISOString();

              await saveTask(
                toStoredTask(task)
              );

              emitEvent(
                task,
                "deployment:live",
                {
                  message:
                    "Deployment is live.",

                  url:url,
                }
              );

              return;
            }

            const failedStatuses =
              [
                "build_failed",
                "update_failed",
                "pre_deploy_failed",
                "canceled",
                "deactivated",
              ];

            if (
              failedStatuses.includes(
                deploy.status
              )
            ) {
              task.deployment = {
                provider:
                  "render",

                status:
                  "failed",

                serviceId: serviceId,

                deployId:deployId,

                url:url,

                dashboardUrl:dashboardUrl,

                error:
                  `Render deployment failed with status: ${deploy.status}`,
              };

              task.updatedAt =
                new Date().toISOString();

              await saveTask(
                toStoredTask(task)
              );

              emitEvent(
                task,
                "deployment:failed",
                {
                  message:
                    "Render deployment failed.",

                  renderStatus:
                    deploy.status,
                }
              );

              return;
            }
          }

          /*
           * 120 × 5 seconds = 10 minutes.
           */
          task.deployment = {
            provider:
              "render",

            status:
              "failed",

            serviceId: serviceId,

            deployId:deployId,

            url:url,

            dashboardUrl:dashboardUrl,

            error:
              "Timed out while waiting for Render deployment.",
          };

          task.updatedAt =
            new Date().toISOString();

          await saveTask(
            toStoredTask(task)
          );

          emitEvent(
            task,
            "deployment:failed",
            {
              message:
                "Timed out while waiting for Render.",
            }
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error);

          task.deployment = {
            provider:
              "render",

            status:
              "failed",

            serviceId: serviceId,

            deployId:deployId,

            url:url,

            dashboardUrl:dashboardUrl,

            error:
              message,
          };

          task.updatedAt =
            new Date().toISOString();

          await saveTask(
            toStoredTask(task)
          );

          emitEvent(
            task,
            "deployment:failed",
            {
              message,
            }
          );
        }
      })();

      return;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        "Render deployment failed:",
        error
      );

      task.deployment = {
        provider: "render",
        status: "failed",
        error: message,
      };

      task.updatedAt =
        new Date().toISOString();

      await saveTask(
        toStoredTask(task)
      );

      emitEvent(
        task,
        "deployment:failed",
        {
          message,
        }
      );

      return res
        .status(500)
        .json({
          error:
            "Failed to start Render deployment",

          details:
            message,
        });
    }
  }
);

/*
 * Internal-only backend.
 * HTTPS reverse proxy will be placed in front later.
 */
async function start() {
  await connectDatabase();

  app.listen(
    PORT,
    "127.0.0.1",
    () => {
      console.log(
        `ne-ne backend listening on port ${PORT}`
      );
    }
  );
}

void start().catch(
  (error) => {
    console.error(
      "Failed to start ne-ne backend:",
      error
    );

    process.exit(1);
  }
);
