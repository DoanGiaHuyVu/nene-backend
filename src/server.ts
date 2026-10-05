import { MongoStore } from "./db.js";
import { DockerRunner } from "./runner.js";
import { Backend } from "./backend.js";
import { createApp } from "./app.js";
import { flushTelemetry } from "./telemetry.js";

for (const key of ["MONGODB_URI", "DO_MODEL_KEY", "NENE_API_TOKEN"]) {
  if (!process.env[key]) throw new Error(`${key} is missing`);
}
const store = new MongoStore(process.env.MONGODB_URI!);
const runner = new DockerRunner(process.env.NENE_ROOT ?? "/home/nene/ne-ne", process.env.DO_MODEL_KEY!);
const secrets = ["MONGODB_URI", "DO_MODEL_KEY", "NENE_API_TOKEN", "RENDER_API_KEY"].map(key => process.env[key]).filter((value): value is string => Boolean(value));
const backend = new Backend(store, runner, undefined, secrets);

async function start() {
  await store.connect();
  await backend.recover();
  backend.startMonitoring();
  const server = createApp(backend, process.env.NENE_API_TOKEN!).listen(Number(process.env.NENE_PORT ?? 3001), "127.0.0.1", () => {
    console.log("ne-ne backend ready; one global coding worker, 512 MB container limit");
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    try { await backend.shutdown(); await flushTelemetry(); process.exit(0); }
    catch { console.error("Backend shutdown did not complete cleanly; startup recovery will reconcile persisted work"); process.exit(1); }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
void start().catch(async (error) => {
  backend.reportError("startup", error);
  await store.close().catch(() => {});
  await flushTelemetry();
  process.exit(1);
});
