/**
 * 交叉验证（Electron 运行时版）：用 DSH **真实的** `BlockAssembler` 校验改写结果。
 *
 * 为什么单独一个文件：`@deepseek-ai/dsh-llm` 只存在于 Desktop 的 `app.asar` 里，
 * 普通 Node 看不到 ASAR 归档（`ENOENT`），而 Electron 运行时支持。因此本脚本
 * 必须用 `ELECTRON_RUN_AS_NODE=1` + Electron 可执行文件运行：
 *
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" <本文件>
 *
 * 本环境捕获子进程 stdout 会失败，所以结果**自己写进文件**（见 RESULT_PATH）。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { rewriteTextToolCalls } from '../lib/stream-rewriter.js'
import { defaultResultDir, locateDshRuntime, locateHelp } from './locate-dsh.mjs'

/** 结果输出路径。 */
const RESULT_PATH = process.argv[2] ?? join(defaultResultDir(), 'test-real-assembler-result.txt')

/** 讯飞实测原文。 */
const XUNFEI_TEXT_CALL = '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'

const lines = []
const log = (line) => lines.push(String(line))
let failures = 0

/**
 * 断言助手：记录通过/失败而不抛，保证一次跑完拿到全部结论。
 * @param {string} label - 用例描述。
 * @param {() => void | Promise<void>} body - 断言体。
 * @returns {Promise<void>}
 */
async function check(label, body) {
  try {
    await body()
    log(`PASS  ${label}`)
  } catch (error) {
    failures += 1
    log(`FAIL  ${label}`)
    log(`      ${String(error?.message ?? error).split('\n').slice(0, 4).join('\n      ')}`)
  }
}

/** 简易断言。 */
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: 期望 ${b}，实际 ${a}`)
}
const ok = (value, what) => { if (!value) throw new Error(what) }

/** 把文本包成讯飞式上游流。 */
function xunfeiStream(text) {
  return (async function* emit() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 42, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** 跑一次改写。 */
async function rewrite(upstream, toolNames) {
  const out = []
  for await (const chunk of rewriteTextToolCalls(upstream, { toolNames, enabled: true, log: () => {} })) {
    out.push(chunk)
  }
  return out
}

async function main() {
  log(`# 真实 BlockAssembler 交叉验证`)
  log(`# 运行时: ${process.versions.electron === undefined ? 'node' : `electron ${process.versions.electron}`}`)
  log('')

  const located = locateDshRuntime()
  if (located === undefined) {
    log('SKIP 未能定位 DSH 安装目录，本测试无法进行')
    log('')
    log(locateHelp())
    writeFileSync(RESULT_PATH, lines.join('\n'), 'utf8')
    return
  }
  log(`# 目标: ${located.dshLlm}`)
  log('')

  let real
  try {
    real = await import(pathToFileURL(located.dshLlm).href)
  } catch (error) {
    log(`FATAL 无法加载真实的 @deepseek-ai/dsh-llm: ${error?.code ?? ''} ${error?.message ?? error}`)
    log('')
    log(locateHelp())
    writeFileSync(RESULT_PATH, lines.join('\n'), 'utf8')
    return
  }

  log(`模块已加载；导出项包含 BlockAssembler: ${typeof real.BlockAssembler === 'function'}`)
  log('')

  await check('官方 BlockAssembler 是可构造的类', () => {
    ok(typeof real.BlockAssembler === 'function', 'BlockAssembler 不是函数')
  })

  await check('改写后的 chunks 能被官方 assembler 重建出 tool-call', async () => {
    const chunks = await rewrite(xunfeiStream(XUNFEI_TEXT_CALL), ['get_weather'])
    const assembler = new real.BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    eq(assembler.finish, { kind: 'tool-calls' }, 'finish')
    eq(assembler.usage, { inputTokens: 42, outputTokens: 8 }, 'usage')

    const blocks = assembler.blocks()
    const calls = blocks.filter((block) => block.type === 'tool-call')
    eq(calls.length, 1, 'tool-call 块数量')
    eq(calls[0].name, 'get_weather', '工具名')
    eq(JSON.parse(calls[0].arguments), { city: 'Beijing' }, '工具参数')
    eq(blocks.filter((block) => block.type === 'text').length, 0, '含标签的文本块数量')
  })

  await check('官方 assembler 能把改写结果定型成 assistant 消息', async () => {
    const chunks = await rewrite(xunfeiStream(XUNFEI_TEXT_CALL), ['get_weather'])
    const assembler = new real.BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    const message = assembler.message({ provider: 'xunfei-compatible', model: 'spark-x2.6' })
    eq(message.role, 'assistant', 'role')
    eq(message.source.provider, 'xunfei-compatible', 'source.provider')
    const calls = message.content.filter((block) => block.type === 'tool-call')
    eq(calls.length, 1, '消息内 tool-call 数量')
    eq(calls[0].name, 'get_weather', '消息内工具名')
  })

  await check('透传路径下官方 assembler 保持 stop 与正文', async () => {
    const chunks = await rewrite(xunfeiStream('北京今天多云。'), ['get_weather'])
    const assembler = new real.BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    eq(assembler.finish, { kind: 'stop' }, 'finish')
    const blocks = assembler.blocks()
    eq(blocks.length, 1, '块数量')
    eq(blocks[0].type, 'text', '块类型')
    eq(blocks[0].text, '北京今天多云。', '正文')
  })

  await check('多调用时官方 assembler 保留全部 tool-call', async () => {
    const text = '<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>'
      + '<tool_call>get_time<arg_key>zone</arg_key><arg_value>Asia/Shanghai</arg_value></tool_call>'
    const chunks = await rewrite(xunfeiStream(text), ['get_weather', 'get_time'])
    const assembler = new real.BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    eq(assembler.finish, { kind: 'tool-calls' }, 'finish')
    const calls = assembler.blocks().filter((block) => block.type === 'tool-call')
    eq(calls.map((call) => call.name), ['get_weather', 'get_time'], '工具名顺序')
    ok(new Set(calls.map((call) => call.id)).size === 2, 'call id 必须互不相同')
  })

  log('')
  log(`SUMMARY failures=${failures}`)
  writeFileSync(RESULT_PATH, lines.join('\n'), 'utf8')
}

void main().catch((error) => {
  log(`FATAL ${error?.stack ?? error}`)
  try { writeFileSync(RESULT_PATH, lines.join('\n'), 'utf8') } catch {}
})