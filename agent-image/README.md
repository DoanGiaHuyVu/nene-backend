# Backboard agent image

The Dockerfile, entrypoint, and provider configuration were copied from the VM.
The configuration refers to `DO_MODEL_KEY` through an environment variable;
it contains no API key.

The Dockerfile requires an executable named `backboard` in this directory.
The existing executable is an 85.7 MB Linux x86_64 binary, excluded from Git.
To obtain that exact executable without modifying the VM, run from the repository root:

```sh
scp nene@165.245.234.34:/home/nene/ne-ne/agent-image/backboard agent-image/backboard
chmod +x agent-image/backboard
shasum -a 256 agent-image/backboard
```

Expected SHA-256:

```text
3e3faba6e31fecd988ed21ec35b7402a54218e1e3f4648c61597795b6807b7c2
```

Then build on a Linux x86_64 Docker host, or select that platform explicitly:

```sh
docker build --platform linux/amd64 -t nene-agent:0.2 agent-image
```

The VM also has a source checkout of
[Backboard-R-CLI](https://github.com/Backboard-io/Backboard-R-CLI)
at commit `960c430754f42823b4153ad6a5cd2ccadd5641e5`, package version `3.0.4`.
Its build command is `bun run build`, which compiles `src/entrypoints/cli.tsx`
into the `backboard` executable. Rebuilding from that checkout requires Bun
and its dependencies; identical binary output has not been verified.

The backend mounts `backboard-config.json` into each agent container at
`/seed/backboard-config.json`. The entrypoint copies it into writable temporary
storage and starts Backboard. Containers use a read-only root filesystem,
a workspace volume, resource limits, dropped capabilities, and no new privileges.
