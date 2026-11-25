/**
 * 讯飞 spark-x2.6 文本化工具链解析器（纯函数，无依赖，可单测）。
 *
 * 移植自已验证的本地代理 `xunfei-probe/xunfei-adapter.cjs` 的
 * `parseTextToolCalls()`，只做了三件事：
 *   1. 补上 `TOOL_CALL: {...}` 回退（原代理只有 `<tool_call>` 解析）；
 *   2. 返回每次命中的位置区间，供上层按原顺序切片（保留正文与调用的相对顺序）；
 *   3. 增加工具名白名单判定——名字不在白名单里就整体放弃转换、原样透传。
 *
 * 设计底线：解析失败一律返回「转换不了」，绝不抛异常。宁可把模型的文字原样
 * 交给上层（用户看到一段奇怪的文本），也不能因为解析器抛错把整个会话搞死。
 */

/** `<tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value>...</tool_call>` */
const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g

/** 数组配对：`<arg_key>` 与 `<arg_value>` 之间允许空白 */
const ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g

/** `TOOL_CALL: {...}` / `TOOL_CALL:{...}` 回退（大小写不敏感，允许前面有缩进） */
const TOOL_CALL_LINE_RE = /(?:^|\n)[ \t]*TOOL_CALL:[ \t]*(\{[\s\S]*?\})[ \t]*(?=\n|$)/g

/**
 * 转义正则元字符，用于把一个字面量安全地拼进正则。
 * @param {string} value - 字面量。
 * @returns {string} 转义后的字面量。
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把 `<arg_value>` 里的原始字符串还原成它代表的 JSON 值。
 *
 * 顺序与参考实现一致：布尔 → 数字 → JSON。都失败就保留原始字符串，
 * 这样 `Beijing` 这类裸字符串不会变成语法错误。
 * @param {string} raw - 已 trim 的原始值文本。
 * @returns {unknown} 还原后的值。
 */
function coerceValue(raw) {
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * 解析单条 `<tool_call>` 的 body（标签内部内容）。
 * @param {string} body - `<tool_call>` 与 `</tool_call>` 之间的文本。
 * @returns {{name: string, args: Record<string, unknown>} | undefined} 解析不出名字时返回 undefined。
 */
function parseToolCallBody(body) {
  const nameMatch = body.match(/^\s*([^\s<]+)/)
  if (!nameMatch) return undefined

  let name = nameMatch[1]
  const args = {}

  let found = 0
  const argRe = new RegExp(ARG_RE.source, 'g')
  let match
  while ((match = argRe.exec(body)) !== null) {
    found += 1
    args[match[1].trim()] = coerceValue(match[2].trim())
  }

  if (found === 0) {
    // 回退 1：<tool_call>{"name":"x","arguments":{...}}</tool_call>
    // 回退 2：<tool_call>x</tool_call> 或 <tool_call>x {"a":1}</tool_call>，取 body 里第一个 JSON 对象
    try {
      const asJson = JSON.parse(body.trim())
      if (asJson && typeof asJson === 'object' && typeof asJson.name === 'string') {
        name = asJson.name
        if (asJson.arguments && typeof asJson.arguments === 'object') Object.assign(args, asJson.arguments)
      }
    } catch {
      const jsonMatch = body.match(/(\{[\s\S]*\})/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1])
          if (parsed && typeof parsed === 'object') Object.assign(args, parsed)
        } catch {
          // 参数解析不出来就留空对象，由上层决定是否接受这条调用
        }
      }
    }
  }

  return { name, args }
}

/**
 * 解析一段模型文本里出现的全部文本化工具调用。
 *
 * 返回的 `spans` 是原文中的位置区间，`consumed` 表示这些区间合起来是否覆盖
 * 了整段文本（忽略空白）。上层用 `spans` 切片就能保住「正文 → 调用 → 正文」
 * 的原始顺序。`issues` 记录被跳过的原因，便于日志与自测断言。
 *
 * @param {string} text - 模型的正文输出。
 * @param {readonly string[]} [toolNames] - 当前请求声明的工具名白名单；省略表示不校验。
 * @returns {{
 *   calls: Array<{name: string, arguments: string}>,
 *   spans: Array<{start: number, end: number, callIndex: number}>,
 *   issues: string[],
 * }} 解析结果；`calls` 为空即表示「转换不了」。
 */
export function parseTextToolCalls(text, toolNames) {
  const calls = []
  const spans = []
  const issues = []
  if (typeof text !== 'string' || text.length === 0) return { calls, spans, issues }

  const allowed = Array.isArray(toolNames) && toolNames.length > 0 ? new Set(toolNames) : undefined

  const re = new RegExp(TOOL_CALL_RE.source, 'g')
  let match
  while ((match = re.exec(text)) !== null) {
    const parsed = parseToolCallBody(match[1])
    if (parsed === undefined) {
      issues.push('empty-tool-call-body')
      continue
    }
    if (allowed !== undefined && !allowed.has(parsed.name)) {
      // 名字不在本次请求声明的工具里：很可能是模型在复述/举例而不是真要调用。
      // 这类一律不转换，避免执行模型并未意图调用的工具。
      issues.push(`unknown-tool:${parsed.name}`)
      continue
    }
    calls.push({ name: parsed.name, arguments: JSON.stringify(parsed.args) })
    spans.push({ start: match.index, end: match.index + match[0].length, callIndex: calls.length - 1 })
  }

  if (calls.length === 0) {
    // 回退 A：`TOOL_CALL: {"name":"x","arguments":{...}}`，或（仅当本次只声明了一个工具时）
    // `TOOL_CALL: {"city":"Beijing"}` 由唯一工具承接。
    const lineRe = new RegExp(TOOL_CALL_LINE_RE.source, 'g')
    let lineMatch
    let lineAttempts = 0
    while ((lineMatch = lineRe.exec(text)) !== null) {
      lineAttempts += 1
      let parsed
      try {
        parsed = JSON.parse(lineMatch[1])
      } catch {
        issues.push('tool-call-line-not-json')
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        issues.push('tool-call-line-not-object')
        continue
      }

      let name
      let args
      if (typeof parsed.name === 'string' && parsed.name.length > 0) {
        name = parsed.name
        args = parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
          ? parsed.arguments
          : {}
      } else if (allowed !== undefined && allowed.size === 1) {
        // 名字没给，但只有唯一候选工具：参数就是整段对象。
        name = [...allowed][0]
        args = parsed
      } else {
        // 名字没给、候选工具不止一个：无法安全猜测是哪一个，放弃。
        issues.push('tool-call-line-ambiguous-name')
        continue
      }

      if (allowed !== undefined && !allowed.has(name)) {
        issues.push(`unknown-tool:${name}`)
        continue
      }
      // start 收窄到 `TOOL_CALL:` 前缀，把换行留给正文
      const spanStart = text.indexOf('TOOL_CALL:', lineMatch.index) === -1
        ? lineMatch.index
        : text.indexOf('TOOL_CALL:', lineMatch.index)
      calls.push({ name, arguments: JSON.stringify(args) })
      spans.push({ start: spanStart, end: lineMatch.index + lineMatch[0].length, callIndex: calls.length - 1 })
    }

    if (lineAttempts === 0 && /(?:^|\n)[ \t]*TOOL_CALL:/i.test(text)) {
      // 出现了 `TOOL_CALL:` 前缀，但后面不是可解析的 JSON 对象（例如纯文字）。
      // 这不构成转换，但值得记进日志：说明模型确实在按「文本工具协议」回话。
      issues.push('tool-call-line-not-json')
    }
  }

  if (calls.length === 0 && allowed !== undefined) {
    // 回退 B：**残缺标签**。实测观察到讯飞偶尔省掉开头的 `<tool_call>`，
    // 直接吐 `工具名<arg_key>K</arg_key><arg_value>V</arg_value>…`：
    //   <pwsh<arg_key>command</arg_key><arg_value>Get-ChildItem …</arg_value></tool_call>
    // 这里只在该「工具名」确实出现在本次请求声明的工具列表里时才接受，
    // 因此正常正文（哪怕提到工具名）不会被误判——还必须紧跟 `<arg_key>`。
    // 边界：工具名前面必须是行首、空白或 `<`/`>`（实测残缺形态是 `<pwsh<arg_key>`，
    // 前面那个 `<` 是被截断的 `<tool_call>`，必须允许）。
    const bare = new RegExp(
      `(?:^|[\\s<>])(${[...allowed].map(escapeRegExp).join('|')})<arg_key>([\\s\\S]*?)<\\/arg_key>\\s*<arg_value>([\\s\\S]*?)<\\/arg_value>`,
      'g',
    )
    let bareMatch
    while ((bareMatch = bare.exec(text)) !== null) {
      const name = bareMatch[1]
      const rest = text.slice(bareMatch.index)
      // 从该处起收集连续的 arg_key/arg_value 对，直到不再匹配
      const args = {}
      const pairRe = new RegExp(ARG_RE.source, 'g')
      let pair
      let consumedEnd = bareMatch.index
      while ((pair = pairRe.exec(rest)) !== null) {
        args[pair[1].trim()] = coerceValue(pair[2].trim())
        consumedEnd = bareMatch.index + pairRe.lastIndex
        // 只接受紧邻的连续参数对：中间若夹了其他文本就停
        const gap = rest.slice(pairRe.lastIndex, pairRe.lastIndex + 200)
        if (!/^\s*<arg_key>/.test(gap)) break
      }
      // 吞掉紧跟在参数后面的残尾闭合标签（如 `</tool_call>`），
      // 否则它会作为孤立文本残留在正文里。只在紧邻时吞，不做跨文本搜索。
      const tailMatch = text.slice(consumedEnd).match(/^\s*<\/tool_call>/i)
      if (tailMatch !== null) consumedEnd += tailMatch[0].length
      calls.push({ name, arguments: JSON.stringify(args) })
      spans.push({
        start: bareMatch.index + (bareMatch[0].length - bareMatch[0].trimStart().length),
        end: consumedEnd,
        callIndex: calls.length - 1,
      })
      bare.lastIndex = consumedEnd
    }
    if (calls.length > 0) issues.push('bare-tool-call-recovered')
  }

  // 位置排序：两种格式混用时保持原文顺序（正常不会出现，防御性处理）
  if (spans.length > 1) {
    spans.sort((a, b) => a.start - b.start)
    spans.forEach((span, order) => { span.callIndex = order })
    const reordered = spans.map(span => calls[span.callIndex])
    calls.length = 0
    calls.push(...reordered)
    spans.forEach((span, order) => { span.callIndex = order })
  }

  return { calls, spans, issues }
}

/**
 * 判断一次解析结果是否值得改写成标准 tool-calls 流。
 *
 * 只有全部条件成立才转换：
 *   - 至少解析出一条调用；
 *   - 每条调用的工具名都在本次请求声明的工具里（白名单由调用方传入）；
 *   - 参数是合法 JSON 对象字符串（`JSON.stringify` 产物天然满足）。
 * 任一不成立就返回 false，上层原样透传。
 *
 * @param {{calls: Array<{name: string, arguments: string}>, issues: string[]}} parsed - 解析结果。
 * @param {readonly string[] | undefined} toolNames - 本次请求声明的工具名。
 * @returns {boolean} 是否应改写为 tool-calls。
 */
export function isConvertible(parsed, toolNames) {
  if (!parsed || !Array.isArray(parsed.calls) || parsed.calls.length === 0) return false
  if (!Array.isArray(toolNames) || toolNames.length === 0) return false
  const allowed = new Set(toolNames)
  return parsed.calls.every((call) => {
    if (typeof call.name !== 'string' || call.name.length === 0) return false
    if (!allowed.has(call.name)) return false
    if (typeof call.arguments !== 'string' || call.arguments.length === 0) return false
    try {
      const value = JSON.parse(call.arguments)
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    } catch {
      return false
    }
  })
}

/**
 * 按解析出的位置区间，把原文切成「正文 / 调用 / 正文 …」的有序片段。
 *
 * 调用片段夹在两段正文之间时顺序保持不变，所以改写后的流能像模型原本写的那样
 * 先说话、再调工具、再说话。空白正文片段会被丢掉，不产生空文本块。
 *
 * @param {string} text - 原始文本。
 * @param {ReturnType<typeof parseTextToolCalls>} parsed - 同一段文本的解析结果。
 * @returns {Array<{kind: 'text', text: string} | {kind: 'call', call: {name: string, arguments: string}}>}
 *   有序片段列表。
 */
export function buildSegments(text, parsed) {
  const segments = []
  let cursor = 0
  for (const span of parsed.spans) {
    if (span.start > cursor) {
      const before = text.slice(cursor, span.start)
      if (before.trim().length > 0) segments.push({ kind: 'text', text: before })
    }
    const call = parsed.calls[span.callIndex]
    if (call !== undefined) segments.push({ kind: 'call', call })
    cursor = span.end
  }
  if (cursor < text.length) {
    const after = text.slice(cursor)
    if (after.trim().length > 0) segments.push({ kind: 'text', text: after })
  }
  return segments
}