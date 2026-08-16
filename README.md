# dsh-depguard

[English](#english) | 中文

> **装前预测 + 装后检测 DeepSeek Harness 的依赖拓扑冲突，防止 Symbol 键崩溃。**

你装插件时崩过这个吗？

```
Cannot read properties of undefined (reading 'prepare')
```

根因是 [discussion #1337](https://github.com/deepseek-ai/deepseek-harness/discussions/1337)：`@deepseek-ai/dsh-tools` 等核心包出现**第二份物理副本**时，JS `Symbol` 键（每次求值都不同）会让 `ctx.tools[scheduler]` 变 `undefined`，一次工具调度就崩，还会在会话里留下孤儿 `tool_calls`，之后每轮 `400 INVALID_REQUEST` 死锁。

本插件**只做检测 + 修复建议，绝不自动修复**——修复交给 `dsh-undo-plugin`、`dsh-boot-guard` 等第三方插件，保持模块化。

## 两个工具

### `dsh_depguard_predict` — 装前预测（社区空白）

装新插件之前，静态拉取它的 manifest（npm 包 / `github:owner/repo` / 本地路径），与当前 runtime 的 `@deepseek-ai/dsh-*` 基准比对：

| 信号 | 风险 |
|---|---|
| `dependencies` 直接含核心包 | 🔴 CRITICAL → `NOT_RECOMMENDED`（私包 = 第二份副本） |
| `peerDependencies` 版本范围与 runtime 不符 | 🟡 WARNING → `CAUTION`（版本漂移风险） |

预测基于静态声明，实际解析受 lockfile/nodeLinker 影响——**装上后请再跑 check 确认**。

### `dsh_depguard_check` — 装后检测

扫描落盘依赖拓扑，三项检测：

| 检测 | 严重度 | 说明 |
|---|---|---|
| `duplicate-copy` | CRITICAL/WARNING | 同一核心包多份物理副本（realpath 去符号链接；**同名同版本也算**——Symbol 冲突本质是两次求值） |
| `version-drift` | WARNING | 副本版本与 runtime 基准不一致 |
| `vendored-service` | CRITICAL | 社区插件把核心包打进自己的 node_modules（应 peerDependencies） |

每条 finding 带 `fix` 字段，给出修复建议命令（交给第三方修复插件执行）。

## 安装

```sh
# npm（推荐，预构建免授权）
dsh plugin --profile web add dsh-depguard

# GitHub 源码
dsh plugin --profile web add github:DeLightor/dsh-depguard

# 本地开发
dsh plugin --profile web add ./dsh-depguard
```

重启后，在会话里说「检查一下我的插件依赖」或「装 X 之前预测一下冲突」即可。

## 测试

```sh
node --test   # 11 个用例：多副本/漂移/私包/符号链接去重/装前预测
```

## 安全声明

- **只读**：不写任何 profile 文件、不改配置、不自动跑 pnpm。
- **零依赖**：`dependencies` 为空；`@deepseek-ai/*` 一律 `peerDependencies`——本插件自己绝不引入第二份核心包。
- **检测 ≠ 修复**：发现问题只报告 + 给建议，动手由你或第三方回滚插件完成。

## 被收录于

[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表（PR 提交后），可通过 `dsh-market` 插件市场与 `dsh-find-plugin` 检索安装。

## License

MIT

---

## English

Predict (pre-install) and detect (post-install) dependency-topology conflicts in DeepSeek Harness to prevent Symbol-key crashes like `Cannot read properties of undefined (reading 'prepare')`.

- `dsh_depguard_predict` — fetch a target plugin's manifest and compare its `dependencies`/`peerDependencies` against your runtime baseline **before installing**.
- `dsh_depguard_check` — scan the on-disk dependency tree for duplicate `@deepseek-ai/dsh-*` copies (realpath-deduped; same-name-same-version still counts — Symbol keys differ per module evaluation), version drift, and plugins vendoring core services.

Detection + fix suggestions only; remediation is left to third-party plugins (`dsh-undo-plugin`, `dsh-boot-guard`). Read-only, zero runtime dependencies, `@deepseek-ai/*` as peerDependencies only.

```sh
dsh plugin --profile web add dsh-depguard
node --test   # 11 tests
```

MIT
