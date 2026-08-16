/**
 * 测试 5：装前预测（predictFromDeclarations 纯函数部分，不依赖网络）。
 * 用本地 manifest 声明直接测核心比对逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { predict, predictFromDeclarations, extractDeclarations, rangeMatches } from '../lib/engine/predict.js'

const here = dirname(fileURLToPath(import.meta.url))

test('rangeMatches: semver 范围匹配', () => {
  assert.equal(rangeMatches('^0.1.0', '0.1.0-rc.6'), false, '^0.1.0 不匹配 rc 版本（不同 pre-release 线）')
  assert.equal(rangeMatches('*', 'anything'), true)
  assert.equal(rangeMatches('^4.0.1', '4.2.0'), true)
  assert.equal(rangeMatches('~1.2.3', '1.2.9'), true)
  assert.equal(rangeMatches('~1.2.3', '1.3.0'), false)
})

test('predict: 本地目录 manifest（dependencies 带核心包 → NOT_RECOMMENDED）', async () => {
  const result = await predict({
    target: join(here, 'fixtures', 'bad-plugin-manifest'),
    root: join(here, 'fixtures', 'clean'),
  })
  assert.equal(result.verdict, 'NOT_RECOMMENDED')
  assert.ok(result.prediction.some((p) => p.check === 'vendored-service' && p.risk === 'critical'))
})

test('predictFromDeclarations: 健康声明 → OK', () => {
  const decl = {
    name: 'good-plugin',
    version: '1.0.0',
    deps: { lodash: '^4.0.0' },
    peerDeps: {},
  }
  const baseline = { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' }
  const result = predictFromDeclarations(decl, baseline, 'good-plugin')
  assert.equal(result.verdict, 'OK')
  assert.equal(result.prediction.length, 0)
})
