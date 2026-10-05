import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ApiError, UUID, type Run, type LegacyRun } from "./model.js";
import { currentAttributes, lifecycle, operation } from "./telemetry.js";

const exec = promisify(execFile);
const IMAGE = "nene-agent:0.3";
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OMIT = new Set(["node_modules", ".next", ".cache", ".backboard", ".nene-agent", ".tmp", ".git", ".npm-cache"]);
export type AgentEvent = (type: string, data: unknown) => Promise<void>;
export interface Runner {
  checkCapacity(): Promise<void>;
  hasArtifact(run: Run): Promise<boolean>;
  run(run: Run, source: Run | undefined, emit: AgentEvent): Promise<string>;
  recover(run: Run, emit: AgentEvent): Promise<string | undefined>;
  cleanup(run: Run): Promise<void>;
  maintenance(runs: AsyncIterable<LegacyRun>, activeIds: Set<string>): Promise<void>;
  shutdown(): Promise<void>;
}

// Both the coder and short-lived seeding helpers have identical host resource limits.
export function sandboxArgs(): string[] {
  return ["--read-only", "--memory=512m", "--memory-swap=640m", "--cpus=0.75",
    "--pids-limit=128", "--cap-drop=ALL", "--security-opt=no-new-privileges"];
}

export class DockerRunner implements Runner {
  private children = new Map<string, ChildProcess>();
  private stopping = false;
  private artifactRoot: string;
  constructor(private root: string, private modelKey: string) { this.artifactRoot = path.join(root, "artifacts"); }
  private async docker(args: string[]) {
    const result = await exec("docker", args, { maxBuffer: 1024 * 1024, timeout: 30_000 });
    return result.stdout.trim();
  }
  private artifactPath(run: Run) {
    if (!UUID.test(run.id)) throw new Error("Invalid artifact owner");
    const expected = path.join(this.artifactRoot, run.id);
    if (run.artifactPath && path.resolve(run.artifactPath) !== expected) throw new Error("Artifact is outside its run directory");
    return expected;
  }
  async hasArtifact(run: Run) {
    try {
      const location = this.artifactPath(run);
      const actual = await fs.realpath(location);
      const app = await fs.realpath(path.join(location, "app"));
      const expected = path.join(await fs.realpath(this.artifactRoot), run.id);
      return actual === expected && app.startsWith(`${actual}${path.sep}`) && (await fs.stat(app)).isDirectory();
    } catch { return false; }
  }
  private async diskGuard() {
    await fs.mkdir(this.artifactRoot, { recursive: true });
    const disk = await fs.statfs(this.root);
    if (disk.bavail * disk.bsize < MIN_FREE_BYTES) throw new ApiError(507, "Not enough free disk space. At least 2 GB is required before starting new work.");
  }
  async checkCapacity() {
    if (this.stopping) throw new ApiError(503, "Backend is shutting down. Try again shortly.");
    await this.diskGuard();
    const active = await this.docker(["ps", "--format", "{{.Names}}"]);
    if (active.split("\n").some(name => /^nene-(task|seed|export)-/.test(name))) {
      throw new ApiError(409, "The coding agent is busy. Try again when the current run finishes.");
    }
  }
  private async container(run: Run) {
    try {
      return JSON.parse(await this.docker(["inspect", "--format", "{{json .State}}", run.containerName])) as { Running: boolean; ExitCode: number };
    } catch (error: any) {
      if (/No such (object|container)/i.test(String(error.stderr))) return undefined;
      throw error;
    }
  }
  private async stream(run: Run, args: string[], emit: AgentEvent): Promise<void> {
    const child = spawn("docker", args, {
      // Host-only secrets are not passed even to the docker CLI process.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DO_MODEL_KEY: this.modelKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(run.id, child);
    const ended = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`Agent exited with code ${code}`)));
    });
    // Attach a rejection handler immediately while stdout/stderr are being consumed.
    void ended.catch(() => {});
    const read = async (stream: NodeJS.ReadableStream, stderr: boolean) => {
      const decoder = new StringDecoder("utf8");
      let pending = "", truncated = false;
      const flush = async () => {
        const line = pending;
        pending = "";
        if (stderr || truncated) {
          await emit(stderr ? "backboard:stderr" : "backboard:stdout", { line, truncated });
        } else {
          let event: unknown;
          try { event = JSON.parse(line); }
          catch { await emit("backboard:stdout", { line }); truncated = false; return; }
          await emit("backboard:event", event);
        }
        truncated = false;
      };
      const consume = async (text: string) => {
        const parts = text.split("\n");
        for (let i = 0; i < parts.length; i++) {
          if (pending.length + parts[i].length > 32_768) truncated = true;
          pending += parts[i].slice(0, Math.max(0, 32_768 - pending.length));
          if (i < parts.length - 1) await flush();
        }
      };
      for await (const chunk of stream) await consume(decoder.write(Buffer.from(chunk)));
      await consume(decoder.end());
      if (pending || truncated) await flush();
    };
    try {
      await Promise.all([ended, read(child.stdout!, false), read(child.stderr!, true)]);
      if (this.stopping) throw new Error("Backend shutdown interrupted the coding run");
    } finally { this.children.delete(run.id); }
  }
  private async prune(location: string, root = location) {
    for (const entry of await fs.readdir(location, { withFileTypes: true })) {
      const file = path.join(location, entry.name);
      if (OMIT.has(entry.name) || (entry.name === ".env" || entry.name.startsWith(".env.")) && entry.name !== ".env.example") {
        await fs.rm(file, { recursive: true, force: true });
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(file);
        const resolved = path.resolve(location, target);
        if (path.isAbsolute(target) || !resolved.startsWith(`${root}${path.sep}`)) await fs.unlink(file);
      } else if (entry.isDirectory()) await this.prune(file, root);
      else if (!entry.isFile()) await fs.rm(file, { force: true });
    }
  }
  private async preserve(run: Run) {
    await this.diskGuard();
    const artifact = this.artifactPath(run);
    await fs.mkdir(artifact, { recursive: true });
    try {
      // Strip dependency caches in the disposable volume before copying them to disk.
      await this.docker(["run", "--rm", "--name", `nene-seed-${run.id}`, ...sandboxArgs(), "--network=none",
        "--entrypoint", "sh", "--mount", `type=volume,source=${run.volumeName},target=/workspace`, IMAGE, "-c",
        "find /workspace -mindepth 1 \\( -name node_modules -o -name .next -o -name .cache -o -name .nene-agent -o -name .tmp -o -name .backboard -o -name .git \\) -prune -exec rm -rf -- {} +"]);
      await this.docker(["cp", `${run.containerName}:/workspace/.`, artifact]);
      await this.prune(artifact);
      if (!await this.hasArtifact({ ...run, artifactPath: artifact })) throw new Error("Agent produced no valid app directory");
      return artifact;
    } catch (error) {
      await fs.rm(artifact, { recursive: true, force: true });
      throw error;
    }
  }
  async run(run: Run, source: Run | undefined, emit: AgentEvent) {
    try {
      await this.diskGuard();
      await operation(run, "create workspace volume", "nene.workspace.create", () => this.docker(["volume", "create", run.volumeName]));
      if (source) {
        if (!await this.hasArtifact(source)) throw new Error("Approved project artifact is unavailable");
        await operation(run, "load approved workspace", "nene.workspace.seed", () => this.docker(["run", "--rm", "--name", `nene-seed-${run.id}`, ...sandboxArgs(), "--network=none",
          "--entrypoint", "sh", "--mount", `type=volume,source=${run.volumeName},target=/workspace`,
          "--mount", `type=bind,src=${path.join(this.artifactPath(source), "app")},dst=/source-app,readonly`,
          IMAGE, "-c", "mkdir -p /workspace/app && tar --exclude=node_modules --exclude=.next --exclude=.cache --exclude=.git --exclude=\'.env*\' -cf - -C /source-app . | tar -xf - -C /workspace/app && chmod -R a+rwX /workspace/app"]), { "nene.artifact.exists": true });
        lifecycle("Existing project loaded", run);
        await emit("project:loaded", { sourceTaskId: source.id, message: "Loaded the latest approved project revision" });
      }
      const instruction = source ? `You are modifying the existing project in /workspace/app. Inspect it first; preserve working functionality. Do not recreate it unless necessary.\n\nThe user wants this change:\n${run.prompt}` : run.prompt;
      const prompt = `${instruction}\n\nBefore declaring completion, run the appropriate build, test, lint, type-check, or syntax checks and fix errors.\nCreate the deployable application inside /workspace/app, including a Dockerfile.\nListen on 0.0.0.0 and read PORT (default 10000). The Dockerfile must start the production app.\nThe basic application must not require secrets to display. Do not run Docker yourself.`;
      await operation(run, "Docker Backboard execution", "nene.agent.execute", async () => {
      await this.stream(run, ["run", "--name", run.containerName, ...sandboxArgs(), "--network=bridge",
        "--mount", `type=volume,source=${run.volumeName},target=/workspace`,
        "--mount", `type=bind,src=${path.join(this.root, "agent-image/backboard-config.json")},dst=/seed/backboard-config.json,readonly`,
        "-e", "DO_MODEL_KEY", IMAGE, "--cwd", "/workspace", "--format", "json", "--permission-mode", "bypass", "--print", prompt], emit);
      currentAttributes({ "nene.agent.exit_code": 0 });
      }, { "nene.container.name": run.containerName, "gen_ai.request.model": "gemma-4-31B-it" });
      return await operation(run, "preserve artifact", "nene.artifact.preserve", () => this.preserve(run));
    } finally { await this.cleanup(run); }
  }
  async recover(run: Run, emit: AgentEvent) {
    try {
      const state = await this.container(run);
      if (!state) return undefined;
      if (state.Running) {
        await operation(run, "recover Docker execution", "nene.agent.recover", () => this.stream(run, ["logs", "--follow", "--tail", "0", run.containerName], emit), { "nene.recovered": true });
        const exit = Number(await this.docker(["wait", run.containerName]));
        if (exit !== 0) throw new Error(`Recovered agent exited with code ${exit}`);
      } else if (state.ExitCode !== 0) throw new Error(`Interrupted agent exited with code ${state.ExitCode}`);
      return await operation(run, "preserve artifact", "nene.artifact.preserve", () => this.preserve(run));
    } finally { await this.cleanup(run); }
  }
  async cleanup(run: Run) {
    const errors: unknown[] = [];
    for (const name of [run.containerName, `nene-seed-${run.id}`]) {
      try { await this.docker(["rm", "-f", name]); }
      catch (error: any) { if (!/No such (container|object)/i.test(String(error.stderr))) errors.push(error); }
    }
    try { await this.docker(["volume", "rm", "-f", run.volumeName]); }
    catch (error: any) { if (!/no such volume/i.test(String(error.stderr))) errors.push(error); }
    if (errors.length) throw new Error(`Docker cleanup failed: ${errors.map(String).join("; ")}`);
  }
  async maintenance(runs: AsyncIterable<LegacyRun>, activeIds: Set<string>) {
    // Scope cleanup to this app's UUID-named resources; never docker system prune.
    const names = (await this.docker(["ps", "-a", "--format", "{{.Names}}"])).split("\n");
    for (const name of names) {
      const match = /^nene-(?:task|seed)-(.+)$/.exec(name);
      if (match && UUID.test(match[1]) && !activeIds.has(match[1])) await this.docker(["rm", "-f", name]);
    }
    const volumes = (await this.docker(["volume", "ls", "--format", "{{.Name}}"])).split("\n");
    for (const name of volumes) {
      const id = name.replace(/^nene-volume-/, "");
      if (name.startsWith("nene-volume-") && UUID.test(id) && !activeIds.has(id)) await this.docker(["volume", "rm", name]);
    }
    for await (const run of runs) {
      if (["failed", "interrupted"].includes(run.status) && Date.now() - Date.parse(run.updatedAt) > RETENTION_MS && UUID.test(run.id)) {
        await fs.rm(path.join(this.artifactRoot, run.id), { recursive: true, force: true });
      }
    }
    // Git clones contain no canonical artifacts. Remove only app-owned stale temp dirs.
    for (const entry of await fs.readdir("/tmp", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^nene-github-[A-Za-z0-9]+$/.test(entry.name)) continue;
      const file = path.join("/tmp", entry.name);
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await fs.rm(file, { recursive: true, force: true });
    }
  }
  async shutdown() {
    this.stopping = true;
    for (const [id, child] of this.children) {
      await this.docker(["rm", "-f", `nene-task-${id}`]).catch(() => {});
      child.kill("SIGTERM");
    }
  }
}
