/**
 * StreamChunk 缓冲与改写：把「文本化的工具调用」救成标准的 tool-calls 流。
 *
 * 在 `ctx.llm.stream()` 的 chunk 层工作，不碰 HTTP、不碰 pi-ai 事件，
 * 所以对下游路由完全无侵入。
 *
 * ## 为什么必须缓冲到 finish
 *
 * 讯飞的症状是：正文里出现 `<tool_call>…</tool_call>` 且 `finish_reason=stop`。
 * 只有看到终态 finish 才能确定「这不是真 tool_calls」，因此判定必然在最后。
 *
 * ## 流式保留策略（借鉴 vLLM / sglang 的成熟做法）
 *
 * 朴素实现会整轮缓冲，代价是**每次带工具的普通聊天都失去流式输出**。
 * 实测（`test/streaming-probe.mjs`）：562ms 生成的文本在同一刻吐出。
 * 为修一个偶发缺陷而牺牲每一次对话，不可接受。
 *
 * 因此采用「流式 + 尾部 holdback」：
 *   - 正文逐 delta 透传，只在尾部保留 `MAX_MARKER_LEN - 1` 个字符；
 *   - 这段尾巴足够拼出最长标记的任意前缀，所以跨 delta 的标记不会被切断
 *     （等价于 sglang 的 `ends_with_partial_token`）；
 *   - 一旦在已透传的正文里发现标记，就切到缓冲，等 finish 再判定。
 *
 * ## 绝不静默丢正文（vLLM #63309 的教训）
 *
 * 模型可能在正文里**引用**这个标签（例如解释格式）。若因此就扣住后续正文
 * 不再吐出，用户会看到回复被截断，而非流式路径却是完整的。
 * 本实现保证：只要最终没有转换成工具调用，**所有被扣住的正文都会原样补吐**，
 * 一个字都不丢。见 `flushHeldTail()` 及针对该场景的回归测试。
 *
 * ## 为什么不违反可追溯性
 *
 * 会话日志记录的是**发出的 chunks**，而不是上游原文。改写后日志里就是一条
 * 正常的带 tool-call 的 assistant 消息，`BlockAssembler` 能由它重建出工具调用
 * （已用 DSH 官方 assembler 交叉验证，见 `test-real-assembler-result.txt`）。
 * 被转换掉的标签文本从未进入日志，因此「model-visible ⟺ logged」成立。
 * 反过来，若把标签文本也留在日志里再追加 tool-call 块，模型下一轮会看到自己
 * 「说过话又调了工具」，那才是脏状态。
 *
 * @module xunfei-compatible-adapter/stream
 */

import { buildSegments, isConvertible, parseTextToolCalls } from './parse-text-tool-calls.js'

/** 合成 tool call id 的前缀，便于在日志里一眼认出是适配器合成的。 */
const SYNTHETIC_ID_PREFIX = 'xfcall_'

/**
 * 会被识别为「文本化工具调用」的标记（小写比较，因此大小写混写也能命中）。
 *
 * `<arg_key>` 是必须的：实测讯飞偶尔省掉开头的 `<tool_call>`，只吐
 * `<pwsh<arg_key>command</arg_key><arg_value>…`。这种残缺形态不含前两个标记，
 * 若不以 `<arg_key>` 触发就永远进不了缓冲，会被当成普通正文透传出去。
 */
const MARKERS = ['<tool_call>', 'tool_call:', '<arg_key>']

/** 最长标记长度；流式模式下必须保留这么多字符的尾巴，避免标记被切断。 */
const MAX_MARKER_LEN = MARKERS.reduce((max, marker) => Math.max(max, marker.length), 0)

/**
 * 流式模式下额外保留的字符数上限。
 *
 * 仅按 `MAX_MARKER_LEN - 1` 保留不够：残缺形态是 `工具名<arg_key>`，
 * 检测到 `<arg_key>` 时工具名（以及前面那个截断的 `<`）可能已被当作正文吐出。
 * 但无脑加大 holdback 会让普通正文也被积压（实测 37 字回答整段延迟）。
 *
 * 折中：只在尾巴里出现 `<`（标记或残缺工具名的前哨）时才扩大保留窗口，
 * 纯正文（不含 `<`）仍按最小保留，流式不受影响。
 */
const HOLD_EXTRA = 33

/** 标记的最短保留长度（含标记本身）。 */
const HOLD_CHARS_MIN = MAX_MARKER_LEN - 1

/**
 * 生成一个合成的 tool call id。
 *
 * 只需在**单次响应内**唯一：`ToolCallId` 只要与匹配的 tool result 相关，
 * 跨轮不冲突。用递增序号拼时间戳，避免 `Math.random` 的不可复现性。
 *
 * @param {number} ordinal - 本次响应内的调用序号。
 * @returns {string} 合成 id。
 */
export function syntheticToolCallId(ordinal) {
  return `${SYNTHETIC_ID_PREFIX}${Date.now().toString(36)}_${ordinal}`
}

/**
 * 在已转小写的文本里找最早出现的标记位置。
 * @param {string} lowerText - 已转小写的文本。
 * @returns {number} 最早标记的起始下标，没有则 -1。
 */
function findMarkerIndex(lowerText) {
  let best = -1
  for (const marker of MARKERS) {
    const index = lowerText.indexOf(marker)
    if (index !== -1 && (best === -1 || index < best)) best = index
  }
  return best
}

/**
 * 对一条上游 chunk 流做「文本化工具调用」救火改写。
 *
 * @param {AsyncIterable<object>} upstream - 下游 adapter 的 chunk 流。
 * @param {{
 *   toolNames: readonly string[] | undefined,
 *   convert?: boolean,
 *   log?: (event: object) => void,
 * }} options - `toolNames` 是本次请求声明的工具名，即转换白名单；
 *   `convert` 为 false 时只透传不解析（默认 true）；
 *   `log` 记录诊断事件。
 * @returns {AsyncIterable<object>} 可能被改写的 chunk 流。
 */
export async function* rewriteTextToolCalls(upstream, options) {
  const toolNames = options?.toolNames
  const log = options?.log ?? (() => {})

  // 没声明任何工具就没有合法的转换目标；也不存在可解析的白名单，
  // 直接透传，不引入任何额外延迟。
  if (options?.convert === false || !Array.isArray(toolNames) || toolNames.length === 0) {
    yield* upstream
    return
  }

  /** 本轮待吐出给消费者的 chunks。 */
  const out = []

  /** 正文块的上游 index（取上游第一个 text 块）。 */
  let textIndex
  /** 上游的 text block-start，延迟到真正有正文时才吐（避免转换后留下空块）。 */
  let deferredTextStart
  /** 正文块是否已开启。 */
  let textStarted = false
  /** 已经作为 text-delta 向外吐出的正文。 */
  let flushedText = ''
  /** 尚未决定去留的正文（标记之后的区域）。 */
  let heldText = ''
  /** 是否已发现标记、转入缓冲。 */
  let buffering = false
  /** 上游是否给出过真实 tool-call；出现即放弃改写、全程透传。 */
  let nativeToolCall = false
  /** 上游的 usage chunk，延迟到 finish 之前再吐（协议要求 usage 在 finish 之前）。 */
  let usageChunk
  /** 见过的最大 block index，用于给新块分配不冲突的 index。 */
  let maxIndex = -1

  /** 确保正文块已开启。 */
  function ensureTextStarted() {
    if (textStarted) return
    if (textIndex === undefined) textIndex = 0
    out.push(deferredTextStart ?? { type: 'block-start', index: textIndex, blockType: 'text' })
    textStarted = true
  }

  /**
   * 吐出一段正文。
   * @param {string} value - 非空正文。
   */
  function emitProse(value) {
    if (value.length === 0) return
    ensureTextStarted()
    out.push({ type: 'text-delta', index: textIndex, text: value })
    flushedText += value
  }

  /** 关闭正文块（内容用“实际吐出的正文”，而非上游携带的完整原文）。 */
  function closeTextBlock() {
    if (!textStarted) return
    out.push({ type: 'block-end', index: textIndex, block: { type: 'text', text: flushedText } })
    textStarted = false
  }

  /** 把仍被扣住的正文补吐出来——保证一个字都不丢（vLLM #63309 的教训）。 */
  function flushHeldTail() {
    if (heldText.length === 0) return
    const pending = heldText
    heldText = ''
    emitProse(pending)
  }

  for await (const chunk of upstream) {
    if (typeof chunk?.index === 'number' && chunk.index > maxIndex) maxIndex = chunk.index

    if (nativeToolCall) {
      // 已确认上游自带真工具调用：其余内容原样转发
      out.push(chunk)
    } else if (chunk.type === 'tool-call-delta'
      || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
      || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) {
      // 上游自己给了真工具调用：收尾正文，之后一律透传
      nativeToolCall = true
      flushHeldTail()
      closeTextBlock()
      out.push(chunk)
      log({ event: 'passthrough-native-tool-calls' })
    } else {
      switch (chunk.type) {
        case 'block-start': {
          if (chunk.blockType === 'text') {
            if (textIndex === undefined) textIndex = chunk.index
            if (deferredTextStart === undefined) deferredTextStart = chunk
          } else {
            out.push(chunk)
          }
          break
        }

        case 'text-delta': {
          if (textIndex === undefined) textIndex = chunk.index
          heldText += chunk.text

          if (!buffering) {
            const markerAt = findMarkerIndex(heldText.toLowerCase())
            if (markerAt !== -1) {
              // 标记前是真实正文，先吐掉；标记起的内容转入缓冲。
              // 例外：`<arg_key>` 是残缺形态的参数起点，紧邻其前的工具名
              //（可能还带一个截断的 `<`）也必须一起缓冲，否则解析器拿不到工具名。
              let cut = markerAt
              if (heldText.slice(markerAt, markerAt + 9).toLowerCase() === '<arg_key>') {
                const before = heldText.slice(0, markerAt)
                // 回退到最近的非工具名字符之后（工具名只含字母数字与 _ - .）
                const trailing = before.match(/[A-Za-z0-9_.\-]*$/) ?? ['']
                cut = markerAt - trailing[0].length
                // 再吞掉工具名前的那个截断 `<`（若是）
                if (cut > 0 && heldText[cut - 1] === '<') cut -= 1
              }
              emitProse(heldText.slice(0, cut))
              heldText = heldText.slice(cut)
              buffering = true
              log({ event: 'marker-detected', proseChars: flushedText.length })
            } else {
              // 保留策略：尾巴里含 `<` 时扩大窗口（可能是标记或残缺工具名的前哨），
              // 否则只按最小标记长度保留，让普通正文尽早流动。
              const hold = heldText.includes('<')
                ? HOLD_CHARS_MIN + HOLD_EXTRA
                : HOLD_CHARS_MIN
              const safeEnd = heldText.length - hold
              if (safeEnd > 0) {
                emitProse(heldText.slice(0, safeEnd))
                heldText = heldText.slice(safeEnd)
              }
            }
          }
          break
        }

        case 'block-end': {
          // 正文块的关闭由本插件自己发：上游那份携带的是含标签的完整原文
          if (chunk.block?.type !== 'text') out.push(chunk)
          break
        }

        case 'usage': {
          // 延后到 finish 之前才吐，保持协议顺序
          usageChunk = chunk
          break
        }

        case 'finish': {
          const isStop = chunk.reason?.kind === 'stop'
          let converted = false

          if (isStop && heldText.length > 0) {
            const parsed = parseTextToolCalls(heldText, toolNames)
            if (isConvertible(parsed, toolNames)) {
              converted = true
              closeTextBlock()

              let next = maxIndex + 1
              for (const segment of buildSegments(heldText, parsed)) {
                if (segment.kind === 'text') {
                  out.push({ type: 'block-start', index: next, blockType: 'text' })
                  out.push({ type: 'text-delta', index: next, text: segment.text })
                  out.push({ type: 'block-end', index: next, block: { type: 'text', text: segment.text } })
                } else {
                  const id = syntheticToolCallId(next)
                  out.push({ type: 'block-start', index: next, blockType: 'tool-call' })
                  out.push({
                    type: 'tool-call-delta',
                    index: next,
                    id,
                    name: segment.call.name,
                    argumentsDelta: segment.call.arguments,
                  })
                  out.push({
                    type: 'block-end',
                    index: next,
                    block: {
                      type: 'tool-call',
                      id,
                      name: segment.call.name,
                      // 协议要求：工具参数保持 raw JSON 字符串，不解析成对象
                      arguments: segment.call.arguments,
                    },
                  })
                }
                next += 1
              }

              if (usageChunk !== undefined) out.push(usageChunk)
              // 上游 replayState 描述的是「那段文本」的响应；改写后块结构已变，
              // 保留它会让组装器对不上，因此改写路径不携带 replayState。
              out.push({ type: 'finish', reason: { kind: 'tool-calls' } })

              log({
                event: 'converted',
                toolNames: parsed.calls.map((call) => call.name),
                calls: parsed.calls.length,
                proseChars: flushedText.length,
              })
            } else if (parsed.issues.length > 0) {
              log({ event: 'parse-rejected', issues: parsed.issues, heldChars: heldText.length })
            }
          }

          if (!converted) {
            // 未转换：原样补吐被扣住的正文，再按上游 finish 收尾
            flushHeldTail()
            closeTextBlock()
            if (usageChunk !== undefined) out.push(usageChunk)
            out.push(chunk)
          }
          break
        }

        default: {
          out.push(chunk)
          break
        }
      }
    }

    if (out.length > 0) {
      for (const pending of out) yield pending
      out.length = 0
    }
  }
}