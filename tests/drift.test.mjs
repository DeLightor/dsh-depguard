/**
 * 测试 2：版本漂移检测（Check 2）。
 * 插件层 rc.1 vs runtime 基准 rc.6 应报 WARNING version-drift。
 * 此场景会同时触发 Check 1（两份副本）+ Check 2（版本漂移）——一条场景多命中。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { scanDependencies, CHECK } from '../lib/engine/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'version-drift')

test('version-drift: rc.1 vs rc.6 → WARNING，且同时命中 duplicate', () => {
  const report = scanDependencies({ root: fixture, details: true })
  const findings = report.profiles.flatMap((p) => p.findings)

  const drift = findings.find((f) => f.check === CHECK.DRIFT && f.package === '@deepseek-ai/dsh-tools')
  assert.ok(drift, '应检出 version-drift finding')
  assert.equal(drift.severity, 'warning')
  assert.equal(drift.evidence.version, '0.0.1-rc.1')
  assert.equal(drift.evidence.base, '0.1.0-rc.6')

  const dup = findings.find((f) => f.check === CHECK.DUPLICATE)
  assert.ok(dup, '版本漂移场景同时命中多副本检测')
})

test('version-drift: 版本一致不报漂移', () => {
  const clean = join(here, 'fixtures', 'clean')
  const report = scanDependencies({ root: clean })
  const drifts = report.profiles.flatMap((p) => p.findings).filter((f) => f.check === CHECK.DRIFT)
  assert.equal(drifts.length, 0)
})
