# Dockerfile
FROM debian:bookworm-slim AS base

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    jq \
    unzip \
    ca-certificates \
    libicu72 \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (static binary — Debian's docker.io package is too old for modern daemons)
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# Install Node.js (for npx / MCP server)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Azure CLI
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI + tweakcc (binary patcher for A/B tool-description experiments;
# unpacks/repacks the SDK-bundled native binary — see scripts/ab-test-lsp/patches.ts)
RUN npm install -g @anthropic-ai/claude-code tweakcc

# Pre-install MCP servers so `npx -y` resolves them instantly from the global
# install instead of cold-downloading from npm at agent startup. A cold download
# can race past the SDK's MCP connection window, leaving the agent with no MCP
# tools (it then falls back to curl and fails the post-run assertion).
RUN npm install -g @sshadows/mcp-server-azure-devops business-central-mcp @vjeko.com/al-object-id-ninja-mcp

# NOTE: This is the GENERIC public base image. It builds the core pipeline and AL
# tooling but bakes NO environment-tool backend. A deployment overlay image does
# `FROM devopsworker-public` and adds its env CLI + any baked apps, wiring them via
# /entrypoint.d/*.sh hooks (see docker/entrypoint.sh).

# Copy application code
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY scripts/ scripts/
COPY tsconfig.json ./

# Build the dashboard SPA bundle (src/dashboard/dist/). dist/ is gitignored, so the
# image must build it — the dashboard compose service serves these static assets.
RUN bun run dashboard:build

# Run as root with IS_SANDBOX=1 — Claude Code allows --dangerously-skip-permissions
# in sandboxed environments. Running as root eliminates all permission issues with
# vendored binaries (bun install strips +x), volume mounts, and cli.js patching.
ENV IS_SANDBOX=1

# Disable Claude Code CLI v2 (SDK 0.3+) auto-backgrounding of long-running bash.
# When unset, the CLI: (1) auto-backgrounds any blocking command past 120s, and
# (2) exposes `run_in_background` on the Bash/Task tools and nudges the model to use it.
# Both break our foreground-blocking patterns (await-pipeline + --attach): a backgrounded
# CI wait gets abandoned (ciResult=not-run) or tail-polled to death (error_max_turns).
# Setting this strips `run_in_background` from the tool schema AND skips the 120s speculation
# (binary gate: M68 = CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).
ENV CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1

# Claude Code user settings
# NOTE: Do NOT add known_marketplaces.json — it causes Claude Code CLI to hang
# trying to install plugins from GitHub at startup. Plugins are passed directly
# via the SDK query() options instead.
COPY docker/claude-settings.json /root/.claude/settings.json

# Copy entrypoint and AL extension fetch script (sed strips Windows CRLF line endings)
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/fetch-al-extension.sh /fetch-al-extension.sh
RUN sed -i 's/\r$//' /entrypoint.sh /fetch-al-extension.sh \
    && chmod +x /entrypoint.sh /fetch-al-extension.sh

ENTRYPOINT ["/entrypoint.sh"]
