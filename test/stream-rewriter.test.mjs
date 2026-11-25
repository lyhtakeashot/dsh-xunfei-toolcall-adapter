/**
 * 自测：解析器 + 流改写器。零依赖，用 `node:test`。
 *
 * 运行（本环境不能用 `node --test`，它会 spawn 子进程而沙箱拦截 EPERM）：
 *   node test/stream-rewriter.test.mjs
 *
 * 覆盖：
 *   - N1–N5 五种上游形状（空 tools / 缺失 tools / 无历史 / system-only / 真 tool_calls）
 *   - 正常透传（下游本来就是 tool-calls、普通回答、无工具声明）
 *   - 多个 `<tool_call>`
 *   - 畸形文本（未闭合、未知工具、非法 JSON）
 *   - 非 stream 终态（error / max-tokens / aborted）
 *   - finish kind、工具名/参数、无文本泄漏、usage 在 finish 之前
 *   - **流式保留**：普通回答必须逐 delta 透传，不得整轮积压
 *   - **绝不丢正文**：标记出现在正文里但未转换时，后续正文必须一字不丢（vLLM #63309）
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildSegments, isConvertible, parseTextToolCalls } from '../lib/parse-text-tool-calls.js'
import { rewriteTextToolCalls, syntheticToolCallId } from '../lib/stream-rewriter.js'

/** N1/N2/N3 实测原文（讯飞在 tools 为空或缺失时吐出的内容）。 */
const XUNFEI_TEXT_CALL = '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'

/** N4 实测原文（system 里要求 TOOL_CALL: JSON 时的输出）。 */
const XUNFEI_TOOL_CALL_LINE = 'TOOL_CALL: {"city": "Beijing"}'

/** 从 chunks 里取出所有 tool-call 终态块。 */
function toolCallBlocks(chunks) {
  return chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
    .map((chunk) => chunk.block)
}

/** 从 chunks 里取出所有终态 text 块。 */
function textBlocks(chunks) {
  return chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
    .map((chunk) => chunk.block)
}

/** 把 chunks 里所有 text-delta 依次拼起来。 */
function joinedText(chunks) {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
}

/** 从 chunks 里取出 finish chunk。 */
function finishOf(chunks) {
  return chunks.find((chunk) => chunk.type === 'finish')
}

/**
 * 语义等价比较：delta 的切分粒度可以不同（协议允许任意粒度，
 * `BlockAssembler` 按 index 累加），因此要比较「组装后的结果」而非原始 chunk 序列。
 * @param {object[]} actual - 实际流出的 chunks。
 * @param {object[]} expected - 上游原始 chunks。
 */
function assertSemanticallyEqual(actual, expected) {
  assert.equal(joinedText(actual), joinedText(expected), '正文内容必须一致')
  assert.deepEqual(
    actual.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
    expected.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
    '终态块必须一致',
  )
  const actualUsage = actual.find((chunk) => chunk.type === 'usage')
  const expectedUsage = expected.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(actualUsage, expectedUsage, 'usage 必须一致')
  assert.deepEqual(finishOf(actual), finishOf(expected), 'finish 必须一致')
}

/**
 * 把一段上游文本包装成 pi-ai 风格的 chunk 流：
 * block-start(text) → text-delta… → block-end(text) → usage → finish
 */
function upstreamTextStream(text, { finishKind = 'stop', usage = { inputTokens: 11, outputTokens: 7 }, reasoning, deltaSize = 1 } = {}) {
  const chunks = []
  if (reasoning !== undefined) {
    chunks.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
    chunks.push({ type: 'reasoning-delta', index: 0, text: reasoning })
    chunks.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
  }
  const textIndex = reasoning !== undefined ? 1 : 0
  if (text.length > 0) {
    chunks.push({ type: 'block-start', index: textIndex, blockType: 'text' })
    // 按 deltaSize 切分，模拟真实流式；检验标记跨多个 delta 时的拼接
    for (let i = 0; i < text.length; i += deltaSize) {
      chunks.push({ type: 'text-delta', index: textIndex, text: text.slice(i, i + deltaSize) })
    }
    chunks.push({ type: 'block-end', index: textIndex, block: { type: 'text', text } })
  }
  chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'finish', reason: { kind: finishKind } })
  return chunks
}

/** 把数组包装成异步可迭代对象。 */
async function* asStream(items) {
  for (const item of items) yield item
}

/** 收集异步可迭代对象全部内容。 */
async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

/** 跑一次改写。 */
async function runRewrite(chunks, toolNames) {
  const events = []
  const result = await collect(rewriteTextToolCalls(asStream(chunks), {
    toolNames,
    log: (event) => events.push(event),
  }))
  return { chunks: result, events }
}

describe('解析器：N1–N5 上游形状', () => {
  it('N1/N2/N3 的 <tool_call> 标签格式能解析成标准调用', () => {
    const parsed = parseTextToolCalls(XUNFEI_TEXT_CALL, ['get_weather'])
    assert.equal(parsed.calls.length, 1)
    assert.equal(parsed.calls[0].name, 'get_weather')
    assert.deepEqual(JSON.parse(parsed.calls[0].arguments), { city: 'Beijing' })
    assert.equal(parsed.issues.length, 0)
    assert.ok(isConvertible(parsed, ['get_weather']))
  })

  it('N4 的 TOOL_CALL: {...} 在唯一工具时由该工具承接', () => {
    const parsed = parseTextToolCalls(XUNFEI_TOOL_CALL_LINE, ['get_weather'])
    assert.equal(parsed.calls.length, 1)
    assert.equal(parsed.calls[0].name, 'get_weather')
    assert.deepEqual(JSON.parse(parsed.calls[0].arguments), { city: 'Beijing' })
    assert.ok(isConvertible(parsed, ['get_weather']))
  })

  it('N4 的 TOOL_CALL 行在多个工具时报歧义、不转换', () => {
    const parsed = parseTextToolCalls(XUNFEI_TOOL_CALL_LINE, ['get_weather', 'get_time'])
    assert.equal(parsed.calls.length, 0)
    assert.ok(parsed.issues.includes('tool-call-line-ambiguous-name'))
    assert.equal(isConvertible(parsed, ['get_weather', 'get_time']), false)
  })

  it('N5 的真实 tool_calls 由调用方透传，解析器不参与', () => {
    const parsed = parseTextToolCalls('', ['get_weather'])
    assert.equal(parsed.calls.length, 0)
    assert.equal(isConvertible(parsed, ['get_weather']), false)
  })
})

describe('解析器：多调用与值类型', () => {
  it('一条文本里的多个 <tool_call> 全部解析，且保持原文顺序', () => {
    const text = '先看看天气。'
      + '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'
      + '再查一下时间。'
      + '<tool_call>get_time<arg_key>zone</arg_key><arg_value>Asia/Shanghai</arg_value></tool_call>'
    const parsed = parseTextToolCalls(text, ['get_weather', 'get_time'])
    assert.equal(parsed.calls.length, 2)
    assert.deepEqual(parsed.calls.map((call) => call.name), ['get_weather', 'get_time'])
    assert.deepEqual(JSON.parse(parsed.calls[1].arguments), { zone: 'Asia/Shanghai' })
    assert.equal(parsed.spans.length, 2)
    assert.ok(parsed.spans[0].start < parsed.spans[1].start)
  })

  it('值里的布尔/数字/JSON/裸字符串各自还原正确', () => {
    const text = '<tool_call>configure'
      + '<arg_key>enabled</arg_key><arg_value>true</arg_value>'
      + '<arg_key>retries</arg_key><arg_value>3</arg_value>'
      + '<arg_key>ratio</arg_key><arg_value>0.5</arg_value>'
      + '<arg_key>tags</arg_key><arg_value>["a","b"]</arg_value>'
      + '<arg_key>nested</arg_key><arg_value>{"k":1}</arg_value>'
      + '<arg_key>label</arg_key><arg_value>plain text</arg_value>'
      + '</tool_call>'
    const parsed = parseTextToolCalls(text, ['configure'])
    assert.equal(parsed.calls.length, 1)
    assert.deepEqual(JSON.parse(parsed.calls[0].arguments), {
      enabled: true,
      retries: 3,
      ratio: 0.5,
      tags: ['a', 'b'],
      nested: { k: 1 },
      label: 'plain text',
    })
  })

  it('JSON 对象形式的 <tool_call> 回退可用', () => {
    const text = '<tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}</tool_call>'
    const parsed = parseTextToolCalls(text, ['get_weather'])
    assert.equal(parsed.calls.length, 1)
    assert.equal(parsed.calls[0].name, 'get_weather')
    assert.deepEqual(JSON.parse(parsed.calls[0].arguments), { city: 'Oslo' })
  })
})

describe('解析器：残缺标签回退（实测观察到的变体）', () => {
  it('缺开头的 <tool_call> 时，白名单工具名 + arg_key 仍能恢复', () => {
    const text = '<pwsh<arg_key>command</arg_key><arg_value>Get-ChildItem \'A题\\A题\' -Recurse -Depth 3</arg_value>'
      + '<arg_key>description</arg_key><arg_value>List A题/A题 directory tree</arg_value></tool_call>'
    const parsed = parseTextToolCalls(text, ['pwsh', 'read'])
    assert.equal(parsed.calls.length, 1)
    assert.equal(parsed.calls[0].name, 'pwsh')
    assert.deepEqual(JSON.parse(parsed.calls[0].arguments), {
      command: "Get-ChildItem 'A题\\A题' -Recurse -Depth 3",
      description: 'List A题/A题 directory tree',
    })
    assert.ok(parsed.issues.includes('bare-tool-call-recovered'))
    assert.ok(isConvertible(parsed, ['pwsh', 'read']))
  })

  it('残缺形态转换后不残留 </tool_call> 等孤立标签', () => {
    const text = '<pwsh<arg_key>command</arg_key><arg_value>ls</arg_value></tool_call>'
    const parsed = parseTextToolCalls(text, ['pwsh'])
    assert.equal(parsed.calls.length, 1)
    // span 应覆盖整段原文，不留尾巴
    assert.equal(parsed.spans[0].start, 0)
    assert.equal(parsed.spans[0].end, text.length)
    const segments = buildSegments(text, parsed)
    assert.deepEqual(segments.map((segment) => segment.kind), ['call'])
  })

  it('残缺形态在任意流式分片粒度下都能转换（含逐字符）', async () => {
    const text = '<pwsh<arg_key>command</arg_key><arg_value>ls</arg_value></tool_call>'
    for (const deltaSize of [1, 2, 3, 7, 20, 999]) {
      const upstream = upstreamTextStream(text, { deltaSize })
      const { chunks } = await runRewrite(upstream, ['pwsh'])
      assert.equal(
        finishOf(chunks).reason.kind,
        'tool-calls',
        `deltaSize=${deltaSize} 时应转换为 tool-calls`,
      )
      const calls = toolCallBlocks(chunks)
      assert.equal(calls.length, 1, `deltaSize=${deltaSize} 应产出 1 个调用`)
      assert.equal(calls[0].name, 'pwsh')
      assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' })
      // 不允许标签泄漏到正文
      assert.doesNotMatch(joinedText(chunks), /<arg_key>|<\/tool_call>/, `deltaSize=${deltaSize} 有泄漏`)
    }
  })

  it('工具名不在白名单时不恢复（防止误伤）', () => {
    const text = 'notatool<arg_key>a</arg_key><arg_value>1</arg_value>'
    const parsed = parseTextToolCalls(text, ['pwsh'])
    assert.equal(parsed.calls.length, 0)
    assert.equal(isConvertible(parsed, ['pwsh']), false)
  })

  it('提到工具名但没有 arg_key 时不恢复（正常正文不误判）', () => {
    const text = '我准备用 pwsh 跑一下这个命令，然后看看结果。'
    const parsed = parseTextToolCalls(text, ['pwsh'])
    assert.equal(parsed.calls.length, 0)
    assert.equal(isConvertible(parsed, ['pwsh']), false)
  })

  it('工具名前面没有边界字符时不误判（如 mypwsh）', () => {
    const text = 'mypwsh<arg_key>a</arg_key><arg_value>1</arg_value>'
    const parsed = parseTextToolCalls(text, ['pwsh'])
    assert.equal(parsed.calls.length, 0)
  })

  it('未传白名单时不启用残缺回退', () => {
    const text = 'pwsh<arg_key>command</arg_key><arg_value>ls</arg_value>'
    const parsed = parseTextToolCalls(text, undefined)
    assert.equal(parsed.calls.length, 0)
  })
})

describe('解析器：畸形输入一律不转换', () => {
  it('未闭合的 <tool_call> 不产生调用', () => {
    const parsed = parseTextToolCalls('<tool_call>get_weather<arg_key>city</arg_key>', ['get_weather'])
    assert.equal(parsed.calls.length, 0)
    assert.equal(isConvertible(parsed, ['get_weather']), false)
  })

  it('未知工具名不转换，并记录 issue', () => {
    const text = '<tool_call>rm_rf<arg_key>path</arg_key><arg_value>/</arg_value></tool_call>'
    const parsed = parseTextToolCalls(text, ['get_weather'])
    assert.equal(parsed.calls.length, 0)
    assert.ok(parsed.issues.some((issue) => issue.startsWith('unknown-tool:')))
    assert.equal(isConvertible(parsed, ['get_weather']), false)
  })

  it('空 body 不产生调用', () => {
    const parsed = parseTextToolCalls('<tool_call></tool_call>', ['get_weather'])
    assert.equal(parsed.calls.length, 0)
    assert.ok(parsed.issues.includes('empty-tool-call-body'))
  })

  it('非 JSON 的 TOOL_CALL 行被跳过', () => {
    const parsed = parseTextToolCalls('TOOL_CALL: not json at all', ['get_weather'])
    assert.equal(parsed.calls.length, 0)
    assert.ok(parsed.issues.includes('tool-call-line-not-json'))
  })

  it('普通正文永远不会被当成工具调用', () => {
    const parsed = parseTextToolCalls('北京今天多云，气温 18 度。', ['get_weather'])
    assert.equal(parsed.calls.length, 0)
    assert.equal(isConvertible(parsed, ['get_weather']), false)
  })

  it('没有声明任何工具时 isConvertible 恒为 false', () => {
    const parsed = parseTextToolCalls(XUNFEI_TEXT_CALL, [])
    assert.equal(isConvertible(parsed, []), false)
    assert.equal(isConvertible(parsed, undefined), false)
  })
})

describe('分段：正文与调用的原始顺序', () => {
  it('先正文、再调用、再正文的顺序被保住', () => {
    const text = '先看看天气。'
      + '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'
      + '以上。'
    const parsed = parseTextToolCalls(text, ['get_weather'])
    const segments = buildSegments(text, parsed)
    assert.deepEqual(segments.map((segment) => segment.kind), ['text', 'call', 'text'])
    assert.equal(segments[0].text, '先看看天气。')
    assert.equal(segments[2].text, '以上。')
  })

  it('只有调用时只产生一个 call 片段，不产生空正文块', () => {
    const parsed = parseTextToolCalls(XUNFEI_TEXT_CALL, ['get_weather'])
    const segments = buildSegments(XUNFEI_TEXT_CALL, parsed)
    assert.deepEqual(segments.map((segment) => segment.kind), ['call'])
  })
})

describe('改写器：空 tools 场景被转成标准 tool_calls', () => {
  it('终态 stop + <tool_call> 文本 → finish 变 tool-calls，正文不泄漏', async () => {
    const upstream = upstreamTextStream(XUNFEI_TEXT_CALL, { reasoning: '用户想知道北京天气。' })
    const { chunks, events } = await runRewrite(upstream, ['get_weather'])

    assert.equal(finishOf(chunks).reason.kind, 'tool-calls')

    const calls = toolCallBlocks(chunks)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'get_weather')
    assert.deepEqual(JSON.parse(calls[0].arguments), { city: 'Beijing' })
    assert.match(calls[0].id, /^xfcall_/)

    // 无文本泄漏：任何 text 块 / text-delta 都不得含标签
    for (const block of textBlocks(chunks)) {
      assert.doesNotMatch(block.text, /<tool_call>|<arg_key>|<arg_value>/)
    }
    assert.doesNotMatch(joinedText(chunks), /<tool_call>|<arg_key>|<arg_value>/)

    assert.ok(events.some((event) => event.event === 'converted'))
  })

  it('usage 在 finish 之前，且 finish 是最后一个 chunk', async () => {
    const upstream = upstreamTextStream(XUNFEI_TEXT_CALL)
    const { chunks } = await runRewrite(upstream, ['get_weather'])

    const usageIndex = chunks.findIndex((chunk) => chunk.type === 'usage')
    const finishIndex = chunks.findIndex((chunk) => chunk.type === 'finish')
    assert.ok(usageIndex >= 0, 'usage 必须存在')
    assert.ok(usageIndex < finishIndex, 'usage 必须在 finish 之前')
    assert.equal(finishIndex, chunks.length - 1, 'finish 必须是最后一个 chunk')
  })

  it('推理块被保留，且排在工具调用之前', async () => {
    const upstream = upstreamTextStream(XUNFEI_TEXT_CALL, { reasoning: '需要调用工具。' })
    const { chunks } = await runRewrite(upstream, ['get_weather'])

    const reasoningBlocks = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'reasoning')
    assert.equal(reasoningBlocks.length, 1)
    assert.equal(reasoningBlocks[0].block.text, '需要调用工具。')

    const reasoningEnd = chunks.findIndex((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'reasoning')
    const firstToolStart = chunks.findIndex((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    assert.ok(reasoningEnd < firstToolStart)
  })

  it('N4 的 TOOL_CALL: 行同样被转换', async () => {
    const upstream = upstreamTextStream(XUNFEI_TOOL_CALL_LINE)
    const { chunks } = await runRewrite(upstream, ['get_weather'])
    assert.equal(finishOf(chunks).reason.kind, 'tool-calls')
    const calls = toolCallBlocks(chunks)
    assert.equal(calls.length, 1)
    assert.deepEqual(JSON.parse(calls[0].arguments), { city: 'Beijing' })
  })

  it('标记被切成多个 delta 时仍能识别（跨 delta 拼接）', async () => {
    // deltaSize=3 会把 "<tool_call>" 切碎，验证 holdback 的尾巴足够长
    const upstream = upstreamTextStream(XUNFEI_TEXT_CALL, { deltaSize: 3 })
    const { chunks } = await runRewrite(upstream, ['get_weather'])
    assert.equal(finishOf(chunks).reason.kind, 'tool-calls')
    assert.equal(toolCallBlocks(chunks).length, 1)
  })

  it('标记前后都有正文时，转换后正文顺序保持不变', async () => {
    const text = '查一下。'
      + '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'
      + '马上回来。'
    const { chunks } = await runRewrite(upstreamTextStream(text), ['get_weather'])
    assert.equal(finishOf(chunks).reason.kind, 'tool-calls')

    const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    assert.deepEqual(blocks.map((block) => block.type), ['text', 'tool-call', 'text'])
    assert.equal(blocks[0].text, '查一下。')
    assert.equal(blocks[2].text, '马上回来。')
  })
})

describe('改写器：多 tool_call', () => {
  it('一条文本里的多个调用产出多个 tool-call 块，index 互不相同', async () => {
    const text = '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'
      + '<tool_call>get_time<arg_key>zone</arg_key><arg_value>Asia/Shanghai</arg_value></tool_call>'
    const upstream = upstreamTextStream(text)
    const { chunks } = await runRewrite(upstream, ['get_weather', 'get_time'])

    assert.equal(finishOf(chunks).reason.kind, 'tool-calls')
    const calls = toolCallBlocks(chunks)
    assert.deepEqual(calls.map((call) => call.name), ['get_weather', 'get_time'])

    assert.equal(new Set(calls.map((call) => call.id)).size, 2, 'call id 必须互不相同')

    const indexes = chunks
      .filter((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call')
      .map((chunk) => chunk.index)
    assert.equal(new Set(indexes).size, 2, 'block index 必须互不相同')
  })
})

describe('改写器：流式保留（不整轮积压）', () => {
  it('普通长回答在 finish 之前就开始吐出正文', async () => {
    const text = '北京今天多云转晴，最高气温 18 度，北风三到四级，出门建议带一件薄外套。'
    const upstream = upstreamTextStream(text, { deltaSize: 2 })

    const marks = []
    for await (const chunk of rewriteTextToolCalls(asStream(upstream), {
      toolNames: ['get_weather'],
      log: () => {},
    })) {
      marks.push(chunk)
      if (marks.length > 8) break
    }

    assert.ok(marks.length > 8, '应当能读到多个 chunk（而非被积压）')
    assert.ok(marks.some((chunk) => chunk.type === 'text-delta'), '前 8 个 chunk 内应已有正文增量')
    assert.equal(marks.filter((chunk) => chunk.type === 'finish').length, 0, '此时还不该出现 finish')
  })

  it('普通回答的完整正文与上游逐字一致（holdback 不吞字）', async () => {
    const text = '北京今天多云转晴，最高气温 18 度。'
    const { chunks } = await runRewrite(upstreamTextStream(text, { deltaSize: 2 }), ['get_weather'])
    assert.equal(joinedText(chunks), text)
    assert.equal(finishOf(chunks).reason.kind, 'stop')
  })

  it('正文以标记前缀结尾（如 "<tool"）但从未成标记时，内容一字不丢', async () => {
    const text = '这里的比较符号是 <tool'
    const { chunks } = await runRewrite(upstreamTextStream(text, { deltaSize: 2 }), ['get_weather'])
    assert.equal(joinedText(chunks), text)
    assert.equal(finishOf(chunks).reason.kind, 'stop')
  })
})

describe('改写器：绝不静默丢正文（vLLM #63309 教训）', () => {
  it('正文里引用 <tool_call> 标签但未构成调用时，后续正文必须完整吐出', async () => {
    // 模型在解释格式，标签后面还有实质内容，且没有配套的 </tool_call>
    const text = '这个标签 <tool_call> 用来表示工具调用，但下面没有真正的调用内容。'
    const { chunks, events } = await runRewrite(upstreamTextStream(text), ['get_weather'])

    assert.equal(finishOf(chunks).reason.kind, 'stop', '未构成调用时不得改写')
    assert.equal(joinedText(chunks), text, '正文必须一字不丢')
    assert.ok(events.some((event) => event.event === 'marker-detected'))
  })

  it('标签闭合但工具名未知时，原文完整保留', async () => {
    const text = '举例：<tool_call>unknown_tool<arg_key>a</arg_key><arg_value>1</arg_value></tool_call>结束。'
    const { chunks } = await runRewrite(upstreamTextStream(text), ['get_weather'])
    assert.equal(finishOf(chunks).reason.kind, 'stop')
    assert.equal(joinedText(chunks), text)
  })
})

describe('改写器：正常场景原样透传', () => {
  it('下游本来就是 tool-calls 时逐 chunk 原样透传', async () => {
    const upstream = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'native_1', name: 'get_weather', argumentsDelta: '{"city":"Beijing"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'native_1', name: 'get_weather', arguments: '{"city":"Beijing"}' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const { chunks } = await runRewrite(upstream, ['get_weather'])
    assert.deepEqual(chunks, upstream)
  })

  it('终态 stop 但正文是普通回答时原样透传', async () => {
    const upstream = upstreamTextStream('北京今天多云，18 度。')
    const { chunks } = await runRewrite(upstream, ['get_weather'])
    assertSemanticallyEqual(chunks, upstream)
    assert.equal(finishOf(chunks).reason.kind, 'stop')
  })

  it('没有声明工具时完全透传（不缓冲、不改写）', async () => {
    const upstream = upstreamTextStream(XUNFEI_TEXT_CALL)
    const { chunks, events } = await runRewrite(upstream, [])
    assert.deepEqual(chunks, upstream)
    assert.equal(events.length, 0)
  })

  it('解析失败时原样透传，不抛异常', async () => {
    const upstream = upstreamTextStream('模型瞎写：<tool_call>get_weather<arg_key>city</arg_key>')
    const { chunks } = await runRewrite(upstream, ['get_weather'])
    assert.equal(joinedText(chunks), '模型瞎写：<tool_call>get_weather<arg_key>city</arg_key>')
    assert.equal(finishOf(chunks).reason.kind, 'stop')
  })
})

describe('改写器：非 stop 终态不受影响', () => {
  for (const kind of ['error', 'max-tokens', 'aborted']) {
    it(`终态 ${kind} 时不改写、原样透传`, async () => {
      const upstream = upstreamTextStream(XUNFEI_TEXT_CALL, { finishKind: kind })
      const { chunks } = await runRewrite(upstream, ['get_weather'])
      assertSemanticallyEqual(chunks, upstream)
      assert.equal(finishOf(chunks).reason.kind, kind)
    })
  }
})

describe('改写器：构造合法性与边界', () => {
  it('syntheticToolCallId 的多次调用互不相同', () => {
    const ids = [0, 1, 2, 3].map((ordinal) => syntheticToolCallId(ordinal))
    assert.equal(new Set(ids).size, 4)
    for (const id of ids) assert.match(id, /^xfcall_/)
  })

  it('空流不会崩', async () => {
    const { chunks } = await runRewrite([], ['get_weather'])
    assert.deepEqual(chunks, [])
  })

  it('只有 finish 没有内容时原样透传', async () => {
    const upstream = [{ type: 'finish', reason: { kind: 'stop' } }]
    const { chunks } = await runRewrite(upstream, ['get_weather'])
    assert.deepEqual(chunks, upstream)
  })
})