/**
 * xunfei-compatible：为 DSH 注册一个新的 provider route，修复讯飞 MaaS
 * `spark-x2.6` 把工具链当普通文本吐出来、导致 agent loop 直接结束任务的问题。
 *
 * ## 设计（方案 a：薄包装 adapter）
 *
 * 本 adapter 不实现任何 HTTP。它只是在 StreamChunk 层包住**已有的** pi-ai route：
 *
 *   请求  →  ctx.llm.stream({ ...options, provider: targetProvider })
 *   响应  →  rewriteTextToolCalls(upstream, ...)  →  交回给 agent loop
 *
 * 为什么选这个形态（而不是包装 pi-ai 事件流、或自建 api factory）：
 *
 *   1. **不碰 wire**。讯飞的 OpenAI 协议本身完全正常（N5 实测），唯一缺的是
 *      「文本化的工具链 → 标准 tool_calls」这一次翻译。翻译发生在 chunk 层，
 *      就不必重新实现鉴权、重试、图片投影、attribution headers 等一切东西。
 *   2. **下游是真 route，不会递归**。`targetProvider` 指向 pi-ai 注册的
 *      `xunfei`，而本 adapter 占用的 route 名不同，所以 `ctx.llm.stream()` 只会
 *      走到 pi-ai，回不到自己身上。构造时若发现两者相同会直接拒绝。
 *   3. **StreamChunk 层够用**。协议里 text 与 tool-call 是彼此独立的块类型，
 *      `BlockAssembler` 用 index 关联、`block-end` 携带权威块内容，所以「丢掉
 *      text 块、改发 tool-call 块、把 finish 从 stop 改成 tool-calls」是合法改写，
 *      没有 block/replay 约束阻碍。（pi-ai 事件流的 `toStreamChunks` 不是导出
 *      的，包装它需要 fork 整个包，成本远高于收益。）
 *
 * ## 可追溯性
 *
 * 会话日志记录的是**本 adapter 发出的 chunks**。改写后日志里就是一条正常的
 * 带 tool-call 的 assistant 消息，能由 chunks 完整重建。被丢弃的 `<tool_call>`
 * 原文从未进入日志，因此 model-visible ⟺ logged 成立。本插件不修改请求
 * （loop-built request 是 deep-frozen），也不碰 system prompt。
 *
 * @module xunfei-compatible-adapter
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { parseTextToolCalls } from './parse-text-tool-calls.js'
import { rewriteTextToolCalls } from './stream-rewriter.js'

/** 默认占用的 route 名。不能与 `xunfei` 相同，否则注册时 `DUPLICATE_ADAPTER`。 */
const DEFAULT_ROUTE = 'xunfei-compatible'

/** 默认下游 provider route（用户现有配置里的那条，保持不动）。 */
const DEFAULT_TARGET_PROVIDER = 'xunfei'

/**
 * 解析并校验插件配置。
 *
 * 这里不用 schemastery 是为了让 bundle 保持零运行时依赖：配置字段很少，
 * 手写校验能给出更具体的中文报错，也不会因为宿主升级 schemastery 大版本而挂。
 *
 * @param {unknown} raw - `cordis.patch.yml` 里这一行的 `config`。
 * @returns {{
 *   route: string,
 *   targetProvider: string,
 *   displayName: string,
 *   parseTextToolCalls: boolean,
 *   logEnabled: boolean,
 *   logPath: string,
 * }} 归一化后的配置。
 */
function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}

  const route = typeof config.route === 'string' && config.route.length > 0 ? config.route : DEFAULT_ROUTE
  const targetProvider = typeof config.targetProvider === 'string' && config.targetProvider.length > 0
    ? config.targetProvider
    : DEFAULT_TARGET_PROVIDER

  // 同名会让 ctx.llm.stream() 回到自己身上，形成递归并把栈打穿。必须在注册前拒绝。
  if (route === targetProvider) {
    throw new Error(
      `xunfei-compatible: route 与 targetProvider 不能相同（都是 "${route}"）。`
      + ' targetProvider 必须指向已存在的那条 provider route，例如 "xunfei"。',
    )
  }

  const logEnabled = config.logEnabled !== false
  const logPath = typeof config.logPath === 'string' && config.logPath.length > 0
    ? config.logPath
    : join(homedir(), '.dsh', 'xunfei-compatible-adapter', 'adapter-requests.jsonl')

  return {
    route,
    targetProvider,
    displayName: typeof config.displayName === 'string' && config.displayName.length > 0
      ? config.displayName
      : '讯飞（文本工具链修正）',
    // 关掉它就退化成纯转发 route（便于对比排查，也便于紧急止血）
    parseTextToolCalls: config.parseTextToolCalls !== false,
    logEnabled,
    logPath,
  }
}

/**
 * 创建一个 best-effort 的 JSONL 请求日志写入器。
 *
 * 日志失败绝不影响模型调用：任何写盘异常都被吞掉（只在首次失败时打一条
 * warning），因为「诊断信息没记上」远不如「用户的会话被日志搞挂」严重。
 *
 * @param {string} logPath - 目标 JSONL 路径。
 * @param {object} logger - Cordis logger（用其 warn 上报首次写失败）。
 * @returns {(record: object) => void} 追加一条记录的同步入口。
 */
function createRequestLog(logPath, logger) {
  let directoryReady = false
  let warned = false

  return (record) => {
    const line = `${JSON.stringify(record)}\n`
    void (async () => {
      try {
        if (!directoryReady) {
          await mkdir(dirname(logPath), { recursive: true })
          directoryReady = true
        }
        await appendFile(logPath, line, 'utf8')
      } catch (error) {
        if (!warned) {
          warned = true
          logger?.warn?.(`xunfei-compatible: 无法写入请求日志 ${logPath}`)
          logger?.warn?.(error)
        }
      }
    })()
  }
}

/**
 * 从请求里取出本次声明的工具名，以及诊断用的形状信息。
 *
 * `options.tools` 已在运行时侧完成 tool-update 投影，因此这里看到的就是
 * 最终发给 provider 的那一份。`MISSING` 与 `0` 必须区分开：前者是字段缺失，
 * 后者是显式空数组，两者都可能触发讯飞的文本化行为，但成因不同。
 *
 * @param {object} options - `GenerateOptions`。
 * @returns {{toolNames: string[], toolsShape: number | 'MISSING'}} 工具名与形状。
 */
function readToolShape(options) {
  const tools = options?.tools
  if (!Array.isArray(tools)) return { toolNames: [], toolsShape: 'MISSING' }
  const toolNames = tools
    .map((tool) => (tool !== null && typeof tool === 'object' ? tool.name : undefined))
    .filter((name) => typeof name === 'string' && name.length > 0)
  return { toolNames, toolsShape: tools.length }
}

/**
 * 从历史里判断这一轮之前是否出现过工具调用（用于区分「首次触发」与「多轮中途」）。
 * @param {object} options - `GenerateOptions`。
 * @returns {boolean} 历史里是否已有 tool-call 块。
 */
function hasToolHistory(options) {
  if (options?.toolHistory !== undefined) return true
  const messages = options?.messages
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    if (message.content.some((block) => block?.type === 'tool-call' || block?.type === 'tool-result')) return true
  }
  return false
}

/**
 * 构造包装 adapter。
 *
 * 只依赖 `ctx.llm` 的四个公开方法（`stream` / `listModels` / `resolveModelInfo` /
 * `providerRetryPolicy`），不 import 任何 `@deepseek-ai/*` 运行时包，
 * 这样 bundle 在 profile 里不需要解析任何 peer 依赖。
 *
 * @param {object} ctx - Cordis Context（需已挂载 `llm` 服务）。
 * @param {ReturnType<typeof resolveConfig>} config - 归一化配置。
 * @param {(record: object) => void} log - 诊断日志写入器。
 * @returns {object} 满足 `LlmAdapter` 鸭子类型的对象。
 */
function createAdapter(ctx, config, log) {
  const { route, targetProvider } = config

  /** 当前正在流式中的请求数，仅用于日志。 */
  let inFlight = 0

  return {
    /**
     * 该 route 的显示元数据。`id` 必须等于注册时的 route 名。
     * @param {string} provider - 注册时传入的 route 名。
     * @returns {{id: string, name: string}} 展示信息。
     */
    providerInfo(provider) {
      return { id: provider, name: config.displayName }
    },

    /**
     * 沿用下游 route 的重试策略，让用户在 `xunfei` 上配的策略继续生效。
     * @param {string} provider - 本 adapter 的 route 名。
     * @returns {object | undefined} 已解析的重试策略。
     */
    providerRetryPolicy(provider) {
      try {
        return ctx.llm.providerRetryPolicy(targetProvider)
      } catch {
        // 下游还没注册时不要连累本插件加载：返回 undefined 走默认策略。
        return undefined
      }
    },

    /**
     * 把下游 route 的模型目录镜像过来，只改 `provider` 字段。
     *
     * 这一步决定 GUI 的模型选择器能否列出本 route 的模型；不改 `provider`
     * 字段会被 `LlmRuntime.listModels()` 判为 `INVALID_CATALOG`。
     *
     * @param {string} provider - 本 adapter 的 route 名。
     * @returns {Promise<object[]>} 本 route 的模型列表。
     */
    async listModels(provider) {
      const models = await ctx.llm.listModels(targetProvider)
      return models.map((model) => ({ ...model, provider }))
    },

    /**
     * 转发精确模型元数据（上下文窗口、推理档位等），只改 `provider` 字段。
     *
     * 这样 `resolveCallWithInfo` 才能用讯飞模型真实的 reasoningEfforts 校验
     * 用户选的档位，而不是走 1M 默认值。
     *
     * @param {string} provider - 本 adapter 的 route 名。
     * @param {string} model - 模型 id。
     * @param {AbortSignal} [signal] - 取消信号。
     * @returns {Promise<object>} 本 route 视角下的模型元数据。
     */
    async resolveModel(provider, model, signal) {
      const info = await ctx.llm.resolveModelInfo(targetProvider, model, signal)
      return { ...info, provider }
    },

    /**
     * 绑定一次请求的模型元数据与派发入口。
     *
     * **必需**：`LlmRuntime.prepareCall()` 与 `adapterStream()` 都会**无条件**调用
     * `adapter.prepareCall(...)`（`dsh-llm/lib/index.js` 2334、2428 行），
     * 不存在时会抛 `registration.adapter.prepareCall is not a function`，
     * 整个会话无法发请求。基类 `LlmAdapter` 有默认实现，但本插件不继承基类
     * （为了零依赖），所以必须自己提供。
     *
     * @param {string} provider - 本 adapter 的 route 名。
     * @param {string} model - 模型 id。
     * @param {AbortSignal} [signal] - 取消信号。
     * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>}
     *   精确模型元数据，以及同代次的派发入口。
     */
    async prepareCall(provider, model, signal) {
      // 与基类默认实现同构：解析一次元数据，stream 走本 adapter 的 stream。
      const info = await this.resolveModel(provider, model, signal)
      return {
        model: info,
        stream: (options) => this.stream(options),
      }
    },

    /**
     * 声明本 route 不提供 provider 侧图片计价。
     *
     * **必需**：`LlmRuntime.imageRequestPricing()` 无条件调用（2169 行附近），
     * 返回 `undefined` 表示「本 route 不声明图片计价」，由消费方回退到中性估算。
     * @returns {undefined} 恒为 undefined。
     */
    imageRequestPricing() {
      return undefined
    },

    /**
     * 解析图片请求投影的尺寸与字节目标。
     *
     * **必需**：`LlmRuntime.imageRequestTarget()` 无条件调用（2169 行附近）。
     * 本插件不改变图片行为，因此原样透传附件自身的宽高与字节数，
     * 与基类默认实现一致。
     * @param {string} _provider - 本 adapter 的 route 名。
     * @param {string} _model - 模型 id。
     * @param {object} image - 归一化后的图片引用（含 width / height / bytes）。
     * @returns {{width: number, height: number, maxBytes: number}} 原样投影。
     */
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    /**
     * 流式请求入口：转发到下游 route，并在 chunk 层做文本化工具链救火。
     *
     * @param {object} options - 完整请求（`options.provider` 是本 route 名）。
     * @returns {AsyncIterable<object>} 可能被改写的 chunk 流。
     */
    async *stream(options) {
      const { toolNames, toolsShape } = readToolShape(options)
      const hadToolHistory = hasToolHistory(options)
      inFlight += 1

      // 转发给下游：只替换 provider，其余（messages/tools/system/…）原样。
      // 不修改 messages，因此 loop-built request 的不可变性不受影响。
      const forwarded = { ...options, provider: targetProvider }

      let converted = false
      const startedAt = Date.now()
      try {
        // 请求期硬检查：此时必须能路由到下游，否则给出可读诊断，
        // 而不是让用户看到一句裸的 NO_ADAPTER。
        const available = ctx.llm.listProviders().map((provider) => provider.id)
        if (!available.includes(targetProvider)) {
          throw new Error(
            `xunfei-compatible: 下游 provider route "${targetProvider}" 未注册，无法转发。`
            + ` 已注册：${available.join(', ') || '无'}。`
            + ' 请检查 cordis.patch.yml 中 dsh-llm-pi-ai 的 providers 是否包含该 route。',
          )
        }

        const upstream = ctx.llm.stream(forwarded)
        const rewritten = rewriteTextToolCalls(upstream, {
          toolNames,
          convert: config.parseTextToolCalls,
          log: (event) => {
            if (event.event === 'converted') converted = true
            if (config.logEnabled) log({ t: new Date().toISOString(), route, ...event })
          },
        })
        for await (const chunk of rewritten) yield chunk
      } finally {
        inFlight -= 1
        if (config.logEnabled) {
          log({
            t: new Date().toISOString(),
            route,
            model: options?.model,
            toolsShape,
            toolsCount: typeof toolsShape === 'number' ? toolsShape : -1,
            toolNames: toolNames.slice(0, 40),
            hasToolHistory: hadToolHistory,
            converted,
            inFlight,
            durationMs: Date.now() - startedAt,
          })
        }
      }
    },
  }
}

/**
 * Cordis 插件入口。
 *
 * 注册**不做**「下游 route 必须已存在」的硬性检查：本插件与 `dsh-llm-pi-ai`
 * 的加载顺序由 profile 的 bundle 列表决定，不保证 pi-ai 先注册完 route。
 * 在这里抛错会因加载顺序而让插件加载失败（加载器只记日志，用户很难看懂）。
 * 因此改为：注册期仅在缺失时记一条 warning，真正的可用性在请求期检查。
 *
 * @param {object} ctx - Cordis Context。
 * @param {unknown} config - 本行的 `config`。
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  // 注册期软检查：下游缺失只警告，不阻断本插件加载。
  const registered = ctx.llm.listProviders().map((provider) => provider.id)
  if (!registered.includes(resolved.targetProvider)) {
    ctx.logger?.warn?.(
      `xunfei-compatible: 下游 provider route "${resolved.targetProvider}" 当前未注册`
      + `（已注册：${registered.join(', ') || '无'}）。`
      + ' 如果是加载顺序问题，稍后会自动可用；若持续缺失，请检查 dsh-llm-pi-ai 的 providers 配置。',
    )
  }

  const log = createRequestLog(resolved.logPath, ctx.logger)
  const adapter = createAdapter(ctx, resolved, log)

  ctx.effect(function* registerCompatRoute() {
    const handle = ctx.llm.registerAdapter([resolved.route], adapter)
    yield () => handle()
  })
}

/** 本插件必须等 `llm` 服务就绪才能注册 route。 */
export const inject = ['llm']