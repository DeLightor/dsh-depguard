/**
 * 测试 3：插件私包核心服务检测（Check 3）。
 * 社区插件把 dsh-tools 打进自己的 node_modules（应 peerDependencies）
 * → CRITICAL vendored-service，并指出肇事插件。
 * 对应 dsh-context-doctor@0.5.0 的打包 bug。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { scanDependencies, CHECK } from '../lib/engine/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'vendored')

test('vendored-service: 插件私包 dsh-tools → CRITICAL 并点名插件', () => {
  const report = scanDependencies({ root: fixture, details: true })
  const findings = report.profiles.flatMap((p) => p.findings)

  const vendored = findings.find((f) => f.check === CHECK.VENDORED)
  assert.ok(vendored, '应检出 vendored-service finding')
  assert.equal(vendored.severity, 'critical')
  assert.equal(vendored.evidence.plugin, 'some-plugin', '应指出肇事插件名')
  assert.ok(vendored.fix.includes('peerDependencies'), '修复建议应指向 peerDependencies')
})

test('vendored-service: 正常插件不误报', () => {
  const clean = join(here, 'fixtures', 'clean')
  const report = scanDependencies({ root: clean })
  const vendored = report.profiles.flatMap((p) => p.findings).filter((f) => f.check === CHECK.VENDORED)
  assert.equal(vendored.length, 0, 'ok-plugin 没有私包，不应报')
})
