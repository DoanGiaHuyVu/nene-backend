# View Changes rollout

`GET /tasks/:id/changes` uses the existing bearer authentication. It reads only
`artifacts/<run UUID>/app` on the host. It neither approves nor publishes nor
deploys, and does not modify artifacts or MongoDB records. Temporary diff input
files are private OS temp files removed in `finally`; Git runs outside the agent.
No new dependency, database migration, environment variable, or worker image is
required.

## Baseline and availability

Waiting-for-approval runs and published completed runs are reviewable. Failed,
interrupted, queued, and running runs return 409. Initial runs have an empty
baseline. Continuations use their persisted `sourceTaskId` and `sourceCommit`,
validated against a published completed run in the same project. They never use
the project's currently latest revision for a historical diff. Missing baseline
artifacts or legacy builds without `/app` return 409, rather than reporting a
misleading initial build. Missing tasks return 404 and malformed IDs return 400.

## Response

The JSON contains `taskId`, optional `baseTaskId`, `initialBuild`, `summary`,
`files`, `truncated`, and `omittedFiles`. Summary contains `filesChanged`,
`additions`, `deletions`, and `countsComplete`. Each file has a relative `app/`
path, added/modified/deleted status, additions/deletions, countsComplete, and
optional patch, binary, symlink, truncated, and reason flags. Patches contain
unified hunks, never absolute host filenames. Empty files and executable/type-only
changes are included. Symlinks are shown as link text and never dereferenced.

Binary content has no text patch and incomplete text counts. Files over 256 KiB
have no patch. Oversized patches are cut at a complete line; their counts are
partial. Omitted response patches can still have complete counts if Git finished.
The UI explicitly labels partial counts and omitted files.

## Resource limits

- One diff request at a time; concurrent requests return 429 without a queue.
- 15-second total timeout, 10,000 total filesystem entries, 50 nested directories.
- Stream SHA-256 reads; 64 MiB maximum file data read across both trees per request.
  Excessive entry counts, nesting, or read volume return 413.
- At most 300 file records, about 50 KiB per patch and under 200 KiB serialized JSON.
  All changed files are counted, but extra file records are omitted explicitly.
- Git subprocesses have external diff and text conversion disabled, isolated
  configuration, bounded output, and a timeout that kills the subprocess.
- Ignore dependencies, Git metadata, build output, caches, tmp, environment files,
  logs, and .DS_Store at every directory depth. No symlink traversal or special
  file reads; file descriptors use O_NOFOLLOW.

The review intentionally covers the application under `/app`; host-level
Backboard metadata and files outside the application are excluded.

## Frontend

The Next.js proxy `GET /api/tasks/[id]/changes` reads the existing server-only
NENE_BACKEND_URL and NENE_API_TOKEN. Responses are uncached. Opening View Changes
mounts a review panel and fetches lazily; closing, navigating, or starting a new
run discards the panel and aborts its request. Patches render as React text with
colored lines and horizontal scrolling. Approval uses the existing action and
remains explicit. Published historical builds offer View revision.

## Install and rollback

Build/test the backend in a staged release directory on the VM before replacing
production source and dist. Keep a backup of the previous files. This feature
does not change systemd, Caddy, Docker images, credentials, database schema,
GitHub branch management, or Render deployment management.

After installing, the running Node process retains its previous code until
restart. Do not restart production automatically. Obtain explicit approval for
this release, then verify health and the authenticated changes endpoint. Deploy
the frontend after the backend endpoint is active; before then, the new UI shows
a retryable error if an old backend returns 404.

Rollback by restoring the prior source/dist files from the release backup and
restarting with authorization. The frontend's previous commit restores its old
placeholder; runtime data and existing Render apps require no rollback.
