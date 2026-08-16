/**
 * dsh-depguard — 依赖拓扑安全检测引擎（纯函数，只读，零依赖）。
 *
 * 核心思想：DSH 的 "everything is a plugin" 架构下，`@deepseek-ai/dsh-*`
 * 核心包如果出现第二份物理副本，就会因为 JS `Symbol` 键每次求值都不同的
 * 特性，导致 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 undefined，进而崩溃：
 *
 *   Cannot read properties of undefined (reading 'prepare')
 *
 * 参见 deepseek-harness discussion #1337。
 *
 * 本引擎只做「检测 + 修复建议」，绝不自动修复。修复交给用户或
 * dsh-undo-plugin / dsh-boot-guard 等第三方插件。
 *
 * @module dsh-depguard/engine
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 提供 cordis 服务的核心包——出现第二份物理副本就可能触发 Symbol 键冲突。
 * dsh-tools 最高危（直接导致 prepare 崩溃），其余为潜在服务冲突。
 */
export const SERVICE_PACKAGES = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-storage',
]

/** 检测项 ID 常量。 */
export const CHECK = {
  DUPLICATE: 'duplicate-copy',
  DRIFT: 'version-drift',
  VENDORED: 'vendored-service',
}

/**
 * 单条检测发现。
 * @typedef {Object} Finding
 * @property {string} severity  'critical' | 'warning' | 'info'
 * @property {string} check     检测项 ID
 * @property {string} package   涉及的包名（含 scope）
 * @property {string} message   人类可读描述
 * @property {string} fix       修复建议（交给第三方修复插件执行）
 * @property {Object} [evidence] 证据（details: true 时返回）
 */

/**
 * 把 `@scope/name` 转成磁盘路径片段 `@scope/name`。
 * @param {string} pkg
 * @returns {string}
 */
export function pkgToPath(pkg) {
  return pkg // 已含 @scope/name 形式
}

/**
 * 从目录读包的 version 字段。
 * @param {string} dir 包目录（含 package.json）
 * @returns {string|null}
 */
export function readVersion(dir) {
  try {
    const raw = readFileSync(join(dir, 'package.json'), 'utf8')
    const manifest = JSON.parse(raw)
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * 在指定 node_modules 目录下递归查找目标包的所有物理副本。
 * @param {string} nmDir node_modules 目录
 * @param {string} pkg 包名（@scope/name）
 * @param {number} maxDepth 最大递归深度（防失控）
 * @param {number} depth 当前深度
 * @returns {Array<{path: string, version: string|null}>}
 */
export function findCopies(nmDir, pkg, maxDepth = 8, depth = 0) {
  const results = []
  if (depth > maxDepth) return results

  // 本层直接命中（扁平/hoisted 布局）
  const direct = join(nmDir, pkg)
  if (existsSync(join(direct, 'package.json'))) {
    results.push({ path: direct, version: readVersion(direct) })
  }

  // 递归：<pkg>/node_modules/<target>（嵌套布局）与 scope 目录
  let entries = []
  try {
    entries = readdirSync(nmDir)
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === pkg) continue
    const child = join(nmDir, entry, 'node_modules')
    if (existsSync(child)) {
      results.push(...findCopies(child, pkg, maxDepth, depth + 1))
    }
  }
  return results
}

/**
 * realpath 去重：符号链接指向同一物理目录的算同一份副本。
 * @param {Array<{path: string, version: string|null}>} copies
 * @returns {Array<{path: string, version: string|null, realpath: string}>}
 */
export function dedupeByRealpath(copies) {
  return copies.map((c) => {
    let real = c.path
    try {
      real = realpathSync(c.path)
    } catch {
      /* 保留原路径 */
    }
    return { ...c, realpath: real }
  })
}

/**
 * 检测 1：多副本检测。
 * 同一包在多个物理位置出现（realpath 去重后仍 > 1）即告警。
 * 注意：同名同版本也是副本——Symbol 冲突的本质是「两次模块求值」，与版本无关。
 * @param {Array<{path: string, version: string|null, realpath: string}>} copies
 * @param {string} pkg
 * @returns {Finding[]}
 */
export function checkDuplicate(copies, pkg) {
  const unique = new Set(copies.map((c) => c.realpath))
  if (unique.size <= 1) return []
  const severity = pkg === '@deepseek-ai/dsh-tools' ? 'critical' : 'warning'
  return [{
    severity,
    check: CHECK.DUPLICATE,
    package: pkg,
    message: `检测到 ${unique.size} 份物理副本（同名同版本也算副本：Symbol 键每次求值都不同）`,
    fix: '在 profile 目录运行 `pnpm why <pkg>` 定位来源，然后 `pnpm dedupe`；或在 profile package.json 加 `"pnpm": {"overrides": {"<pkg>": "<runtime 版本>"}}` 锁死单副本',
    evidence: copies.map((c) => ({ path: c.path, version: c.version, realpath: c.realpath })),
  }]
}

/**
 * 检测 2：版本漂移检测。
 * 各副本版本与 runtime 基准层版本不一致即告警。
 * @param {Array<{path: string, version: string|null, realpath: string, layer: string}>} copies
 * @param {string} pkg
 * @returns {Finding[]}
 */
export function checkDrift(copies, pkg) {
  const findings = []
  const base = copies.find((c) => c.layer === 'runtime-base' && c.version !== null)
  if (!base) return findings
  for (const c of copies) {
    if (c.version === null || c.version === base.version) continue
    findings.push({
      severity: 'warning',
      check: CHECK.DRIFT,
      package: pkg,
      message: `版本漂移：${c.version}（@ ${c.path}）与 runtime 基准 ${base.version} 不一致`,
      fix: `在 profile package.json 加 "pnpm": {"overrides": {"${pkg}": "${base.version}"}} 锁死版本`,
      evidence: { path: c.path, version: c.version, base: base.version },
    })
  }
  return findings
}

/**
 * 检测 3：插件私包核心服务检测。
 * 社区插件自己的 node_modules 里出现了核心包 = 打包 bug（应 peerDependencies）。
 * @param {string} pluginNmDir 某个插件的 node_modules 目录
 * @param {string} pluginName 插件名（用于报告）
 * @returns {Finding[]}
 */
export function checkVendored(pluginNmDir, pluginName) {
  const findings = []
  for (const pkg of SERVICE_PACKAGES) {
    if (existsSync(join(pluginNmDir, pkg, 'package.json'))) {
      findings.push({
        severity: 'critical',
        check: CHECK.VENDORED,
        package: pkg,
        message: `插件 ${pluginName} 私自打包了核心包 ${pkg}（应使用 peerDependencies），会重新挂载核心服务并触发 Symbol 冲突`,
        fix: `卸载或降级该插件，并向其作者提 issue：${pkg} 应改为 peerDependencies 而非 dependencies`,
        evidence: { plugin: pluginName, path: join(pluginNmDir, pkg) },
      })
    }
  }
  return findings
}

/**
 * 汇总统计。
 * @param {Finding[]} findings
 * @returns {{critical: number, warning: number, info: number}}
 */
export function summarize(findings) {
  const summary = { critical: 0, warning: 0, info: 0 }
  for (const f of findings) {
    if (f.severity in summary) summary[f.severity] += 1
  }
  return summary
}

/**
 * 列出 profiles 目录下所有含 package.json 的子目录名。
 * @param {string} profilesDir
 * @returns {string[]}
 */
export function listProfiles(profilesDir) {
  try {
    return readdirSync(profilesDir).filter((d) =>
      existsSync(join(profilesDir, d, 'package.json')))
  } catch {
    return []
  }
}

/**
 * 解析 DSH home 目录。
 * @returns {string}
 */
export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 主扫描入口（装后检测）：扫描 profiles 下所有（或指定）profile 的依赖拓扑。
 * 只读、零副作用。
 *
 * @param {Object} opts
 * @param {string} [opts.root]       DSH home，默认 $DSH_HOME 或 ~/.dsh
 * @param {string} [opts.profile]    只扫指定 profile；缺省扫全部
 * @param {boolean} [opts.details]   是否带 evidence
 * @param {number} [opts.maxDepth]   递归深度上限
 * @returns {{schemaVersion: number, generatedAt: string, profiles: Object[], summary: Object}}
 */
export function scanDependencies({ root, profile, details = false, maxDepth = 8 } = {}) {
  const dshHome = root || resolveDshHome()
  const profilesDir = join(dshHome, 'profiles')
  const targets = profile ? [profile] : listProfiles(profilesDir)

  const profiles = []
  let allFindings = []

  for (const p of targets) {
    const profileDir = join(profilesDir, p)
    const layers = [
      { label: 'runtime-base', dir: join(profilesDir, 'node_modules') },
      { label: p, dir: join(profileDir, 'node_modules') },
    ]
    const findings = []

    // Check 1 + 2：对每个核心包，聚合两层副本，做多副本 + 漂移检测
    for (const pkg of SERVICE_PACKAGES) {
      const copies = []
      for (const layer of layers) {
        for (const c of findCopies(layer.dir, pkg, maxDepth)) {
          copies.push({ ...c, layer: layer.label })
        }
      }
      const deduped = dedupeByRealpath(copies)
      findings.push(...checkDuplicate(deduped, pkg))
      findings.push(...checkDrift(deduped, pkg))
    }

    // Check 3：扫描插件层的每个插件是否私包核心服务
    const pluginDir = join(profileDir, 'node_modules')
    let pluginEntries = []
    try {
      pluginEntries = readdirSync(pluginDir)
    } catch { /* 无插件层，跳过 */ }
    for (const entry of pluginEntries) {
      if (entry.startsWith('.') || entry.startsWith('@')) continue
      const vendoredNm = join(pluginDir, entry, 'node_modules')
      if (existsSync(vendoredNm)) {
        findings.push(...checkVendored(vendoredNm, entry))
      }
      // scope 目录（@scope/pkg）
    }
    for (const scopeEntry of pluginEntries.filter((e) => e.startsWith('@'))) {
      let scoped = []
      try {
        scoped = readdirSync(join(pluginDir, scopeEntry))
      } catch { continue }
      for (const entry of scoped) {
        const vendoredNm = join(pluginDir, scopeEntry, entry, 'node_modules')
        if (existsSync(vendoredNm)) {
          findings.push(...checkVendored(vendoredNm, `${scopeEntry}/${entry}`))
        }
      }
    }

    allFindings = allFindings.concat(findings)
    profiles.push({
      profile: p,
      summary: summarize(findings),
      findings: details ? findings : stripEvidence(findings),
    })
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profiles,
    summary: summarize(allFindings),
  }
}

/**
 * 去掉 evidence 字段（details: false 时输出紧凑）。
 * @param {Finding[]} findings
 * @returns {Object[]}
 */
export function stripEvidence(findings) {
  return findings.map(({ evidence, ...rest }) => rest)
}
