# DSH uplift sandbox — run fork-baseline-sync off the live macOS host.
#
# Why this exists: uplifting the DSH host / plugins on the machine that runs
# the driving session kills that session when the build breaks. This image
# reproduces the macOS working state (same repos, same branches, same
# toolchain) so Steps 1-9 of the sync runbook execute in a throwaway
# container. Code lives in the container; resource context documents are
# still written on the host; final results are committed and pushed from
# the container, and the host only pulls and runs.
#
# Procedure (what to clone, which mounts, Monolith override, push/pull
# handoff) is owned by:
#   resources/workspaces/k/dsh/_architecture/260924-docker-uplift-environment.md
# This file owns only the image definition.
#
# Build (SSH agent must hold the GitHub key first — keys are never baked
# into the image):
#   ssh-add ~/.ssh/id_ed25519
#   DOCKER_BUILDKIT=1 docker build --ssh default \
#     -f workspaces/k/dsh/deepseek-harness/Dockerfile \
#     -t dsh-uplift:latest workspaces/k/dsh/deepseek-harness
# Run (publish a DEDICATED verification port — never the primary GUI's
# port; Docker would take the wildcard and shadow the live host for any
# client resolving localhost to ::1):
#   docker run -it --rm --name dsh-uplift \
#     -p 3181:3181 \
#     -v $HOME/.config/gh-vjcspy:/home/node/.config/gh:ro \
#     dsh-uplift:latest bash
# The in-container host binds loopback only and `--host 0.0.0.0` is
# rejected by design, so a Mac browser reaches it through a TCP forwarder
# inside the container (0.0.0.0:3181 -> 127.0.0.1:<dsh port>) plus
# `--trusted-host 127.0.0.1:3181`. Details, plus the single-use token and
# the fixture symlink trap: the architecture doc referenced below.
# Secrets (credentials, .env) are mounted read-only at run time, never
# baked into the image.

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_HOME=/home/node/dsh-home \
    WS=/workspace

# Toolchain parity with the macOS host: git, pnpm 11.7.0 (repo
# packageManager pin), npm from Node 22, GitHub CLI for `gh api` steps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client curl ca-certificates gnupg lsof procps python3 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.7.0 --activate \
    && node --version && pnpm --version && git --version && gh --version

# Which refs to clone. Defaults mirror the live branches on the macOS host:
# the harness fork works on `develop`, our plugin repos on `master`, the
# config home on `main`. The opencode-go fork also works on `develop`.
ARG HARNESS_BRANCH=develop
ARG PLUGIN_BRANCH=master
ARG OGO_BRANCH=develop
ARG PROFILE_BRANCH=main
ARG DEVKIT_BRANCH=master
ARG GIT_NAME=dinhkhoi.le
ARG GIT_EMAIL=dinhkhoi.le05@gmail.com

# Clone the k/dsh repos over SSH (BuildKit secret — the key stays on the
# host). Layout mirrors the macOS checkout, rooted at /workspace instead
# of /Users/<name>/work/aweave: /workspace/k/dsh/<repo>.
RUN --mount=type=ssh \
    mkdir -p ~/.ssh /workspace/k/dsh \
    && ssh-keyscan github.com >> ~/.ssh/known_hosts \
    && git clone --branch $HARNESS_BRANCH \
         git@github.com:vjcspy/deepseek-harness.git $WS/k/dsh/deepseek-harness \
    && git clone --branch $PLUGIN_BRANCH --single-branch \
         git@github.com:vjcspy/dsh-project-context.git $WS/k/dsh/dsh-project-context \
    && git clone --branch $PLUGIN_BRANCH --single-branch \
         git@github.com:vjcspy/dsh-debate-bridge.git $WS/k/dsh/dsh-debate-bridge \
    && git clone --branch $PLUGIN_BRANCH --single-branch \
         git@github.com:vjcspy/dsh-chat-wide.git $WS/k/dsh/dsh-chat-wide \
    && git clone --branch $DEVKIT_BRANCH --single-branch \
         git@github.com:vjcspy/aweave-dsh-devkit.git $WS/k/dsh/aweave-dsh-devkit \
    && git clone --branch $OGO_BRANCH \
         git@github.com:vjcspy/dsh-opencode-go.git $WS/k/dsh/dsh-opencode-go \
    && git clone --branch $PROFILE_BRANCH --single-branch \
         git@github.com:vjcspy/dsh-profile-config.git /home/node/dsh-home-tpl \
    && printf '[user]\n\tname = %s\n\temail = %s\n[init]\n\tdefaultBranch = main\n' \
         "$GIT_NAME" "$GIT_EMAIL" > /home/node/.gitconfig \
    && chown node:node /home/node/.gitconfig

# Container DSH home: copy the tracked config template, then rewrite the
# macOS-absolute `file:` plugin paths to the container layout. The live
# (gitignored, secret-bearing) files — settings.yaml, .credentials.yaml,
# .env, plugins/subscriptions state — are NOT baked in; mount or copy them
# read-only at run time per the architecture doc.
#
# Two rewrites, because one plugin path appears in two forms that must agree:
# the `dependencies` spec in `profiles/*/package.json`, and the `allowBuilds`
# key in `profiles/*/pnpm-workspace.yaml`, which pnpm normalizes to a path
# RELATIVE TO THE PROFILE DIRECTORY (`dsh-opencode-go@file:../../../dsh-opencode-go`
# on the Mac). Rewriting only package.json left that key naming a path which
# does not exist in the container, so pnpm met a build-script dependency with no
# matching entry, wrote a `set this to true or false` placeholder into the
# container copy, and every later `plugin add` / `install` exited non-zero with
# ERR_PNPM_IGNORED_BUILDS — which also skipped the bundle reconciliation.
RUN cp -r /home/node/dsh-home-tpl /home/node/dsh-home \
    && grep -rl 'file:/Users/' /home/node/dsh-home/profiles/*/package.json \
     | xargs -r sed -i 's|file:/Users/[^/]*/work/aweave/workspaces|file:/workspace|g' \
    && grep -rl '@file:\.\./\.\./\.\./' /home/node/dsh-home/profiles/*/pnpm-workspace.yaml \
     | xargs -r sed -i 's|@file:\.\./\.\./\.\./|@file:../../../../../workspace/k/dsh/|g' \
    && grep -rh 'file:/workspace' /home/node/dsh-home/profiles/*/package.json \
    && chown -R node:node /home/node/dsh-home $WS

USER node
WORKDIR /workspace/k/dsh/deepseek-harness

# 3181 = dedicated verification instance (publish this, NOT the primary
# GUI's port). 3080 is deliberately absent: the driving host usually owns
# it, and publishing it makes Docker shadow the GUI.
EXPOSE 3181

CMD ["bash"]
