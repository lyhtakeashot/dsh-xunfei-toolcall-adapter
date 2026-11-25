/**
 * 安装后验证：在「模拟宿主」里跑一遍真实插件代码，确认 route 注册与改写行为。
 *
 * 这不是替代真实 GUI 验证，而是把「插件被宿主加载后会发生什么」在进程内复现一遍，
 * 用来排除「装上了但代码跑不通」的情况。
 *
 * 运行（bundled Node，结果写文件因为本环境捕获 stdout 会失败）：
 *   node test/installed-smoke.mjs <输出文件路径>
 */

import { writeFileSync } from 'node:fs'

import { apply } from '../lib/index.js'

/** 讯飞实测原文。 */
const XUNFEI_TEXT_CALL = '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'

const outPath = process.argv[2] ?? 'installed-smoke-result.txt'
const lines = []
const log = (line) => lines.push(String(line))

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    log(`PASS  ${label}`)
  } else {
    failures += 1
    log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * 构造模拟宿主 ctx。
 *
 * 关键：这个替身**已经注册了 `xunfei`**，模拟「pi-ai 先加载完」的正常顺序；
 * 同时验证插件会注册 `xunfei-compatible` 且不与 `xunfei` 冲突。
 */
function makeHost({ upstreamChunks, withDownstream = true }) {
  const registry = new Map(
    withDownstream ? [['xunfei', { id: 'xunfei', name: '讯飞' }]] : [],
  )
  const registered = []
  const warnings = []
  const disposers = []

  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)), error: (m) => warnings.push(String(m)) },
    effect(generator) {
      const iterator = generator.call(ctx.llm)
      let step = iterator.next()
      while (!step.done) {
        disposers.push(step.value)
        step = iterator.next()
      }
    },
    llm: {
      listProviders: () => [...registry.values()],
      registerAdapter: (routes, adapter) => {
        for (const route of routes) {
          if (registry.has(route)) throw new Error(`DUPLICATE_ADAPTER: ${route}`)
          registry.set(route, { id: route, name: adapter.providerInfo(route).name })
        }
        registered.push({ routes, adapter })
        return Object.assign(() => {
          for (const route of routes) registry.delete(route)
        }, { replace: () => {} })
      },
      providerRetryPolicy: (provider) => {
        if (!registry.has(provider)) throw new Error(`NO_ADAPTER: ${provider}`)
        return { mode: 'normal', maxRetries: 5 }
      },
      listModels: async (provider) => {
        if (!registry.has(provider)) throw new Error(`NO_ADAPTER: ${provider}`)
        return [{ provider, id: 'spark-x2.6', name: 'spark-x2.6' }]
      },
      resolveModelInfo: async (provider, model) => {
        if (!registry.has(provider)) throw new Error(`NO_ADAPTER: ${provider}`)
        return { provider, id: model, name: model, context: { contextWindow: 128000 } }
      },
      stream: (request) => {
        if (!registry.has(request.provider)) throw new Error(`NO_ADAPTER: ${request.provider}`)
        return (async function* emit() {
          for (const chunk of upstreamChunks) yield chunk
        })()
      },
    },
  }

  return { ctx, registry, registered, warnings, disposers }
}

/** 讯飞式上游流。 */
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
  log('# 安装后冒烟验证（模拟宿主，真实插件代码）')
  log('')

  // ── 1. 注册行为 ────────────────────────────────────────────
  {
    const host = makeHost({ upstreamChunks: xunfeiChunks('好。') })
    // 用临时日志路径，不污染用户目录
    apply(host.ctx, { logEnabled: false })

    check('插件注册了 xunfei-compatible',
      host.registry.has('xunfei-compatible'),
      `当前 routes: ${[...host.registry.keys()].join(', ')}`)
    check('原 xunfei route 仍然存在（未被夺走）', host.registry.has('xunfei'))
    check('没有产生 DUPLICATE_ADAPTER 警告',
      !host.warnings.some((w) => w.includes('DUPLICATE')),
      host.warnings.join(' | '))
    check('注册了恰好 1 个 adapter', host.registered.length === 1, String(host.registered.length))
    check('providerInfo 的 id 与 route 名一致',
      host.registered[0]?.adapter.providerInfo('xunfei-compatible').id === 'xunfei-compatible')
  }

  // ── 2. 空 tools 场景：文本化调用被改写 ─────────────────────
  {
    const host = makeHost({ upstreamChunks: xunfeiChunks(XUNFEI_TEXT_CALL) })
    apply(host.ctx, { logEnabled: false })
    const adapter = host.registered[0].adapter

    const chunks = await collect(adapter.stream({
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '北京天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))

    const finish = chunks.find((c) => c.type === 'finish')
    const toolCalls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
    const textJoined = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

    check('finish 变成 tool-calls', finish?.reason?.kind === 'tool-calls', JSON.stringify(finish?.reason))
    check('产出 1 个 tool-call 块', toolCalls.length === 1, String(toolCalls.length))
    check('工具名正确', toolCalls[0]?.block?.name === 'get_weather', toolCalls[0]?.block?.name)
    check('参数是 raw JSON 字符串且可解析',
      typeof toolCalls[0]?.block?.arguments === 'string'
      && JSON.parse(toolCalls[0].block.arguments).city === 'Beijing',
      toolCalls[0]?.block?.arguments)
    check('无标签文本泄漏',
      !/<tool_call>|<arg_key>|<arg_value>/.test(textJoined),
      JSON.stringify(textJoined))
    const usageIdx = chunks.findIndex((c) => c.type === 'usage')
    const finishIdx = chunks.findIndex((c) => c.type === 'finish')
    check('usage 在 finish 之前', usageIdx >= 0 && usageIdx < finishIdx, `${usageIdx} < ${finishIdx}`)
    check('finish 是最后一个 chunk', finishIdx === chunks.length - 1)
  }

  // ── 3. 正常回答：原样透传 ──────────────────────────────────
  {
    const host = makeHost({ upstreamChunks: xunfeiChunks('北京今天多云。') })
    apply(host.ctx, { logEnabled: false })
    const adapter = host.registered[0].adapter

    const chunks = await collect(adapter.stream({
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))

    const finish = chunks.find((c) => c.type === 'finish')
    const textJoined = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    check('普通回答保持 stop', finish?.reason?.kind === 'stop', JSON.stringify(finish?.reason))
    check('正文完整', textJoined === '北京今天多云。', JSON.stringify(textJoined))
    check('没有虚构 tool-call',
      chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').length === 0)
  }

  // ── 4. 目录与元数据转发 ────────────────────────────────────
  {
    const host = makeHost({ upstreamChunks: xunfeiChunks('好') })
    apply(host.ctx, { logEnabled: false })
    const adapter = host.registered[0].adapter

    const models = await adapter.listModels('xunfei-compatible')
    check('listModels 返回模型', models.length === 1 && models[0].id === 'spark-x2.6')
    check('listModels 的 provider 被改写为本 route',
      models[0]?.provider === 'xunfei-compatible', models[0]?.provider)

    const info = await adapter.resolveModel('xunfei-compatible', 'spark-x2.6')
    check('resolveModel 转发上下文窗口', info.context?.contextWindow === 128000)
    check('resolveModel 的 provider 被改写', info.provider === 'xunfei-compatible')

    const policy = adapter.providerRetryPolicy('xunfei-compatible')
    check('沿用下游重试策略', policy?.maxRetries === 5, JSON.stringify(policy))
  }

  // ── 5. 加载顺序：下游未注册时不崩 ──────────────────────────
  {
    const host = makeHost({ upstreamChunks: [], withDownstream: false })
    let threw
    try {
      apply(host.ctx, { logEnabled: false })
    } catch (error) {
      threw = error
    }
    check('下游缺失时 apply 不抛错', threw === undefined, threw?.message)
    check('下游缺失时仍注册本 route', host.registry.has('xunfei-compatible'))
    check('下游缺失时给出 warning',
      host.warnings.some((w) => w.includes('未注册')),
      host.warnings.join(' | '))
  }

  log('')
  log(`SUMMARY failures=${failures}`)
  writeFileSync(outPath, lines.join('\n'), 'utf8')
}

void main().catch((error) => {
  log(`FATAL ${error?.stack ?? error}`)
  try { writeFileSync(outPath, lines.join('\n'), 'utf8') } catch {}
})