import express, { type Response, type ErrorRequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import type { Backend } from "./backend.js";
import { ApiError, publicRun, type TaskEvent } from "./model.js";

export function createApp(backend: Backend, apiToken: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "ne-ne" }));
  const expected = Buffer.from(`Bearer ${apiToken}`);
  app.use((req, res, next) => {
    const actual = Buffer.from(req.get("authorization") ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.status(401).json({ error: "Unauthorized" });
    next();
  });
  app.post("/tasks", async (req, res) => res.status(202).json(await backend.create(req.body?.prompt, undefined, req.body?.projectId)));
  app.post("/tasks/:id/continue", async (req, res) => res.status(202).json(await backend.create(req.body?.prompt, req.params.id, req.body?.projectId)));
  app.get("/tasks/:id", async (req, res) => res.json(publicRun(await backend.getTask(req.params.id))));
  app.get("/tasks/:id/changes", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await backend.getChanges(req.params.id));
  });
  app.post("/tasks/:id/approve", async (req, res) => res.json(await backend.approve(req.params.id)));
  app.post("/tasks/:id/deploy", async (req, res) => {
    const run = await backend.deploy(req.params.id);
    res.status(run.deployment?.status === "live" ? 200 : 202).json(run);
  });
  app.get("/tasks/:id/events", async (req, res) => {
    const run = await backend.getTask(req.params.id);
    const lastId = req.get("Last-Event-ID") ?? "0";
    if (!/^\d{1,12}$/.test(lastId)) throw new ApiError(400, "Invalid event cursor");
    let last = Number(lastId), replaying = true, bytes = 0;
    const buffered: TaskEvent[] = [];
    const write = (event: TaskEvent) => {
      if (res.destroyed || event.seq <= last) return;
      if (res.writableLength > 128 * 1024) { res.destroy(); return; }
      last = event.seq;
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = backend.subscribe(run.id, event => {
      if (!replaying) write(event);
      else {
        bytes += JSON.stringify(event).length;
        if (bytes > 128 * 1024) res.destroy();
        else buffered.push(event);
      }
    });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": ping\n\n"); }, 15000);
    const close = () => { clearInterval(heartbeat); unsubscribe(); };
    res.once("close", close);
    try {
      for await (const event of backend.store.events(run.id, last)) {
        if (res.destroyed) break;
        write(event);
      }
      replaying = false;
      for (const event of buffered.sort((a, b) => a.seq - b.seq)) write(event);
    } catch (error) { close(); res.destroy(); throw error; }
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    const status = error instanceof ApiError ? error.status : error.type === "entity.too.large" ? 413 : error instanceof SyntaxError ? 400 : 500;
    // Verbose integration/worker failures are logged by Backend; never return their stacks.
    res.status(status).json({ error: error instanceof ApiError ? error.message : status === 400 ? "Invalid JSON request" : status === 413 ? "Request is too large" : "Backend request failed. Try again shortly." });
  };
  app.use(errors);
  return app;
}
