import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync =
  promisify(execFile);

const GITHUB_REPO =
  process.env.NENE_GITHUB_REPO ?? "git@github.com:DoanGiaHuyVu/nene-build.git";

const GITHUB_WEB_REPO =
  process.env.NENE_GITHUB_WEB_REPO ?? "https://github.com/DoanGiaHuyVu/nene-build";

const SSH_KEY =
  "/home/nene/.ssh/nene_github";

const PUBLISH_IGNORE =
  process.env.NENE_PUBLISH_IGNORE ?? "/home/nene/ne-ne/publish.gitignore";

async function git(
  cwd: string,
  args: string[]
) {
  return execFileAsync(
    "git",
    args,
    {
      cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_SSH_COMMAND:
          `ssh -i ${SSH_KEY} -o IdentitiesOnly=yes`,
      },
    }
  );
}

export type GithubPublishResult = {
  branch: string;
  url: string;
  commit: string;
};

type PublishOptions = {
  branch?: string;
  commitMessage?: string;
  expectedCommit?: string;
};

async function configureRepo(
  repoDir: string
) {
  await git(repoDir, [
    "config",
    "user.name",
    "ne-ne",
  ]);

  await git(repoDir, [
    "config",
    "user.email",
    "nene-agent@users.noreply.github.com",
  ]);

  const gitInfoDir =
    path.join(
      repoDir,
      ".git",
      "info"
    );

  await fs.mkdir(
    gitInfoDir,
    {
      recursive: true,
    }
  );

  const ignoreContents =
    await fs.readFile(
      PUBLISH_IGNORE,
      "utf8"
    );

  await fs.writeFile(
    path.join(
      gitInfoDir,
      "exclude"
    ),
    ignoreContents
  );
}

async function replaceWorktree(
  artifactDir: string,
  repoDir: string
) {
  /*
   * Remove the previous checked-out project,
   * but keep Git history.
   */
  const oldEntries =
    await fs.readdir(repoDir);

  for (const entry of oldEntries) {
    if (entry === ".git") {
      continue;
    }

    await fs.rm(
      path.join(
        repoDir,
        entry
      ),
      {
        recursive: true,
        force: true,
      }
    );
  }

  /*
   * Copy the newly generated artifact
   * into the existing repository.
   */
  const newEntries =
    await fs.readdir(
      artifactDir
    );

  for (const entry of newEntries) {
    if (entry === ".git") {
      continue;
    }

    await fs.cp(
      path.join(
        artifactDir,
        entry
      ),
      path.join(
        repoDir,
        entry
      ),
      {
        recursive: true,
        force: true,
        dereference: false,
        verbatimSymlinks: true,
        filter: (source) => ![".git", "node_modules", ".next", ".backboard", ".nene-agent", ".tmp"].includes(path.basename(source)),
      }
    );
  }
}

export async function publishArtifactToGithub(
  taskId: string,
  artifactDir: string,
  options: PublishOptions = {}
): Promise<GithubPublishResult> {
  const shortId =
    taskId.slice(0, 8);

  /*
   * Initial build:
   * create task/<original-id>.
   *
   * Continuation:
   * reuse the existing branch.
   */
  const branch =
    options.branch ??
    `task/${shortId}`;

  await fs.access(
    artifactDir
  );

  const tempRoot =
    await fs.mkdtemp(
      "/tmp/nene-github-"
    );

  const repoDir =
    path.join(
      tempRoot,
      "repo"
    );

  try {
    const remote = await git(tempRoot, ["ls-remote", "--heads", GITHUB_REPO, `refs/heads/${branch}`]);
    if (remote.stdout.trim()) {
      /*
       * CONTINUATION:
       *
       * Clone the existing branch so the
       * previous commit becomes the parent
       * of the new commit.
       */
      await git(
        tempRoot,
        [
          "clone",
          "--branch",
          branch,
          "--single-branch",
          GITHUB_REPO,
          repoDir,
        ]
      );
    } else {
      /*
       * INITIAL PROJECT:
       *
       * Start a new repository/branch.
       */
      await fs.mkdir(
        repoDir,
        {
          recursive: true,
        }
      );

      await git(
        repoDir,
        [
          "init",
        ]
      );

      await git(
        repoDir,
        [
          "checkout",
          "-B",
          branch,
        ]
      );

      await git(
        repoDir,
        [
          "remote",
          "add",
          "origin",
          GITHUB_REPO,
        ]
      );
    }

    // A previous push may have succeeded before the backend lost its response.
    // The run trailer makes retry/restart recovery return that same publication.
    if (remote.stdout.trim()) {
      const history = await git(repoDir, ["log", "--max-count=50", "--format=%H%x00%(trailers:key=Nene-Run,valueonly)"]);
      const existing = history.stdout.split("\n").find(line => line.split("\0")[1]?.trim() === taskId);
      if (existing) {
        const commit = existing.split("\0")[0];
        if (remote.stdout.trim().split(/\s+/)[0] !== commit) throw new Error("Project branch advanced after publication; reconciliation required");
        return { branch, commit, url: `${GITHUB_WEB_REPO}/tree/${branch}` };
      }
      const head = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      if (!options.expectedCommit || head !== options.expectedCommit) {
        throw new Error("Project branch has changed since the source revision; publication refused");
      }
    } else if (options.expectedCommit) {
      throw new Error("Approved project branch is missing; publication refused");
    }

    await configureRepo(
      repoDir
    );

    await replaceWorktree(
      artifactDir,
      repoDir
    );

    await git(
      repoDir,
      [
        "add",
        "-A",
      ]
    );

    const {
      stdout: status,
    } =
      await git(
        repoDir,
        [
          "status",
          "--porcelain",
        ]
      );

    /*
     * A no-op continuation is allowed.
     */
    if (status.trim()) {
      await git(
        repoDir,
        [
          "commit",
          "-m",
          `${options.commitMessage ?? `Build generated by ne-ne (${shortId})`}\n\nNene-Run: ${taskId}`,
        ]
      );
    }

    /*
     * Crucially:
     *
     * NO --force here.
     *
     * Continuations extend Git history.
     */
    await git(
      repoDir,
      [
        "push",
        "-u",
        "origin",
        branch,
      ]
    );

    const {
      stdout: commit,
    } =
      await git(
        repoDir,
        [
          "rev-parse",
          "HEAD",
        ]
      );

    return {
      branch,
      commit:
        commit.trim(),

      url:
        `${GITHUB_WEB_REPO}/tree/${branch}`,
    };
  } finally {
    await fs.rm(
      tempRoot,
      {
        recursive: true,
        force: true,
      }
    );
  }
}
