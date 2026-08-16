/**
 * 测试 4：符号链接去重（误报控制）。
 * pnpm 的符号链接会让「同一个包」出现在多个路径——引擎必须用 realpathSync
 * 去重，否则会把符号链接误判为多副本。
 * 一正（测试1抓真副本）一反（本测试不误报符号链接），才算完整。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { scanDependencies, CHECK } from '../lib/engine/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'symlink')

test('symlink: 符号链接不算第二份副本', () => {
  // 构造：真实副本在 runtime-base，插件层放一个指向它的符号链接
  const realDir = join(fixture, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools')
  const linkDir = join(fixture, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(realDir, { recursive: true })
  mkdirSync(join(fixture, 'profiles', 'web', 'node_modules', '@deepseek-ai'), { recursive: true })
  mkdirSync(join(fixture, 'profiles', 'web'), { recursive: true })

  writeFileSync(join(realDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.1.0-rc.6' }))
  writeFileSync(join(fixture, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))

  try {
    symlinkSync(realDir, linkDir)
  } catch (e) {
    if (e.code === 'EEXIST') {
      // fixture 已存在，跳过构造
    } else {
      throw e
    }
  }

  const report = scanDependencies({ root: fixture })
  const dupes = report.profiles.flatMap((p) => p.findings).filter((f) => f.check === CHECK.DUPLICATE)
  assert.equal(dupes.length, 0, '符号链接应被 realpath 去重，不报多副本')
})
