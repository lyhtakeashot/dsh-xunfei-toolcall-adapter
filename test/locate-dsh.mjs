/**
 * 定位 DSH 安装目录，供需要在「真实宿主运行时」下运行的测试使用。
 *
 * 这类测试必须加载安装版 `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/cordis`，
 * 它们可能位于：
 *   - Desktop 打包版：`<install>/resources/app.asar/dsh/node_modules/...`
 *   - npm 安装：      `<install>/node_modules/...`
 *   - 源码 checkout： `<root>/packages/...`（本模块不覆盖，见下）
 *
 * 因此不硬编码任何机器路径，而是按以下顺序解析：
 *   1. 显式参数（调用方传入）
 *   2. `DSH_NODE_MODULES` 环境变量
 *   3. `DSH_INSTALL_DIR` 环境变量推导
 *   4. 从常见安装根目录探测（Windows Desktop / npm 全局）
 *
 * 找不到就抛出清晰错误，让调用方跳过而不是假装通过。
 *
 * @module xunfei-compatible-adapter/test/locate-dsh
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本测试目录的父级（插件根目录）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 判断某个目录下是否存在指定的包入口。
 * @param {string} nodeModules - `node_modules` 目录。
 * @param {string} pkg - 包名。
 * @param {string} entry - 包内相对入口路径。
 * @returns {string | undefined} 入口的绝对路径。
 */
function probe(nodeModules, pkg, entry) {
  const candidate = join(nodeModules, ...pkg.split('/'), entry)
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 列出一个根目录下所有可能的 `node_modules` 位置。
 * @param {string} root - 候选安装根。
 * @returns {string[]} 候选 `node_modules` 路径。
 */
function nodeModulesCandidates(root) {
  return [
    join(root, 'node_modules'),
    join(root, 'resources', 'app.asar', 'dsh', 'node_modules'),
    join(root, 'resources', 'app', 'dsh', 'node_modules'),
    join(root, 'app.asar', 'dsh', 'node_modules'),
  ]
}

/**
 * 猜测 Desktop 安装根目录（仅 Windows 常见位置）。
 * @returns {string[]} 候选根目录。
 */
function guessInstallRoots() {
  const roots = []
  for (const drive of ['C:', 'D:', 'E:']) {
    for (const name of ['DeepSeek Harness', 'DeepSeekHarness', 'deepseek-harness']) {
      roots.push(`${drive}\\${name}`)
    }
  }
  if (process.env.LOCALAPPDATA) {
    roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
    roots.push(join(process.env.LOCALAPPDATA, 'DeepSeek Harness'))
  }
  if (process.env.PROGRAMFILES) {
    roots.push(join(process.env.PROGRAMFILES, 'DeepSeek Harness'))
  }
  return roots
}

/**
 * 解析插件所需的宿主模块入口。
 * @param {{ root?: string }} [options] - 显式指定安装根目录。
 * @returns {{ nodeModules: string, dshLlm: string, cordis: string } | undefined}
 *   解析结果；找不到时返回 undefined。
 */
export function locateDshRuntime(options = {}) {
  /** @type {string[]} */
  const candidates = []

  if (options.root !== undefined) candidates.push(...nodeModulesCandidates(options.root))
  if (process.env.DSH_NODE_MODULES) candidates.push(process.env.DSH_NODE_MODULES)
  if (process.env.DSH_INSTALL_DIR) {
    candidates.push(...nodeModulesCandidates(process.env.DSH_INSTALL_DIR))
    // DSH_INSTALL_DIR 通常已经是 .../node_modules/@deepseek-ai/dsh，
    // 往上两级就是 node_modules
    candidates.push(join(process.env.DSH_INSTALL_DIR, '..', '..'))
    candidates.push(join(process.env.DSH_INSTALL_DIR, '..'))
  }
  for (const root of guessInstallRoots()) candidates.push(...nodeModulesCandidates(root))

  // 去重并逐个探测
  const seen = new Set()
  for (const nodeModules of candidates) {
    if (seen.has(nodeModules)) continue
    seen.add(nodeModules)

    const dshLlm = probe(nodeModules, '@deepseek-ai/dsh-llm', 'lib/index.js')
    const cordis = probe(nodeModules, '@deepseek-ai/cordis', 'lib/index.js')
    if (dshLlm !== undefined && cordis !== undefined) {
      return { nodeModules, dshLlm, cordis }
    }
  }
  return undefined
}

/**
 * 生成「找不到运行时」时的可操作提示。
 * @returns {string} 多行说明。
 */
export function locateHelp() {
  return [
    '未能定位 DSH 安装目录下的 @deepseek-ai/dsh-llm 与 @deepseek-ai/cordis。',
    '',
    '这两个包随 DSH 一起分发，通常位于 Desktop 打包版的 app.asar 内，',
    '普通 Node 无法读取 ASAR，因此本测试必须在 Electron 运行时下执行：',
    '',
    '  PowerShell:',
    '    $env:ELECTRON_RUN_AS_NODE = \'1\'',
    '    & \'<你的 DeepSeek Harness.exe>\' test\\real-contract.electron.mjs',
    '',
    '  bash:',
    '    ELECTRON_RUN_AS_NODE=1 \'<你的 DeepSeek Harness>\' test/real-contract.electron.mjs',
    '',
    '若自动探测失败，可显式指定：',
    '    DSH_NODE_MODULES=<.../node_modules> ELECTRON_RUN_AS_NODE=1 <exe> <script>',
    '',
    `（本文件位于 ${HERE}）`,
  ].join('\n')
}

/**
 * 返回测试结果文件的默认输出目录。
 * @returns {string} `test/results` 的绝对路径。
 */
export function defaultResultDir() {
  return join(HERE, 'results')
}