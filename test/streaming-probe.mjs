import { rewriteTextToolCalls } from '../lib/stream-rewriter.js'

/**
 * 量化确认：整轮缓冲会让「普通文本回答」失去流式。
 * 记录每个 chunk 被 yield 出来的序号与到达时刻，看首个 text-delta 何时出现。
 */
const text = '北京今天多云转晴，最高气温 18 度，北风三到四级，出门建议带一件薄外套。'

function upstream() {
  return (async function* emit() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const ch of text) {
      // 模拟每字符 1ms 的流式
      await new Promise((resolve) => setTimeout(resolve, 1))
      yield { type: 'text-delta', index: 0, text: ch }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const start = Date.now()
const marks = []
for await (const chunk of rewriteTextToolCalls(upstream(), {
  toolNames: ['get_weather'],
  log: () => {},
})) {
  marks.push({ type: chunk.type, at: Date.now() - start })
}

const deltas = marks.filter((m) => m.type === 'text-delta')
const lastMark = marks[marks.length - 1]
console.log(`全文共 ${text.length} 字；首个 text-delta 出现在 +${deltas[0]?.at ?? 'n/a'}ms`)
console.log(`最后一个 text-delta 出现在 +${deltas[deltas.length - 1]?.at ?? 'n/a'}ms`)
console.log(`最后的 chunk（${lastMark.type}）出现在 +${lastMark.at}ms`)
const spread = (deltas[deltas.length - 1]?.at ?? 0) - (deltas[0]?.at ?? 0)
console.log(spread > 100
  ? `结论：正文随生成逐步吐出（首尾差 ${spread}ms，流式保留成功）`
  : `结论：正文被积压到结尾才吐出（首尾差 ${spread}ms，流式已丢失）`)