---
kind: upgrade-guide
description: "`SENSITIVE_ENV_PATTERN` is removed from `@deepseek-ai/dsh-subprocess`, and the shared child-environment scrub now drops only `DSH_*` names."
---

# `SENSITIVE_ENV_PATTERN` is removed from `@deepseek-ai/dsh-subprocess`

English | [中文](guide.zh.md)

## Change

In v0.2.0-rc.2, `@deepseek-ai/dsh-subprocess` exported `SENSITIVE_ENV_PATTERN`, the `/KEY|PASSWORD|SECRET|TOKEN/i` name test, and `scrubbedParentEnv()` returned the ambient parent environment minus every name it matched.

The next release deletes the export, and `scrubbedParentEnv()` returns the ambient parent environment minus only names starting with `DSH_` (case-insensitive). Every other ambient name — `*KEY*`, `*PASSWORD*`, `*SECRET*`, `*TOKEN*` included — reaches the child unchanged. This deployment keeps its keys, passwords, secrets, and tokens in environment variables for the agent to read, so the fork carries no credential-name filter.

Two readers observe the break. A plugin that imports `SENSITIVE_ENV_PATTERN` fails at build or module load with `does not provide an export named 'SENSITIVE_ENV_PATTERN'`. A plugin that relied on the shared scrub to withhold a secret from a child loses that protection: MCP stdio servers, subagent CLIs, LSP servers, browser automation, hooks, terminals, and the plugin manager's package operations all inherit the ambient environment.

## Migration

1. Replace the import with a local declaration when the caller still needs the name test: `const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`.
2. Review callers that assumed the shared base had already removed credentials from a child's environment; that base is now the ambient environment minus `DSH_*`, so a child sees every ambient value the caller does not remove itself.
3. Withhold a name from one child by naming it in that spec's `env` as an explicit `undefined` tombstone, or unset it in the parent process before the harness starts.
4. Confirm: no source imports `SENSITIVE_ENV_PATTERN` from the package, the profile's plugins load, and a `bash` tool call reports the ambient variable it previously could not see.
