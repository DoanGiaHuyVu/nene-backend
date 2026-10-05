FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    git \
    ripgrep \
    curl \
    ca-certificates \
    jq \
    && rm -rf /var/lib/apt/lists/*

COPY backboard /usr/local/bin/backboard
COPY entrypoint.sh /usr/local/bin/nene-agent-entrypoint

RUN chmod +x \
    /usr/local/bin/backboard \
    /usr/local/bin/nene-agent-entrypoint

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/nene-agent-entrypoint"]
