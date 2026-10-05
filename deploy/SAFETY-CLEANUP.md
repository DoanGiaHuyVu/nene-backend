# Safety cleanup and rollout

## Behavior

- A MongoDB transaction claims the project and global worker slot before a task is accepted. Concurrent requests receive HTTP 409. A successful sandbox releases the global slot; the project's pending approval keeps its project lock.
- Continuations resolve the project's latest approved successful task, validate its artifact, and record the source task/commit. Selecting a failed or older task never makes it the source revision.
- Approval publishes to the existing branch with a normal push. A run ID commit trailer reconciles a successful push whose acknowledgement was lost. A transaction then promotes both the task and project. Duplicate approvals return the publication already recorded.
- A deployment intent is persisted before a Render POST. Project-level locking prevents overlapping deployments. Later approved revisions use the same service ID. A deployment becomes canonical only when Render reports `live`; failed attempts retain the previous live metadata and allow retry.
- Ambiguous Render network/5xx responses are reconciled using service/deploy GETs rather than blindly repeating a POST. If the remote outcome remains unresolvable, the intent remains pending for operator reconciliation; a potentially accepted request is never duplicated just to clear the UI.
- Startup migrates old task chains into projects, recovers existing workers or marks lost workers interrupted, clears stale locks, and resumes Render monitoring. It preserves the newest historical approved branch and newest historical live service, including legacy chains that accidentally created additional branches/services.
- Tasks without a published successful revision remain historical records; they cannot be continued until a valid approved revision exists.

## Droplet resource limits

One coding worker globally; no extra queue or daemon. Coding and seeding containers use:

```text
--read-only
--memory=512m
--memory-swap=640m
--cpus=0.75
--pids-limit=128
--cap-drop=ALL
--security-opt=no-new-privileges
```

`/workspace` is the only writable mount. The small Backboard configuration is read-only and refers to the model key through its environment variable. The only host credential passed to the coding container is `DO_MODEL_KEY`. GitHub keys, Render keys, MongoDB credentials, the backend token, the Docker socket, and backend source stay outside the sandbox.

The new image is `nene-agent:0.3`. The existing `0.2` image can remain for rollback. No fixed agent execution timeout has been introduced. Host-side Docker management commands and Git/API calls have transport timeouts; these do not limit the coding run's lifetime. Render monitoring has no fixed deployment deadline and survives backend restarts.

New work requires at least 2 GB of free disk. Dependency caches are removed from the disposable volume before artifact extraction and omitted when seeding a continuation. Failed/interrupted artifact directories are eligible for deletion after seven days, during startup/admission maintenance. Approved and pending-approval artifacts are retained. Cleanup targets only UUID-named ne-ne task resources; it does not use global Docker pruning. Git clones are removed in `finally`, with stale app-owned clones removed after 24 hours.

Worker output lines and events are capped at 32 KB. Slow event stream clients are disconnected when their output buffer exceeds 128 KB, and can reconnect with `Last-Event-ID`. MongoDB uses a maximum pool of five connections.

## Persistence migration

The migration is additive and runs before HTTP admission at startup. It retains the existing `tasks` and `events` collections, annotates each task with `projectId` and `schemaVersion`, initializes missing event sequences, and adds lightweight `projects` and `locks` collections/indexes. Approval and admission use MongoDB transactions; the existing MongoDB Atlas replica set supports these.

A project stores its approved task/commit, branch, active run, Render service identity, live deployment, and deployment lock. A run stores the prompt, source revision, artifact, state, publication, errors, and deployment attempt. Existing task endpoints remain usable without a frontend project/run rewrite. `interrupted` is a terminal task status. Raw diagnostic details are persisted privately; API errors are concise and credentials are redacted from new diagnostic events/logs.

## Verify and deploy

```sh
npm run build
npm test
```

The normal suite uses local repositories and mocked integrations. An optional test verifies actual MongoDB transactions in a fresh, uniquely named database, then drops that test database:

```sh
NENE_TEST_MONGODB_URI="$MONGODB_URI" npm test
```

Use an isolated staging directory on the VM and its installed dependencies to compile/test before replacing production files. Build the new image from the updated `agent-image` directory after supplying the existing Linux Backboard executable. Back up the old source, compiled output, and agent setup before copying the tested files into their current locations. Caddy and the systemd definition need no changes.

The changes require one backend restart to activate. Do not restart automatically without explicit approval. On restart, check `/health`, authenticated retrieval of existing tasks, migration results, current branch/service/URL, Docker cleanup, and the service logs. Existing public Render applications remain separate from this backend rollout.

## Rollback

Keep a compressed backup of the previous `src`, `dist`, package/compiler files, and agent entrypoint. Restoring that backup and restarting reactivates the previous backend and its `nene-agent:0.2` image. The additive project documents can remain in MongoDB; no destructive database rollback is required. Old backend code does not enforce the new project/global admission locks, so rollback should be an operator-controlled temporary measure.
