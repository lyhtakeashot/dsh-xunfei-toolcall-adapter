/**
 * 自测：包装 adapter 与 DSH LLM 服务的契约。
 *
 * 这里用一个最小的 `ctx.llm` 替身，验证四件事：
 *   1. 转发时 `provider` 被换成 targetProvider，其他字段原样不动；
 *   2. 改写后的 chunks 能被真实的 `BlockAssembler` 重建出工具调用；
 *   3. `listModels` / `resolveModel` 把 `provider` 换成自己的 route；
 *   4. 构造期校验（route 与 target 相同 → 报错；下游未注册 → 报错）。
 *
 * 运行：node xunfei-compatible-adapter/test/adapter.test.mjs
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply } from '../lib/index.js'

/** 讯飞实测原文。 */
const XUNFEI_TEXT_CALL = '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'

/**
 * 构造一个最小的 ctx 替身。
 * @param {object} options - 替身行为配置。
 * @returns {object} 假 ctx。
 */
function fakeCtx(options = {}) {
  const {
    providers = [{ id: 'xunfei', name: '讯飞' }],
    streamImpl,
    models = [{ provider: 'xunfei', id: 'spark-x2.6', name: 'spark-x2.6' }],
    modelInfo = { provider: 'xunfei', id: 'spark-x2.6', name: 'spark-x2.6', context: { contextWindow: 128000 } },
    retryPolicy = { mode: 'normal', maxRetries: 5 },
  } = options

  const calls = { registerAdapter: [], stream: [], listModels: [], resolveModelInfo: [], providerRetryPolicy: [] }
  const disposers = []

  const ctx = {
    logger: { warn() {} },
    llm: {
      listProviders: () => providers,
      registerAdapter: (routes, adapter) => {
        calls.registerAdapter.push({ routes, adapter })
        return () => {}
      },
      providerRetryPolicy: (provider) => {
        calls.providerRetryPolicy.push(provider)
        return retryPolicy
      },
      listModels: async (provider) => {
        calls.listModels.push(provider)
        return models
      },
      resolveModelInfo: async (provider, model, signal) => {
        calls.resolveModelInfo.push({ provider, model, signal })
        return modelInfo
      },
      stream: (request) => {
        calls.stream.push(request)
        return streamImpl === undefined ? stubStream([]) : streamImpl(request)
      },
    },
    effect(generator) {
      // 模拟 Cordis ctx.effect：执行 generator，收集它 yield 出来的 disposer
      const iterator = generator.call(ctx.llm)
      let step = iterator.next()
      while (!step.done) {
        disposers.push(step.value)
        step = iterator.next()
      }
      return () => { for (const dispose of disposers.reverse()) dispose() }
    },
  }

  return { ctx, calls }
}

/** 构造一个发固定 chunks 的流。 */
function stubStream(chunks) {
  return (async function* emit() {
    for (const chunk of chunks) yield chunk
  })()
}

/** 讯飞式上游：文本块 + usage + stop。 */
function xunfeiStyleChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 收集异步流。 */
async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

/** 取注册到 ctx.llm 的那个 adapter。 */
function registeredAdapter(calls) {
  assert.equal(calls.registerAdapter.length, 1, '应当注册恰好一个 adapter')
  return calls.registerAdapter[0]
}

/** 极简 BlockAssembler：与 dsh-llm 的实现同构，用来证明 chunks 能重建消息。 */
class MiniAssembler {
  constructor() {
    this.partials = new Map()
    this.order = []
    this._usage = undefined
    this._finish = undefined
  }

  push(chunk) {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, { blockType: chunk.blockType, text: '', toolCallId: undefined, toolCallName: undefined, toolCallArguments: '', block: undefined })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage':
        this._usage = chunk.usage
        return
      case 'finish':
        this._finish = chunk.reason
        return
      default:
        return
    }
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallId: undefined, toolCallName: undefined, toolCallArguments: '', block: undefined }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  assemble(partial) {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return { type: 'tool-call', id: partial.toolCallId, name: partial.toolCallName ?? '', arguments: partial.toolCallArguments }
      default: throw new Error(`cannot assemble ${partial.blockType}`)
    }
  }

  get usage() { return this._usage }
  get finish() { return this._finish ?? { kind: 'stop' } }
  blocks() { return this.order.map((index) => this.assemble(this.partials.get(index))) }
}

describe('包装 adapter：转发与 route 隔离', () => {
  it('转发时 provider 换成 targetProvider，其余字段原样不改', async () => {
    // 换一个日志路径，避免自测污染用户目录
    const { ctx, calls } = fakeCtx({ streamImpl: () => stubStream(xunfeiStyleChunks('好的。')) })
    apply(ctx, { logEnabled: false })
    const { adapter, routes } = registeredAdapter(calls)

    assert.deepEqual(routes, ['xunfei-compatible'])

    const request = {
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
      temperature: 0.2,
    }
    await collect(adapter.stream(request))

    assert.equal(calls.stream.length, 1, '应当恰好转发一次')
    const forwarded = calls.stream[0]
    assert.equal(forwarded.provider, 'xunfei', 'provider 必须被换成下游 route')
    assert.equal(forwarded.model, request.model)
    assert.equal(forwarded.messages, request.messages, 'messages 必须原样引用，不得重建')
    assert.equal(forwarded.tools, request.tools, 'tools 必须原样引用')
    assert.equal(forwarded.temperature, 0.2)

    // 原始请求对象未被改动（loop-built request 是 frozen 的，这里验证没有写回）
    assert.equal(request.provider, 'xunfei-compatible')
  })

  it('route 与 targetProvider 相同时构造即报错（防递归）', () => {
    const { ctx } = fakeCtx()
    assert.throws(
      () => apply(ctx, { route: 'xunfei', targetProvider: 'xunfei' }),
      /不能相同/,
    )
  })

  it('下游 route 未注册时只警告、不阻断插件加载（顺序无关）', () => {
    const warns = []
    const { ctx, calls } = fakeCtx({ providers: [{ id: 'deepseek-official', name: 'DeepSeek' }] })
    ctx.logger = { warn: (message) => warns.push(String(message)) }

    // 关键：不能抛。加载顺序不保证 pi-ai 已注册完 route。
    apply(ctx, { logEnabled: false })

    assert.equal(calls.registerAdapter.length, 1, '仍然要注册本 route')
    assert.ok(
      warns.some((message) => message.includes('未注册')),
      '应当给出缺失下游的警告',
    )
  })

  it('请求期下游缺失时给出可读错误，而不是裸 NO_ADAPTER', async () => {
    const { ctx, calls } = fakeCtx({
      providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
      streamImpl: () => stubStream([]),
    })
    // 注册时下游在，请求时下游没了（模拟 route 被换掉）
    const realListProviders = ctx.llm.listProviders
    apply(ctx, { logEnabled: false })
    const { adapter } = registeredAdapter(calls)
    ctx.llm.listProviders = () => [{ id: 'deepseek-official', name: 'DeepSeek' }]

    await assert.rejects(
      () => collect(adapter.stream({
        provider: 'xunfei-compatible',
        model: 'spark-x2.6',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
      })),
      /下游 provider route "xunfei" 未注册[\s\S]*deepseek-official/,
    )
    ctx.llm.listProviders = realListProviders
  })
})

describe('包装 adapter：chunks 能重建 assistant 消息', () => {
  it('空 tools 场景改写后，能由 chunks 重建出 tool-call 块且无文本泄漏', async () => {
    const { ctx, calls } = fakeCtx({ streamImpl: () => stubStream(xunfeiStyleChunks(XUNFEI_TEXT_CALL)) })
    apply(ctx, { logEnabled: false })
    const { adapter } = registeredAdapter(calls)

    const chunks = await collect(adapter.stream({
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '北京天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))

    const assembler = new MiniAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    assert.equal(assembler.finish.kind, 'tool-calls', 'finish 必须是 tool-calls')

    const blocks = assembler.blocks()
    const toolCalls = blocks.filter((block) => block.type === 'tool-call')
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0].name, 'get_weather')
    assert.deepEqual(JSON.parse(toolCalls[0].arguments), { city: 'Beijing' })

    // 文本不得泄漏原始标签
    for (const block of blocks.filter((item) => item.type === 'text')) {
      assert.doesNotMatch(block.text, /<tool_call>|<arg_key>/)
    }

    // usage 保留了上游数值
    assert.deepEqual(assembler.usage, { inputTokens: 100, outputTokens: 20 })
  })

  it('正常回答（无工具调用）保持 stop 与正文原样', async () => {
    const { ctx, calls } = fakeCtx({ streamImpl: () => stubStream(xunfeiStyleChunks('北京今天多云。')) })
    apply(ctx, { logEnabled: false })
    const { adapter } = registeredAdapter(calls)

    const chunks = await collect(adapter.stream({
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))

    const assembler = new MiniAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    assert.equal(assembler.finish.kind, 'stop')
    const blocks = assembler.blocks()
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, '北京今天多云。')
  })

  it('下游本来就是 tool-calls 时透传，合成 id 不覆盖上游 id', async () => {
    const nativeChunks = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_native_abc', name: 'get_weather', argumentsDelta: '{"city":"Beijing"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_native_abc', name: 'get_weather', arguments: '{"city":"Beijing"}' } },
      { type: 'usage', usage: { inputTokens: 9, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const { ctx, calls } = fakeCtx({ streamImpl: () => stubStream(nativeChunks) })
    apply(ctx, { logEnabled: false })
    const { adapter } = registeredAdapter(calls)

    const chunks = await collect(adapter.stream({
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))

    assert.deepEqual(chunks, nativeChunks, '必须逐 chunk 原样透传')
    const ids = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block.id)
    assert.deepEqual(ids, ['call_native_abc'])
  })

  it('正文里引用标签但未构成调用时，正文完整保留（不静默丢字）', async () => {
    const prose = '这个标签 <tool_call> 用来表示工具调用，但下面没有真正的调用。'
    const { ctx, calls } = fakeCtx({ streamImpl: () => stubStream(xunfeiStyleChunks(prose)) })
    apply(ctx, { logEnabled: false })
    const { adapter } = registeredAdapter(calls)

    const chunks = await collect(adapter.stream({
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '解释一下格式' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))

    const assembler = new MiniAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    assert.equal(assembler.finish.kind, 'stop', '未构成调用时不得改写')
    const text = assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('')
    assert.equal(text, prose, '正文必须一字不丢')
  })

  it('parseTextToolCalls:false 时退化为纯转发', async () => {
    const { ctx, calls } = fakeCtx({ streamImpl: () => stubStream(xunfeiStyleChunks(XUNFEI_TEXT_CALL)) })
    apply(ctx, { logEnabled: false, parseTextToolCalls: false })
    const { adapter } = registeredAdapter(calls)

    const chunks = await collect(adapter.stream({
      provider: 'xunfei-compatible',
      model: 'spark-x2.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: '天气？' }] }],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    }))

    assert.equal(chunks.find((chunk) => chunk.type === 'finish').reason.kind, 'stop', '关闭解析后不应改写')
    assert.equal(chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').length, 0)
  })
})

describe('包装 adapter：目录与元数据转发', () => {
  it('listModels 把 provider 换成自己的 route', async () => {
    const { ctx, calls } = fakeCtx()
    apply(ctx, { logEnabled: false })
    const { adapter } = registeredAdapter(calls)

    const models = await adapter.listModels('xunfei-compatible')
    assert.deepEqual(calls.listModels, ['xunfei'], '必须向下游 route 取目录')
    assert.equal(models.length, 1)
    assert.equal(models[0].provider, 'xunfei-compatible', 'provider 必须改写为本 route')
    assert.equal(models[0].id, 'spark-x2.6')
  })

  it('resolveModel 转发元数据并改写 provider', async () => {
    const { ctx, calls } = fakeCtx()
    apply(ctx, { logEnabled: false })
    const { adapter } = registeredAdapter(calls)

    const info = await adapter.resolveModel('xunfei-compatible', 'spark-x2.6')
    assert.deepEqual(calls.resolveModelInfo.map((entry) => entry.provider), ['xunfei'])
    assert.equal(info.provider, 'xunfei-compatible')
    assert.equal(info.id, 'spark-x2.6')
    assert.deepEqual(info.context, { contextWindow: 128000 })
  })

  it('providerInfo 保留 route id 并使用配置的显示名', () => {
    const { ctx, calls } = fakeCtx()
    apply(ctx, { logEnabled: false, displayName: '讯飞 compat' })
    const { adapter } = registeredAdapter(calls)

    const info = adapter.providerInfo('xunfei-compatible')
    assert.deepEqual(info, { id: 'xunfei-compatible', name: '讯飞 compat' })
  })

  it('providerRetryPolicy 沿用下游 route 的策略', () => {
    const { ctx, calls } = fakeCtx()
    apply(ctx, { logEnabled: false })
    const { adapter } = registeredAdapter(calls)

    const policy = adapter.providerRetryPolicy('xunfei-compatible')
    assert.deepEqual(calls.providerRetryPolicy, ['xunfei'])
    assert.deepEqual(policy, { mode: 'normal', maxRetries: 5 })
  })

  it('下游没有重试策略时降级为 undefined 而不是抛错', () => {
    const { ctx } = fakeCtx({
      providerRetryPolicy: undefined,
    })
    // 让替身在取策略时抛错，模拟下游尚未注册的竞态
    ctx.llm.providerRetryPolicy = () => { throw new Error('NO_ADAPTER') }
    apply(ctx, { logEnabled: false })

    // 重新取注册后的 adapter 需要重新 apply；这里直接构造一次
    const calls2 = { registerAdapter: [] }
    const ctx2 = { ...ctx, llm: { ...ctx.llm, registerAdapter: (routes, adapter) => { calls2.registerAdapter.push({ routes, adapter }); return () => {} } } }
    apply(ctx2, { logEnabled: false })
    const adapter = calls2.registerAdapter[0].adapter
    assert.equal(adapter.providerRetryPolicy('xunfei-compatible'), undefined)
  })
})