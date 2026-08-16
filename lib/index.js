/**
 * dsh-depguard — 依赖拓扑安全插件（装前预测 + 装后检测，只读零副作用）。
 *
 * 注册两个模型工具：
 *   - dsh_depguard_predict：装新插件前，静态预测冲突风险
 *   - dsh_depguard_check：装后扫描落盘依赖拓扑，报告多副本/漂移/私包
 *
 * 定位：只做「检测 + 修复建议」，绝不自动修复——修复交给
 * dsh-undo-plugin / dsh-boot-guard 等第三方插件，保持模块化。
 *
 * 注意：本插件不导出 schemastery Config（此前一份跨副本的 schemastery
 * 导致 cordis resolveConfig 读 Config["~standard"] 崩溃）。所有参数
 * 用 defineTool 的 ValueSchemaSpec 纯对象描述，零 schema 依赖。
 *
 * @module dsh-depguard
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { scanDependencies } from './engine/index.js'
import { predict } from './engine/predict.js'

export const name = 'depguard'

/** 需要的服务：tools 用于注册模型工具。 */
export const inject = ['tools']

/** 渲染装后检测报告为 Markdown 文本。 */
function renderCheckReport(report) {
  const lines = [
    `## 依赖拓扑体检（${report.generatedAt}）`,
    `summary: critical ${report.summary.critical} · warning ${report.summary.warning} · info ${report.summary.info}`,
  ]
  for (const profile of report.profiles) {
    lines.push(`\n### profile: ${profile.profile}`)
    if (profile.findings.length === 0) {
      lines.push('- ✅ 健康：无 duplicate-copy / version-drift / vendored-service 发现')
      continue
    }
    for (const f of profile.findings) {
      lines.push(`- [${f.severity}] ${f.check} — ${f.package}：${f.message}`)
      lines.push(`  - 修复：${f.fix}`)
    }
  }
  return lines.join('\n')
}

/** 渲染装前预测结果为 Markdown 文本。 */
function renderPrediction(result) {
  if (result.error) return `## 装前预测失败\n${result.error}`
  const lines = [
    `## 装前预测：${result.target}`,
    `verdict: ${result.verdict}`,
  ]
  for (const p of result.prediction) {
    lines.push(`- [${p.risk}] ${p.check} — ${p.package}：${p.detail}`)
    lines.push(`  - 建议：${p.fix}`)
  }
  lines.push(`\n> ${result.note}`)
  return lines.join('\n')
}

/** ValueSchemaSpec 风格的 finding schema（与 clinic 一致）。 */
const findingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: { type: 'string', required: true },
    check: { type: 'string', required: true },
    package: { type: 'string', required: true },
    message: { type: 'string', required: true },
    fix: { type: 'string', required: true },
    evidence: { type: 'json' },
  },
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 未声明 Config，config 原样传入（默认 undefined）
 */
export function apply(ctx, config) {
  const cfg = config ?? {}
  if (cfg.enabled === false) return

  /**
   * 工具一：装后检测。
   */
  ctx.tools.register(defineTool({
    name: 'dsh_depguard_check',
    description: '扫描 DeepSeek Harness 的依赖拓扑：检测 @deepseek-ai/dsh-* 核心包的多份物理副本（Symbol 键冲突根因）、版本漂移、插件私包核心服务。这些是 "Cannot read properties of undefined (reading \'prepare\')" 崩溃的根因。只读，不修改任何文件；修复建议见每条 finding 的 fix 字段。',
    parameters: {
      profile: { type: 'string', description: '只扫描指定 profile；缺省扫描 DSH home 下全部 profile' },
      details: { type: 'boolean', description: '是否返回每条 finding 的 evidence（副本路径/版本等）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemaVersion: { type: 'integer', required: true },
          generatedAt: { type: 'string', required: true },
          summary: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              critical: { type: 'integer', required: true },
              warning: { type: 'integer', required: true },
              info: { type: 'integer', required: true },
            },
          },
          profiles: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                profile: { type: 'string', required: true },
                summary: {
                  type: 'object', required: true, additionalProperties: false,
                  properties: {
                    critical: { type: 'integer', required: true },
                    warning: { type: 'integer', required: true },
                    info: { type: 'integer', required: true },
                  },
                },
                findings: { type: 'array', required: true, items: findingSchema },
              },
            },
          },
        },
      },
      render: (_args, report) => [{
        type: 'text',
        text: renderCheckReport(report),
      }],
    },
    async execute(args = {}) {
      return scanDependencies({
        root: cfg.root,
        profile: args.profile,
        details: args.details === true,
        maxDepth: cfg.maxDepth ?? 8,
      })
    },
  }))

  /**
   * 工具二：装前预测。
   */
  ctx.tools.register(defineTool({
    name: 'dsh_depguard_predict',
    description: '安装新插件之前预测依赖冲突风险：拉取目标插件的 package.json 声明（npm 包名或 github:owner/repo 或本地路径），与当前 runtime 的 @deepseek-ai/dsh-* 基准比对，判断是否会导致多副本 / 版本漂移 / 私包核心服务。预测基于静态声明，装上后请再跑 dsh_depguard_check 确认。',
    parameters: {
      target: { type: 'string', required: true, description: '要预测的插件：npm 包名（@scope/name）或 github:owner/repo 或本地路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          verdict: { type: 'string', required: true },
          manifest: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              version: { type: 'string', required: true },
            },
          },
          prediction: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                risk: { type: 'string', required: true },
                check: { type: 'string', required: true },
                package: { type: 'string', required: true },
                detail: { type: 'string', required: true },
                fix: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: renderPrediction(result),
      }],
    },
    async execute(args = {}) {
      return await predict({ target: args.target, root: cfg.root })
    },
  }))
}

export { scanDependencies, predict }
