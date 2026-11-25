/**
 * 契约验证：用宿主**真实的** `LlmRuntime` 驱动本 adapter，确认它满足 adapter 契约。
 *
 * 为什么必须有这个文件：之前的 14 例测试都用手写的 `ctx.llm` 替身，
 * 替身只调 `stream`/`listModels` 等方法，从不调 `prepareCall`，
 * 于是漏掉了「adapter 缺 `prepareCall` 会让整个会话无法发请求」这个致命缺陷。
 * 教训：**契约必须用真实运行时验证，不能用自己写的替身**。
 *
 * 需要能读 ASAR 的运行时（Electron），因为 `@deepseek-ai/dsh-llm` 在 `app.asar` 内：
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & '<DeepSeek Harness 安装目录>\DeepSeek Harness.exe' test\real-contract.electron.mjs
 *
 * 本环境捕获子进程 stdout 会失败，结果写文件。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply } from '../lib/index.js'
import { defaultResultDir, locateDshRuntime, locateHelp } from './locate-dsh.mjs'

const OUT = process.argv[2] ?? join(defaultResultDir(), 'real-contract-result.txt')

/** 讯飞实测原文。 */
const XUNFEI_TEXT_CALL = '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'

const lines = []
const log = (line) => lines.push(String(line))
let failures = 0

async function check(label, body) {
  try {
    await body()
    log(`PASS  ${label}`)
  } catch (error) {
    failures += 1
    log(`FAIL  ${label}`)
    log(`      ${String(error?.message ?? error).split('\n').slice(0, 3).join('\n      ')}`)
  }
}

const eq = (a, b, what) => {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) throw new Error(`${what}: 期望 ${sb}，实际 ${sa}`)
}
const ok = (v, what) => { if (!v) throw new Error(what) }

/**
 * 构造真实的 Cordis Context。
 *
 * `LlmRuntime` 是 `TypertRemoteService` 子类，构造时会走 Cordis 的
 * `ctx.reflect.provide(...)`，因此**必须**用真实 `Context`，手写替身不够用
 * （这正是第一版替身报 `reading 'provide'` 的原因）。
 *
 * @param {string} cordisEntry - `@deepseek-ai/cordis` 的入口绝对路径。
 * @returns {Promise<{ctx: object, warns: string[]}>} 根 Context 与其告警收集器。
 */
async function makeCtx(cordisEntry) {
  const cordis = await import(pathToFileURL(cordisEntry).href)
  const { Context } = cordis
  ok(typeof Context === 'function', 'cordis 未导出 Context')

  const root = new Context()
  const warns = []
  const logger = root.logger
  // 收窄日志：保留原始能力，只额外记录 warn/error 文本供断言
  for (const level of ['warn', 'error']) {
    const original = logger[level].bind(logger)
    logger[level] = (...args) => {
      warns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
      return original(...args)
    }
  }
  return { ctx: root, warns }
}

/** 一个最小的「下游」adapter，模拟 pi-ai 的 xunfei route。 */
function makeDownstreamAdapter(chunksFor) {
  return {
    providerInfo: (provider) => ({ id: provider, name: '讯飞（下游替身）' }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 5 }),
    listModels: (provider) => [{ provider, id: 'spark-x2.6', name: 'spark-x2.6' }],
    resolveModel: (provider, model) => ({
      provider, id: model, name: model, context: { contextWindow: 128000 },
    }),
    prepareCall(provider, model) {
      return Promise.resolve({
        model: { provider, id: model, name: model, context: { contextWindow: 128000 } },
        stream: (options) => this.stream(options),
      })
    },
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    stream(options) {
      return (async function* emit() {
        for (const chunk of chunksFor(options)) yield chunk
      })()
    },
  }
}

function xunfeiChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 42, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

async function main() {
  log('# 真实 LlmRuntime 契约验证')
  log(`# 运行时: ${process.versions.electron === undefined ? 'node' : `electron ${process.versions.electron}`}`)
  log('')

  const located = locateDshRuntime()
  if (located === undefined) {
    log('SKIP 未能定位 DSH 安装目录，本测试无法进行')
    log('')
    log(locateHelp())
    writeFileSync(OUT, lines.join('\n'), 'utf8')
    return
  }
  log(`# node_modules: ${located.nodeModules}`)
  log('')

  let llmModule
  try {
    llmModule = await import(pathToFileURL(located.dshLlm).href)
  } catch (error) {
    log(`FATAL 无法加载真实 dsh-llm: ${error?.code ?? ''} ${error?.message ?? error}`)
    log('')
    log(locateHelp())
    writeFileSync(OUT, lines.join('\n'), 'utf8')
    return
  }

  const { LlmRuntime, BlockAssembler } = llmModule
  ok(typeof LlmRuntime === 'function', 'LlmRuntime 未导出')
  ok(typeof BlockAssembler === 'function', 'BlockAssembler 未导出')
  log('真实模块已加载（LlmRuntime + BlockAssembler）')
  log('')

  /**
   * 搭一套「真实 LlmRuntime + 下游替身 + 本 adapter」的环境。
   * @param {string} upstreamText - 下游要吐的正文。
   */
  async function buildWorld(upstreamText) {
    const { ctx, warns } = await makeCtx(located.cordis)
    const llm = new LlmRuntime(ctx)
    // LlmRuntime 构造时经 ctx.reflect.provide 注册自身；在本测试里服务尚未进入
    // 任何插件 fiber，所以直接把它挂到根 Context 上，等价于 Cordis 的注入结果。
    ctx.llm = llm

    // 先把下游注册成 xunfei（模拟 pi-ai 已就绪）
    const downstream = makeDownstreamAdapter(() => xunfeiChunks(upstreamText))
    llm.registerAdapter(['xunfei'], downstream)

    // 再加载本插件
    apply(ctx, { logEnabled: false })

    return { llm, ctx, warns }
  }

  // ── 1. 最关键：adapter 契约方法是否齐全 ──────────────────────
  await check('adapter 具备全部必需方法（prepareCall / imageRequestPricing / imageRequestTarget）', async () => {
    const { llm } = await buildWorld('好。')
    // 通过真实公开 API 触发，而不是直接摸内部字段
    const prepared = await llm.prepareCall({ provider: 'xunfei-compatible', model: 'spark-x2.6' })
    ok(prepared !== undefined, 'prepareCall 返回空')
    ok(typeof prepared.stream === 'function', 'prepared.stream 不是函数')

    const info = await llm.resolveModelInfo('xunfei-compatible', 'spark-x2.6')
    eq(info.provider, 'xunfei-compatible', 'resolveModelInfo.provider')

    const models = await llm.listModels('xunfei-compatible')
    ok(models.length === 1 && models[0].provider === 'xunfei-compatible', 'listModels 未改写 provider')
  })

  await check('imageRequestPricing 可被调用（不抛 is not a function）', async () => {
    const { llm } = await buildWorld('好。')
    const pricing = llm.imageRequestPricing('xunfei-compatible', 'spark-x2.6')
    eq(pricing, undefined, 'imageRequestPricing')
  })

  await check('imageRequestTarget 原样透传尺寸（与基类默认一致）', async () => {
    const { llm } = await buildWorld('好。')
    const target = llm.imageRequestTarget('xunfei-compatible', 'spark-x2.6', {
      attachmentId: 'sha256:abc', width: 800, height: 600, bytes: 1234, mediaType: 'image/png',
    })
    eq(target, { width: 800, height: 600, maxBytes: 1234 }, 'imageRequestTarget')
  })

  // ── 2. 真实 prepareCall 路径能发出请求（本次 bug 的直接回归）──
  await check('经真实 prepareCall 派发：空 tools 场景被改写为 tool-calls', async () => {
    const { llm } = await buildWorld(XUNFEI_TEXT_CALL)

    const prepared = await llm.prepareCall({ provider: 'xunfei-compatible', model: 'spark-x2.6' })
    const request = {
      ...prepared.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: '北京天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }
    const chunks = await collect(prepared.stream(request))

    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    eq(assembler.finish, { kind: 'tool-calls' }, 'finish')
    const calls = assembler.blocks().filter((b) => b.type === 'tool-call')
    eq(calls.length, 1, 'tool-call 数量')
    eq(calls[0].name, 'get_weather', '工具名')
    eq(JSON.parse(calls[0].arguments), { city: 'Beijing' }, '参数')
    eq(assembler.usage, { inputTokens: 42, outputTokens: 8 }, 'usage 保留')
  })

  await check('经真实 llm.stream() 派发：普通回答保持 stop', async () => {
    const { llm } = await buildWorld('北京今天多云。')

    const chunks = await collect(llm.stream({
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))

    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    eq(assembler.finish, { kind: 'stop' }, 'finish')
    const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
    eq(text, '北京今天多云。', '正文')
  })

  // ── 3. 不影响其他 route ─────────────────────────────────────
  await check('原 xunfei route 仍可独立工作（未被本插件影响）', async () => {
    const { llm } = await buildWorld('好。')
    const prepared = await llm.prepareCall({ provider: 'xunfei', model: 'spark-x2.6' })
    const chunks = await collect(prepared.stream({
      ...prepared.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    eq(assembler.finish, { kind: 'stop' }, '原 route finish')
  })

  // ── 4. 确认两条 route 同时存在 ──────────────────────────────
  await check('listProviders 同时包含 xunfei 与 xunfei-compatible', async () => {
    const { llm } = await buildWorld('好。')
    const ids = llm.listProviders().map((p) => p.id).sort()
    eq(ids, ['xunfei', 'xunfei-compatible'], 'providers')
  })

  log('')
  log(`SUMMARY failures=${failures}`)
  writeFileSync(OUT, lines.join('\n'), 'utf8')
}

void main().catch((error) => {
  log(`FATAL ${error?.stack ?? error}`)
  try { writeFileSync(OUT, lines.join('\n'), 'utf8') } catch {}
})