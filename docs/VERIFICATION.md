# 验证记录（Verification）

本文件严格区分三类结论：**已实测**、**已用合成数据验证**、**仍未证实**。
目的是避免把「我在测试里模拟出来的」当成「线上真的这样」。

---

## 一、已实测（真实证据）

### 1.1 讯飞端点行为（在真实端点上实测，证据由本任务之前的工作产出）

来源：`(本地探针目录)`，
结果文件 `notools-result.txt`，探针脚本 `probe_notools.cjs`。
这些是**上一轮工作**在真实端点上跑出来的结论，本任务直接采信，未重复请求。

| 用例 | 请求特征 | 实测结果 |
|---|---|---|
| N1 | `tools: []` + 带工具历史 | 200 / `finish=stop` / `tool_calls=null` / 正文是 `<tool_call>` 文本 |
| N2 | 完全不带 `tools` 字段 + 带工具历史 | 200 / `finish=stop` / 同样退化为文本 |
| N3 | `tools: []` + 无工具历史 | 200 / `finish=stop` / 同样退化为文本 |
| N4 | 无 `tools`，system 里要求输出 `TOOL_CALL: {...}` | 200 / `finish=stop` / 正文是 `TOOL_CALL: {"city": "Beijing"}` |
| N5 | 带有效 `tools` + 工具历史 | 200 / `finish=tool_calls` / 参数正确 |

**结论（已实测）**：讯飞的 OpenAI 协议本身没问题；退化只在 `tools` 为空或缺失时发生。
提示词无法绕过（N4 证明模型会照格式输出，但依然 `stop`）。

### 1.2 本插件在宿主官方组装器下的行为

证据文件：`xunfei-compatible-adapter/test/results/test-real-assembler-result.txt`
运行方式：Electron 运行时（`ELECTRON_RUN_AS_NODE=1`）直接 `import` 安装版
`@deepseek-ai/dsh-llm`，用**官方** `BlockAssembler` 处理改写后的 chunks。

```
PASS  官方 BlockAssembler 是可构造的类
PASS  改写后的 chunks 能被官方 assembler 重建出 tool-call
PASS  官方 assembler 能把改写结果定型成 assistant 消息
PASS  透传路径下官方 assembler 保持 stop 与正文
PASS  多调用时官方 assembler 保留全部 tool-call
SUMMARY failures=0
```

**结论（已实测）**：改写产出的 chunks 是合法的 `StreamChunk` 流，能被宿主自己的组装器
重建为带 `tool-call` 的 assistant 消息，`finish` 为 `tool-calls`，`usage` 值保留。

### 1.3 流式输出未被牺牲

证据文件：`xunfei-compatible-adapter/test/results/streaming-probe-result.txt`
运行方式：`node test/streaming-probe.mjs`，给上游每字符 1ms 的生成延迟。

实测（引入尾部 holdback 之后）：

```
全文共 37 字；首个 text-delta 出现在 +165ms
最后一个 text-delta 出现在 +568ms
结论：正文随生成逐步吐出（首尾差 403ms，流式保留成功）
```

对照：最初的「整轮缓冲」实现在同一探针下首个 text-delta 出现在 +562ms、与 finish 同一刻，
即**所有带工具的普通聊天都会失去流式**（首尾差 0ms）。该缺陷已修复。

**结论（已实测）**：普通回答仍逐 delta 流出，不是结尾一次性吐出。

---

## 二、已用合成数据验证（不等于线上行为）

以下用例全部基于**人工构造的 chunk 流**，它们证明的是「给定这种上游输入，本插件输出正确」，
**不证明**线上真的会产生这种上游输入。

运行方式与结果：

| 套件 | 用例数 | 结果 |
|---|---|---|
| `test/stream-rewriter.test.mjs` | 37 | 37 pass / 0 fail |
| `test/adapter.test.mjs` | 14 | 14 pass / 0 fail |

覆盖范围：

- **N1–N4 的文本形状**被正确解析并改写：`finish` 变 `tool-calls`、工具名与参数正确、
  正文里不留 `<tool_call>` / `<arg_key>` 标签、`usage` 在 `finish` 之前、`finish` 是最后一个 chunk。
- **N5（真 tool_calls）透传**：逐 chunk 原样转发，合成 id 不覆盖上游 id。
- **多个 `<tool_call>`**：产出多个 `tool-call` 块，`index` 与 `id` 互不相同。
- **畸形文本**：未闭合标签、未知工具名、空 body、非 JSON 的 `TOOL_CALL` 行、纯正文，
  一律不转换且不抛异常。
- **非 `stop` 终态**（`error` / `max-tokens` / `aborted`）：不改写，语义等价透传。
- **标记跨 delta 切分**：以 3 字符为粒度切分时仍能识别（验证尾部 holdback 长度足够）。
- **绝不静默丢正文**：正文里引用 `<tool_call>` 但未构成调用时，整段正文一字不丢。
  这是刻意针对 vLLM Hermes 解析器的已知缺陷（issue #63309）设计的回归用例。
- **route 隔离**：转发时只替换 `provider`，`messages` / `tools` / `temperature` 等原样引用；
  route 与 `targetProvider` 同名时构造即报错（防递归）；下游 route 未注册时构造即报错。
- **目录与元数据转发**：`listModels` / `resolveModel` 把 `provider` 改写为自身 route，
  否则宿主会以 `INVALID_CATALOG` 拒绝。

---

## 三、仍未证实（重要的诚实说明）

### 3.1 线上触发条件：「DSH 的请求里 `tools` 为空」

**这是整个方案的核心假设，尚未实测证实。**

已实测的是「讯飞在 `tools` 为空/缺失时会退化为文本」（§1.1）。
**没有实测到**的是「DSH 发给讯飞的真实请求里，`tools` 确实为空」。

而且有一条反证需要注意：本 harness 的工具是**结构化声明**（工具定义在请求的 `tools` 数组里），
不是靠 system prompt 文字描述的。`dsh-llm` 的 `projectToolUpdates()` 在请求带工具时会投影出非空声明，
`dsh-llm-pi-ai` 的 `piContext()` 只在 `tools.length > 0` 时才把 `tools` 放进上下文。
从源码看，正常 agent 步骤应当带上非空 `tools`。

**因此存在两种可能**：

1. 触发确实来自某个 `tools` 为空的路径（例如某类辅助请求、或工具被投影后为空）；
2. 触发另有原因（例如讯飞对**特定 schema 形状**或**请求体特征**退化），此时本插件的
   改写逻辑仍然有效——因为它按「响应里有文本化调用」判定，而不是按「请求 tools 为空」判定。

第 2 种情况下插件依然是正确的修法，只是**根因描述需要修正**。

**如何定论**：安装后查看请求日志 `~/.dsh/xunfei-compatible-adapter/adapter-requests.jsonl`。

- 若 `toolsCount` / `toolsShape` 出现 `0` 或 `"MISSING"` 且伴随 `converted: true` → 假设成立。
- 若故障复现时 `toolsCount` 始终大于 0 → 假设不成立，触发另有原因（但修复仍有效）。

**在拿到日志之前，本条不得当作已证实。**

### 3.2 未在真实讯飞端点上端到端跑过本插件

本插件从未向真实讯飞端点发出过请求。§1.2 的官方组装器验证用的是合成 chunks。
真实的端到端验证需要先安装 bundle 并配置 route，而安装会改动 profile（影响该 profile 下
所有会话），按任务要求**必须先经用户同意**。

### 3.3 未验证的部分

- **GUI 呈现**：没有在浏览器里看过插件图标、标题、描述、详情页的渲染效果。
  仅确认了 locale 文件结构与 `meta.title` / `meta.description` 字段存在。
- **模型选择器**：`listModels` 的转发已用替身验证，但没有在真实 GUI 里确认
  `xunfei-compatible` 下的 `spark-x2.6` 能被看到并选中。
- **与其他插件的交互**：已扫描 `@deepseek-ai/*` 包确认没有任何内置包监听 `llm/stream`；
  但没有逐一排查 profile 里全部第三方插件是否监听该事件（扫描脚本在超大 profile
  `node_modules` 上未跑完）。若有插件监听 `llm/stream`，它会看到本 adapter **以外**的
  chunk 流（本 adapter 是 route 级的，不参与 waterfall），因此不预期有冲突。

---

## 四、复现与回归

```powershell
# 逻辑层（本沙箱不能用 node --test，它 spawn 子进程会 EPERM）
node test/stream-rewriter.test.mjs
node test/adapter.test.mjs
node test/streaming-probe.mjs

# 与宿主官方组装器交叉验证（需 ASAR 可读运行时；普通 Node 读不到 app.asar，会 ERR_MODULE_NOT_FOUND）
$env:ELECTRON_RUN_AS_NODE = '1'
& '<DeepSeek Harness 安装目录>\DeepSeek Harness.exe' test/real-assembler.electron.mjs
```

当前基线：**37 + 14 = 51 例全通过**；官方组装器交叉验证 **5 项全通过，failures=0**；
流式探针确认正文逐步吐出。各项输出保存在 `test/results/` 下。

安装是否会崩溃或丢数据的核查见 [SAFETY.md](SAFETY.md)（结论：不会；并修掉了
一个加载顺序依赖的真实缺陷）。