/**
 * dsh-depguard — 装前冲突预测（静态 manifest 比对，零安装）。
 *
 * 不用真装目标插件，就能预测「装上会不会和现有依赖拓扑冲突」。
 * 数据来源：npm registry 或 GitHub 上的 package.json 声明。
 *
 * 精度边界（重要）：预测基于静态声明，实际依赖解析还受 lockfile、
 * nodeLinker、pnpm.overrides 影响。所以本模块输出「风险预警」而非
 * 「事实结论」；装上之后必须再跑 dsh_depguard_check 确认。
 *
 * @module dsh-depguard/predict
 */

import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { SERVICE_PACKAGES, readVersion, resolveDshHome } from './index.js'

const execFileAsync = promisify(execFile)

/**
 * 拉取 npm 包的最新 manifest（走 npm registry）。
 * @param {string} pkg 包名，如 '@liustack/modlens'
 * @returns {Promise<Object|null>} manifest 或 null
 */
export async function fetchNpmManifest(pkg) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * 拉取 GitHub 仓库的 package.json。
 * 优先走 gh CLI（子进程，绕过 DSH 进程内 fetch 的 private-network 防护——
 * Clash fake-ip 会把 raw.githubusercontent.com 解析到 198.18.x 保留段被拦截）；
 * gh 不可用时回退到进程内 fetch。
 * @param {string} ownerRepo 如 'owner/repo'
 * @returns {Promise<Object|null>}
 */
export async function fetchGithubManifest(ownerRepo) {
  const failures = []
  // 路径一：gh api（认证、走系统网络栈）
  try {
    const { stdout } = await execFileAsync('gh', [
      'api', `repos/${ownerRepo}/contents/package.json`,
      '--jq', '.content',
    ], { timeout: 15000, maxBuffer: 1024 * 1024 })
    const manifest = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'))
    if (manifest && typeof manifest === 'object') return manifest
    failures.push('gh api returned non-object manifest')
  } catch (e) {
    failures.push(`gh api failed: ${e.message}`)
  }

  // 路径二：进程内 fetch（在无 fake-ip 干扰的网络下可用）
  const urls = [
    `https://raw.githubusercontent.com/${ownerRepo}/main/package.json`,
    `https://raw.githubusercontent.com/${ownerRepo}/master/package.json`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) {
        failures.push(`fetch ${url}: HTTP ${res.status}`)
        continue
      }
      return await res.json()
    } catch (e) {
      failures.push(`fetch ${url} failed: ${e.message}`)
    }
  }
  const err = new Error(`github manifest fetch failed: ${failures.join(' | ')}`)
  err.detail = failures
  throw err
}

/**
 * 从 manifest 提取预测信号：dependencies 与 peerDependencies。
 * @param {Object} manifest
 * @returns {{deps: Object, peerDeps: Object, name: string, version: string}}
 */
export function extractDeclarations(manifest) {
  return {
    name: manifest?.name ?? 'unknown',
    version: manifest?.version ?? 'unknown',
    deps: manifest?.dependencies ?? {},
    peerDeps: manifest?.peerDependencies ?? {},
  }
}

/**
 * 读取当前 runtime 基准层的核心包版本（profiles/node_modules）。
 * @param {string} [root] DSH home
 * @returns {Object<string, string|null>} 包名 -> 版本
 */
export function runtimeBaseline(root) {
  const dshHome = root || resolveDshHome()
  const baseNm = join(dshHome, 'profiles', 'node_modules')
  const baseline = {}
  for (const pkg of SERVICE_PACKAGES) {
    baseline[pkg] = readVersion(join(baseNm, pkg))
  }
  return baseline
}

/**
 * 核心预测：把目标插件的声明与 runtime 基准比对。
 * @param {Object} decl extractDeclarations 的输出
 * @param {Object} baseline runtimeBaseline 的输出
 * @param {string} target 展示用目标名
 * @returns {{target: string, prediction: Object[], verdict: string, note: string}}
 */
export function predictFromDeclarations(decl, baseline, target) {
  const prediction = []

  // 信号 1：dependencies 直接带核心包 = 私包风险（vendored-service 装前版）
  for (const pkg of SERVICE_PACKAGES) {
    if (pkg in decl.deps) {
      prediction.push({
        risk: 'critical',
        check: 'vendored-service',
        package: pkg,
        detail: `dependencies 直接声明 ${pkg}@${decl.deps[pkg]}，装上后会在插件私有 node_modules 引入第二份副本，重新挂载核心服务并触发 Symbol 冲突`,
        fix: '不要安装；或向作者提 issue：应改为 peerDependencies',
      })
    }
  }

  // 信号 2：peerDependencies 版本范围 vs runtime 基准 = 版本漂移风险
  for (const pkg of SERVICE_PACKAGES) {
    if (!(pkg in decl.peerDeps)) continue
    const base = baseline[pkg]
    if (base === null) continue
    const range = decl.peerDeps[pkg]
    if (!rangeMatches(range, base)) {
      prediction.push({
        risk: 'warning',
        check: 'version-drift',
        package: pkg,
        detail: `peerDependencies 要求 ${pkg} ${range}，与当前 runtime ${base} 可能不兼容（pnpm 可能解析到另一版本，形成版本漂移）`,
        fix: `安装后在 profile package.json 加 "pnpm": {"overrides": {"${pkg}": "${base}"}} 锁死`,
      })
    }
  }

  // 结论
  const worst = prediction.reduce((w, p) => {
    const rank = { critical: 3, warning: 2, info: 1 }
    return rank[p.risk] > rank[w] ? p.risk : w
  }, 'info')
  const verdict = worst === 'critical' ? 'NOT_RECOMMENDED' : worst === 'warning' ? 'CAUTION' : 'OK'

  return {
    target,
    prediction,
    verdict,
    note: '预测基于静态声明，实际解析受 lockfile/nodeLinker 影响。装上后请运行 dsh_depguard_check 确认。',
  }
}

/**
 * 简易 semver 范围匹配（支持 ^x.y.z、~x.y.z、x.y.z、*）。
 * 对 '>=x <y' 等复合范围保守返回 true（不确定时不误报）。
 * @param {string} range
 * @param {string} version
 * @returns {boolean}
 */
export function rangeMatches(range, version) {
  const v = version.replace(/^v/, '')
  const r = range.trim()
  if (r === '*' || r === '' || r === 'latest') return true
  if (!/^[\^~]?\d+\.\d+\.\d+/.test(r)) return true // 复合/特殊范围：保守放行
  const m = r.match(/^([\^~]?)(\d+)\.(\d+)\.(\d+)/)
  const target = v.split('.').map(Number)
  const base = [Number(m[2]), Number(m[3]), Number(m[4])]
  const op = m[1]
  if (op === '^') {
    return target[0] === base[0]
      && (target[1] > base[1] || (target[1] === base[1] && target[2] >= base[2]))
  }
  if (op === '~') {
    return target[0] === base[0] && target[1] === base[1] && target[2] >= base[2]
  }
  // 精确版本
  return target.join('.') === base.join('.')
}

/**
 * 装前预测主入口。
 * @param {Object} opts
 * @param {string} opts.target       npm 包名（@scope/name）或 github:owner/repo
 * @param {string} [opts.root]       DSH home
 * @returns {Promise<Object>}
 */
export async function predict({ target, root } = {}) {
  let manifest = null
  let fetchError = null
  if (target.startsWith('github:')) {
    try {
      manifest = await fetchGithubManifest(target.slice('github:'))
    } catch (e) {
      fetchError = e.message
    }
  } else if (target.startsWith('./') || target.startsWith('/') || target.startsWith('file:')) {
    // 本地目录：直接读 package.json
    const p = target.replace(/^file:/, '')
    try {
      manifest = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'))
    } catch (e) {
      fetchError = `local manifest read failed: ${e.message}`
    }
  } else {
    manifest = await fetchNpmManifest(target)
    if (!manifest) fetchError = 'npm registry fetch failed'
  }

  if (!manifest) {
    return {
      target,
      error: fetchError ? `无法获取 ${target} 的 manifest：${fetchError}` : `无法获取 ${target} 的 manifest`,
      verdict: 'UNKNOWN',
      prediction: [],
      note: '请确认包名/仓库名正确，或网络可达。',
    }
  }

  const decl = extractDeclarations(manifest)
  const baseline = runtimeBaseline(root)
  const result = predictFromDeclarations(decl, baseline, target)
  result.manifest = { name: decl.name, version: decl.version }
  return result
}
