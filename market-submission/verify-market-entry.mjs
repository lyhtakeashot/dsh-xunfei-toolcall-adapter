/**
 * 本地预演 awesome-dsh-plugin 的 CI 校验，避免明天 PR 被拦。
 *
 * 复刻 `scripts/lib/entries.mjs` 的 `validateEntries` 规则子集：
 *   - 字段白名单（url/name/category/description/icon/tarball/file）
 *   - url 必须是 https://github.com/owner/repo
 *   - 文件名必须等于 url 的 slug（owner__repo）
 *   - name 若含 `/`，其 owner/repo 部分必须与 url 一致
 *   - category 必须在允许集合内
 *   - description.en 必填且非空；含 ": " 时必须被引号包裹
 *
 * 用法：node verify-market-entry.mjs <yml 路径>
 * 结果写 stderr/stdout 与退出码；本环境捕获 stdout 会失败，故同时写文件。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const ENTRY_KEYS = new Set(['url', 'name', 'category', 'description', 'icon', 'tarball', 'file'])
const CAT_IDS = [
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
  'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow',
  'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun',
]
const LOCALE_CODES = ['en', 'zh']

const ymlPath = process.argv[2]
if (ymlPath === undefined) {
  console.error('用法: node verify-market-entry.mjs <yml 路径>')
  process.exit(2)
}

const text = readFileSync(ymlPath, 'utf8')
const problems = []
const report = []

/**
 * 极简 top-level YAML 读取：只处理本项目条目用到的形状
 * （标量行、以及 `description:` 下缩进的语言键）。
 * @param {string} source - YAML 文本。
 * @returns {Record<string, unknown>} 解析结果。
 */
function parseEntry(source) {
  const result = {}
  let currentSection
  for (const rawLine of source.split('\n')) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue
    const topLevel = rawLine.match(/^([a-zA-Z][a-zA-Z0-9_-]*):(.*)$/)
    if (topLevel !== null) {
      const [, key, rest] = topLevel
      const value = rest.trim()
      if (value === '') {
        currentSection = key
        result[key] = {}
      } else {
        currentSection = undefined
        result[key] = unquote(value)
      }
      continue
    }
    const nested = rawLine.match(/^\s+([a-zA-Z-]+):(.*)$/)
    if (nested !== null && currentSection !== undefined) {
      const [, key, rest] = nested
      result[currentSection][key] = unquote(rest.trim())
    }
  }
  return result
}

/**
 * 去掉成对引号。
 * @param {string} value - 原始标量。
 * @returns {string} 去引号后的值。
 */
function unquote(value) {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * 复刻 slugFor。注意：实现里 owner__repo 的两段都保留了原始大小写，
 * 但文件名比较时与 url 派生结果比对。
 * @param {string} url - 条目 url。
 * @returns {string} 期望的文件名主干。
 */
function slugFor(url) {
  const p = url.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  return p.replace(/\//g, '__')
}

const entry = parseEntry(text)
const at = basename(ymlPath)

// 1) 字段白名单
const extra = Object.keys(entry).filter((k) => !ENTRY_KEYS.has(k))
if (extra.length > 0) {
  problems.push(`未知字段: ${extra.join(', ')}（只允许 ${[...ENTRY_KEYS].join(', ')}）`)
}

// 2) url
if (typeof entry.url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(entry.url)) {
  problems.push('url 必须是 https://github.com/owner/repo')
} else {
  // 3) 文件名必须匹配
  const want = `${slugFor(entry.url)}.yml`
  if (at !== want) problems.push(`文件名应为 ${want}，实际 ${at}`)
}

// 4) name 与 url 一致性
if (typeof entry.name !== 'string' || entry.name.trim() === '') {
  problems.push('name 必填')
} else if (entry.name.split('#')[0].includes('/')) {
  const named = entry.name.split('#')[0].trim().toLowerCase()
  const m = (entry.url ?? '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)/)
  if (m !== null) {
    const actual = `${m[1]}/${m[2]}`.toLowerCase()
    if (named !== actual) problems.push(`name 写的是 ${named}，但 url 是 ${actual}`)
  }
}

// 5) category
if (!CAT_IDS.includes(entry.category)) {
  problems.push(`category 必须是 ${CAT_IDS.join(', ')} 之一，实际 "${entry.category}"`)
}

// 6) description
const desc = entry.description
if (desc === undefined || typeof desc !== 'object') {
  problems.push('description 必须是对象，至少含 en')
} else {
  for (const loc of LOCALE_CODES) {
    const value = desc[loc]
    if (value === undefined) {
      if (loc === 'en') problems.push('description.en 必填')
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`description.${loc} 不能为空`)
      continue
    }
    if (value.includes(': ')) {
      // 含 ": " 的标量必须被引号包裹，否则 YAML 会把它解析成分隔符。
      // 在原始文本里找到承载该值的那一行，检查其值部分是否以引号开头。
      const line = text.split('\n').find((candidate) => candidate.includes(value.slice(0, 40)))
      const afterKey = line === undefined ? '' : line.slice(line.indexOf(':') + 1).trimStart()
      if (!(afterKey.startsWith("'") || afterKey.startsWith('"'))) {
        problems.push(`description.${loc} 含 ": " 但未加引号`)
      }
    }
  }
}

report.push(`# 校验 ${at}`)
report.push('')
report.push(`url:      ${entry.url}`)
report.push(`name:     ${entry.name}`)
report.push(`category: ${entry.category}`)
report.push(`en 长度:  ${entry.description?.en?.length ?? 0}`)
report.push(`zh 长度:  ${entry.description?.zh?.length ?? 0}`)
report.push('')
if (problems.length === 0) {
  report.push('RESULT PASS — 与 awesome-dsh-plugin 的校验规则一致')
} else {
  report.push(`RESULT FAIL — ${problems.length} 个问题`)
  for (const p of problems) report.push(`  - ${p}`)
}

const outPath = join(dirname(ymlPath), 'verify-result.txt')
writeFileSync(outPath, report.join('\n'), 'utf8')
process.exit(problems.length === 0 ? 0 : 1)