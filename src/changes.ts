import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { ApiError, UUID, type Run } from "./model.js";

const TEXT_BYTES = 256 * 1024;
const PATCH_BYTES = 50 * 1024;
const RESPONSE_BYTES = 200 * 1024;
const HASH_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_FILES = 300;
const OMIT = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "tmp", ".tmp",
  ".cache", ".backboard", ".nene-agent", ".npm-cache", ".DS_Store"]);

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  patch?: string;
  binary?: boolean;
  symlink?: boolean;
  truncated?: boolean;
  countsComplete: boolean;
  reason?: "large_file" | "patch_limit" | "response_limit" | "file_limit";
}
export interface Changes {
  taskId: string;
  baseTaskId?: string;
  initialBuild: boolean;
  summary: { filesChanged: number; additions: number; deletions: number; countsComplete: boolean };
  files: FileChange[];
  truncated: boolean;
  omittedFiles: number;
}
interface Entry { location: string; size: number; link?: string; executable: boolean }
interface Budget { signal: AbortSignal; bytes: number; entries: number }

function check(budget: Budget) {
  if (budget.signal.aborted) throw new ApiError(503, "Changes took too long to load. Please retry.");
}
function ignored(name: string) { return OMIT.has(name) || name === ".env" || name.startsWith(".env.") || name.endsWith(".log"); }

// Artifacts are immutable once ready. Reject redirected roots and never follow file/directory symlinks.
async function appRoot(root: string, run: Run) {
  if (!UUID.test(run.id) || !run.artifactPath) throw new ApiError(409, "Generated application is unavailable for this build.");
  const expected = path.join(path.resolve(root), "artifacts", run.id);
  if (path.resolve(run.artifactPath) !== expected) throw new ApiError(409, "Generated application is unavailable for this build.");
  try {
    const artifacts = await fs.realpath(path.join(root, "artifacts"));
    const actual = await fs.realpath(expected);
    const app = path.join(actual, "app");
    if (actual !== path.join(artifacts, run.id) || (await fs.realpath(app)) !== app || !(await fs.lstat(app)).isDirectory()) throw new Error("Redirected artifact");
    return app;
  } catch { throw new ApiError(409, "Generated application is unavailable for this build."); }
}

async function enumerate(root: string, budget: Budget) {
  const result = new Map<string, Entry>();
  async function walk(directory: string, prefix: string, depth: number) {
    check(budget);
    if (depth > 50) throw new ApiError(413, "Application contains too many nested directories to review.");
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      check(budget);
      if (++budget.entries > MAX_ENTRIES) throw new ApiError(413, "Application contains too many files to review.");
      if (ignored(entry.name)) continue;
      const location = path.join(directory, entry.name), relative = prefix + entry.name;
      const stat = await fs.lstat(location);
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(location);
        result.set(relative, { location, size: Buffer.byteLength(link), link, executable: false });
      } else if (stat.isDirectory()) await walk(location, relative + "/", depth + 1);
      else if (stat.isFile()) result.set(relative, { location, size: stat.size, executable: Boolean(stat.mode & 0o111) });
      // Sockets, devices, and pipes are never read.
    }
  }
  await walk(root, "", 0);
  return result;
}

async function readEntry(entry: Entry, budget: Budget, collect: boolean) {
  check(budget);
  if (entry.link !== undefined) return { hash: createHash("sha256").update(entry.link).digest("hex"), data: Buffer.from(entry.link) };
  const hash = createHash("sha256"), chunks: Buffer[] = [];
  // O_NOFOLLOW prevents a file replaced by a symlink from exposing host files.
  const handle = await fs.open(entry.location, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Artifact entry changed type");
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 16 * 1024, signal: budget.signal });
    let collected = 0;
    for await (const chunk of stream) {
      check(budget);
      const buffer = chunk as Buffer;
      budget.bytes += buffer.length;
      if (budget.bytes > HASH_BYTES) { stream.destroy(); throw new ApiError(413, "Application is too large to review safely."); }
      hash.update(buffer);
      if (collect && (collected += buffer.length) <= TEXT_BYTES) chunks.push(buffer);
      else if (collect) throw new Error("Artifact file grew during review");
    }
    return { hash: hash.digest("hex"), data: collect ? Buffer.concat(chunks) : undefined };
  } finally { await handle.close(); }
}
function binary(data: Buffer) {
  if (data.includes(0)) return true;
  try { new TextDecoder("utf-8", { fatal: true }).decode(data); return false; } catch { return true; }
}

async function patch(old: Buffer, current: Buffer, budget: Budget) {
  if (old.equals(current)) return { text: "", truncated: false };
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nene-diff-"));
  try {
    await fs.writeFile(path.join(temporary, "old"), old);
    await fs.writeFile(path.join(temporary, "new"), current);
    check(budget);
    const output = await new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
      const child = spawn("git", ["-c", "core.attributesFile=/dev/null", "diff", "--no-index", "--no-ext-diff",
        "--no-textconv", "--no-color", "--no-renames", "--text", "--unified=3", "--", "old", "new"], {
        cwd: temporary, signal: budget.signal, killSignal: "SIGKILL",
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const buffers: Buffer[] = []; let bytes = 0, truncated = false;
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = PATCH_BYTES - bytes;
        if (remaining > 0) { buffers.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining); }
        if (chunk.length > remaining) { truncated = true; child.kill("SIGKILL"); }
      });
      child.stderr.resume();
      child.once("error", reject);
      child.once("close", code => {
        if (budget.signal.aborted) reject(new ApiError(503, "Changes took too long to load. Please retry."));
        else if (truncated || code === 0 || code === 1) {
          const raw = Buffer.concat(buffers).toString("utf8"), start = raw.indexOf("@@");
          let text = start < 0 ? "" : raw.slice(start);
          if (truncated) text = text.slice(0, text.lastIndexOf("\n") + 1);
          resolve({ text, truncated });
        } else reject(new Error(`Diff process exited with code ${code}`));
      });
    });
    return output;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export class ChangesReader {
  private busy = false;
  constructor(private root: string = process.env.NENE_ROOT ?? "/home/nene/ne-ne") {}
  async read(run: Run, base?: Run): Promise<Changes> {
    if (this.busy) throw new ApiError(429, "Another review is loading. Please retry shortly.");
    this.busy = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    const budget: Budget = { signal: controller.signal, bytes: 0, entries: 0 };
    try {
      const newRoot = await appRoot(this.root, run);
      const oldRoot = base ? await appRoot(this.root, base) : undefined;
      const oldFiles = oldRoot ? await enumerate(oldRoot, budget) : new Map<string, Entry>();
      const newFiles = await enumerate(newRoot, budget);
      const response: Changes = { taskId: run.id, baseTaskId: base?.id, initialBuild: !base,
        summary: { filesChanged: 0, additions: 0, deletions: 0, countsComplete: true }, files: [], truncated: false, omittedFiles: 0 };
      let responseBytes = 1024;
      for (const name of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
        check(budget);
        const previous = oldFiles.get(name), current = newFiles.get(name);
        const before = previous ? await readEntry(previous, budget, previous.size <= TEXT_BYTES) : undefined;
        const after = current ? await readEntry(current, budget, current.size <= TEXT_BYTES) : undefined;
        if (previous && current && before?.hash === after?.hash && (previous.link === undefined) === (current.link === undefined) && previous.executable === current.executable) continue;
        response.summary.filesChanged++;
        const file: FileChange = { path: `app/${name}`, status: !previous ? "added" : !current ? "deleted" : "modified", additions: 0, deletions: 0, countsComplete: true };
        if (previous?.link !== undefined || current?.link !== undefined) file.symlink = true;
        if (response.files.length >= MAX_FILES || responseBytes + Buffer.byteLength(JSON.stringify(file)) > RESPONSE_BYTES - 1024) {
          response.omittedFiles++; response.truncated = true; response.summary.countsComplete = false; continue;
        }
        if ((before?.data && binary(before.data)) || (after?.data && binary(after.data))) { file.binary = true; file.countsComplete = false; }
        else if ((previous && !before?.data) || (current && !after?.data)) { file.truncated = true; file.reason = "large_file"; file.countsComplete = false; }
        else {
          const result = await patch(before?.data ?? Buffer.alloc(0), after?.data ?? Buffer.alloc(0), budget);
          file.patch = result.text;
          for (const line of result.text.split("\n")) {
            if (line.startsWith("+")) file.additions++;
            else if (line.startsWith("-")) file.deletions++;
          }
          if (result.truncated) { file.truncated = true; file.reason = "patch_limit"; file.countsComplete = false; }
          // Report executable/type-only changes, which an ordinary textual patch cannot convey.
          if (previous && current && previous.executable !== current.executable) file.patch = `File mode: ${previous.executable ? "executable" : "regular"} → ${current.executable ? "executable" : "regular"}\n` + file.patch;
          if (previous && current && (previous.link === undefined) !== (current.link === undefined)) file.patch = `File type: ${previous.link === undefined ? "regular" : "symlink"} → ${current.link === undefined ? "regular" : "symlink"}\n` + file.patch;
        }
        let encoded = Buffer.byteLength(JSON.stringify(file));
        if (responseBytes + encoded > RESPONSE_BYTES - 1024) {
          delete file.patch; file.truncated = true; file.reason = "response_limit";
          // Counts remain exact if Git completed; only the patch is omitted.
          encoded = Buffer.byteLength(JSON.stringify(file));
        }
        responseBytes += encoded + 1;
        response.summary.additions += file.additions; response.summary.deletions += file.deletions;
        response.summary.countsComplete &&= file.countsComplete;
        response.truncated ||= Boolean(file.truncated);
        response.files.push(file);
      }
      check(budget);
      return response;
    } catch (error) {
      check(budget);
      throw error;
    } finally { clearTimeout(timer); this.busy = false; }
  }
}
