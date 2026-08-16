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
 * @module dsh-depguard
 */

import { scanDependencies, summarize } from './engine/index.js'
import { predict } from './engine/predict.js'

export const name = 'depguard'

/** 需要的服务：tools 用于注册模型工具。 */
export const inject = ['tools']

/** 插件配置。 */
export const Config = {
  enabled: { type: 'boolean', default: true },
  profiles: { type: 'array', items: { type: 'string' }, default: [] },
  maxDepth: { type: 'number', default: 8 },
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{enabled?: boolean, profiles?: string[], maxDepth?: number}} config
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const tools = ctx.tools

  /**
   * 工具一：装后检测。
   * 扫描 profile 依赖拓扑，报告 duplicate-copy / version-drift / vendored-service。
   */
  tools.register({
    name: 'dsh_depguard_check',
    description: '扫描 DeepSeek Harness 的依赖拓扑：检测 @deepseek-ai/dsh-* 核心包的多份物理副本、版本漂移、插件私包核心服务。这些是 "Cannot read properties of undefined (reading \'prepare\')" 崩溃的根因。只读，不修改任何文件；修复建议见每条 finding 的 fix 字段。',
    parameters: {
      profile: {
        type: 'string',
        description: '只扫描指定 profile；缺省扫描 DSH home 下全部 profile',
      },
      details: {
        type: 'boolean',
        default: false,
        description: '是否返回每条 finding 的 evidence（副本路径/版本等）',
      },
    },
    async execute(args = {}) {
      const report = scanDependencies({
        root: config.root,
        profile: args.profile,
        details: args.details === true,
        maxDepth: config.maxDepth ?? 8,
      })
      return {
        schemaVersion: report.schemaVersion,
        generatedAt: report.generatedAt,
        summary: report.summary,
        profiles: report.profiles,
      }
    },
  })

  /**
   * 工具二：装前预测。
   * 不安装，静态拉取目标插件的 manifest 并比对 runtime 基准，输出风险预警。
   */
  tools.register({
    name: 'dsh_depguard_predict',
    description: '安装新插件之前预测依赖冲突风险：拉取目标插件的 package.json 声明（npm 包名或 github:owner/repo），与当前 runtime 的 @deepseek-ai/dsh-* 基准比对，判断是否会导致多副本 / 版本漂移 / 私包核心服务。预测基于静态声明，装上后请再跑 dsh_depguard_check 确认。',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: '要预测的插件：npm 包名（@scope/name）或 github:owner/repo 或本地路径',
      },
    },
    async execute(args = {}) {
      return await predict({ target: args.target, root: config.root })
    },
  })
}

export { scanDependencies, predict, summarize }
