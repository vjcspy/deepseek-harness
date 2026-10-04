---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-subprocess` 删除 `SENSITIVE_ENV_PATTERN`，共享的子进程环境清除现在只去掉 `DSH_*` 名称。"
---

# `@deepseek-ai/dsh-subprocess` 删除 `SENSITIVE_ENV_PATTERN`

[English](guide.md) | 中文

## 变更

在 v0.2.0-rc.2 中，`@deepseek-ai/dsh-subprocess` 导出 `SENSITIVE_ENV_PATTERN`，即 `/KEY|PASSWORD|SECRET|TOKEN/i` 名称测试，且 `scrubbedParentEnv()` 会从父进程的环境变量中移除所有匹配该测试的名称。

下一版本删除该导出，`scrubbedParentEnv()` 只移除以 `DSH_` 开头的名称（不区分大小写）。其余所有环境变量名称——包括匹配 `*KEY*`、`*PASSWORD*`、`*SECRET*`、`*TOKEN*` 的名称——原样传给子进程。该部署刻意把 key、password、secret、token 保存在环境变量中供 agent 读取，因此本 fork 不带有任何凭证名称过滤。

有两类使用方会观察到这一破坏性变更。导入 `SENSITIVE_ENV_PATTERN` 的插件会在构建或模块加载时失败，报 `does not provide an export named 'SENSITIVE_ENV_PATTERN'`。依赖共享清除来对子进程隐藏机密的插件则失去这层保护：MCP stdio 服务器、subagent CLI、LSP 服务器、浏览器自动化、hooks、terminal，以及插件管理器的包操作，都会继承父进程的完整环境变量。

## 迁移

1. 若调用方仍需要该名称测试，用本地声明替代导入：`const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`。
2. 检查那些假定共享基础环境已替子进程移除凭证的调用方；该基础环境现在只是父进程环境变量减去 `DSH_*`，调用方未自行移除的环境变量子进程都会看到。
3. 若要阻止某个名称传入某个子进程，在该 spec 的 `env` 中以显式 `undefined` 墓碑移除它，或在 harness 启动前于父进程中 unset 它。
4. 确认：没有任何源码从该包导入 `SENSITIVE_ENV_PATTERN`，profile 的插件正常加载，且 `bash` 工具调用能读到此前看不到的环境变量。
