/**
 * 测试 1：多副本检测（Check 1，最高危）。
 * 同名同版本的两份 dsh-tools 也必须被检出——Symbol 冲突的本质是
 * 「两次模块求值」，与版本号无关。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { scanDependencies, CHECK } from '../lib/engine/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'dual-copy')

test('duplicate-copy: 两份同名同版本 dsh-tools → CRITICAL', () => {
  const report = scanDependencies({ root: fixture, details: true })

  const finding = report.profiles
    .flatMap((p) => p.findings)
    .find((f) => f.check === CHECK.DUPLICATE && f.package === '@deepseek-ai/dsh-tools')

  assert.ok(finding, '应检出 duplicate-copy finding')
  assert.equal(finding.severity, 'critical')
  assert.ok(finding.evidence.length >= 2, '应列出两份副本的证据')
  assert.ok(finding.fix.includes('pnpm'), '应给出 pnpm 修复建议')
})

test('duplicate-copy: 单副本不误报', () => {
  const clean = join(here, 'fixtures', 'clean')
  const report = scanDependencies({ root: clean })
  const dupes = report.profiles.flatMap((p) => p.findings).filter((f) => f.check === CHECK.DUPLICATE)
  assert.equal(dupes.length, 0, '健康环境不应报多副本')
})

test('duplicate-copy: summary 计数正确', () => {
  const report = scanDependencies({ root: fixture })
  assert.ok(report.summary.critical >= 1, 'summary.critical 至少 1')
})
