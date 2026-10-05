# Backboard agent image

The Dockerfile, entrypoint, and provider configuration were imported from the VM. The entrypoint now keeps HOME and temporary files inside
the disposable `/workspace` volume.
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
docker build --platform linux/amd64 -t nene-agent:0.3 agent-image
```

The VM also has a source checkout of
[Backboard-R-CLI](https://github.com/Backboard-io/Backboard-R-CLI)
at commit `960c430754f42823b4153ad6a5cd2ccadd5641e5`, package version `3.0.4`.
Its build command is `bun run build`, which compiles `src/entrypoints/cli.tsx`
into the `backboard` executable. If you cannot obtain the existing binary,
build the pinned source on **Linux x86_64** (not on a Mac):

```sh
# Run as nene on the Linux host. Bun 1.4.2 is the observed build runtime.
curl -fsSL https://bun.sh/install -o /tmp/nene-bun-install.sh
bash /tmp/nene-bun-install.sh bun-v1.4.2
export PATH="$HOME/.bun/bin:$PATH"
bun --version
mkdir -p ~/src
cd ~/src
git clone https://github.com/Backboard-io/Backboard-R-CLI.git
cd Backboard-R-CLI
git checkout --detach 960c430754f42823b4153ad6a5cd2ccadd5641e5
bun install --frozen-lockfile
bun run build
./backboard --version
install -m 755 backboard /home/nene/ne-ne/agent-image/backboard
```

Skip cloning if the source checkout already exists; inspect it before changing
its revision. Expected CLI version is `3.0.4`. See [Bun installation](https://bun.sh/docs/installation).
Rebuilt output has not been verified byte-identical to the original binary, so
the checksum above applies only to the copied original. Build the image from
`/home/nene/ne-ne/agent-image` when using the runtime layout in the backend README:

```sh
cd /home/nene/ne-ne
docker build --platform linux/amd64 -t nene-agent:0.3 agent-image
docker run --rm nene-agent:0.3 --version
```

The repository copy of `agent-image/` and the sibling runtime copy are different
directories. Updating one does not update the other or an already built image.

The backend mounts `backboard-config.json` into each agent container at
`/seed/backboard-config.json`. The entrypoint copies it into `/workspace/.nene-agent` and starts Backboard. Containers use a read-only root filesystem,
one writable workspace volume, a 512 MB memory limit (640 MB including swap),
0.75 CPU, 128 processes, dropped capabilities, and no new privileges.
