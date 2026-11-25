# xunfei-compatible-adapter

[English](README.md) | 中文

一个 DeepSeek Harness bundle：新增 `xunfei-compatible` 这条 provider route，修复讯飞 MaaS `spark-x2.6` 把工具调用写成**纯文本**、导致 agent 轮次直接结束（工具根本没执行）的问题。

## 问题是什么

讯飞的 `/v2/chat/completions` 对标准 OpenAI 工具调用实现是正确的——**前提是请求里真的声明了工具**。当 `tools` 是**空数组或该字段缺失**、而 system prompt 仍在用文字描述工具时，讯飞会返回 HTTP 200、`finish_reason: "stop"`、`tool_calls: null`，把本该是工具调用的内容写进 `content`：

```
<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>
```

对 agent loop 来说 `finish_reason: "stop"` 意味着「已完成，这就是答案」，于是它接受这段文字、结束本轮。提示词解决不了：在 system prompt 里要求模型输出 `TOOL_CALL: {...}`，模型会照做，但依旧返回 `stop`。

## 这个 bundle 做什么

它注册一条**新** route，包装已有的 route，在 `StreamChunk` 层做翻译：

```
请求  →  ctx.llm.stream({ ...options, provider: targetProvider })
响应  →  rewriteTextToolCalls(upstream)  →  agent loop
```

仅当「终态是 `stop`、正文里有完整且可解析的调用、工具名在**本次请求**声明过、且上游没有给出真实 tool-call」时，适配器才丢掉标签文字、发出标准 `tool-call` 块，并以 `{ kind: 'tool-calls' }` 收尾。其余响应一律原样透传。

它不新建 HTTP 客户端、不起本地代理、不修改你现有的 route 配置。鉴权、重试、attribution headers、图片投影、模型元数据全部沿用你已有的 pi-ai route。

### 能识别的调用格式

| 形式 | 例子 |
|---|---|
| 标签 + 参数对 | `<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>` |
| 标签 + JSON 对象 | `<tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}</tool_call>` |
| 前缀行 | `TOOL_CALL: {"name":"get_weather","arguments":{"city":"Beijing"}}` |
| 前缀行、只声明一个工具 | `TOOL_CALL: {"city": "Beijing"}` |

参数值的还原顺序与已验证的参考代理一致：布尔 → 数字 → JSON，都不成立就保留原始字符串。支持一条消息里多个调用，且「正文与调用混排」时保持原始顺序。

### 什么情况下拒绝转换

必须同时满足：`stop` 终态、响应里无真实 tool-call、至少解析出一条调用、且**每条**调用的工具名都在本次声明里。畸形 body、未闭合标签、未知工具名、多工具下的歧义行，都会原样返回。任何情况下都不抛异常。

## 安装

bundle 就在本目录。两种方式任选：

- **插件** > **添加插件**，选择本目录；或
- `plugin_manager` 的 `install_bundle`，`target` 填本目录绝对路径。

安装后会激活 `cordis.patch.yml` 里那行插件、注册 `xunfei-compatible`。你现有的 `xunfei` provider 配置不会被读取或修改。

## 配置

### 只需要安装 bundle，**不需要**再往 `providers` 里加条目

这一点很容易搞错，务必看清：本插件是**独立注册一条 route**，
而 GUI 的模型选择器是通过 `ctx.llm.listProviders()` + `listModels()` **自动发现** route 的
（`dsh-api-session-controller` 的 `buildModelCatalog()`，524-554 行）。

所以安装 bundle 后，`xunfei-compatible` 会**自动出现**在模型选择器里，模型目录由插件
向 `xunfei` 镜像而来。

⚠️ **不要在 `@deepseek-ai/dsh-llm-pi-ai` 的 `providers` 里再加一个 `xunfei-compatible`。**
那会让 pi-ai 也去注册同名 route，与插件冲突并触发 `DUPLICATE_ADAPTER`
（`LlmRuntime.registerAdapter` 是原子校验，冲突时抛错、旧 route 保持服务）。
本插件早期版本的 README 曾给出这个错误示例，已更正。

你原有的 `xunfei` 条目**完全不要动**。

### API key 填在哪里（以及不填在哪里）

这一段是最容易搞错的地方，请照做。

**key 属于 `xunfei` 那条 route，不属于本插件。** 本适配器自己不持有任何凭据：
它把每个请求转发给 `targetProvider`（默认 `xunfei`）指定的 route，由那条 route 完成鉴权。
适配器全程不读取、不写入、不记录 key。

所以要分两步做，各管各的：

| 步骤 | 位置 | 做什么 |
|---|---|---|
| 1. 填凭据 | **设置 → 模型**，`讯飞` / `xunfei` 那一行 | 填入你的讯飞 MaaS API key。它以只写方式存进 profile 的凭据引用，再被 `apiKeyEnv: XUNFEI_API_KEY` 引用。 |
| 2. 选模型 | 输入框上方的模型选择器 | 选 `讯飞（文本工具链修正）` 分组，再选 `spark-x2.6`。 |

如果你连 `xunfei` 都还没配过，先配它：需要 `api`、`baseURL`
（`https://maas-api.cn-huabei-1.xf-yun.com/v2`）、`apiKeyEnv: XUNFEI_API_KEY`，
以及至少一个模型。设置页的 **添加 provider** 就能手工声明这样一条 route，**不必改任何文件**。

**为什么设置页里没有 `xunfei-compatible` 这一行。** 本插件刻意**不**注册
configurable-provider 目录条目，以此换取「零设置命名空间、零依赖」。
代价是设置页只列出 `xunfei`；`xunfei-compatible` 只出现在**模型选择器**里，
目录从 `xunfei` 镜像而来。这是有意为之 —— 那一行没有任何东西需要配。
想改它的显示名、route 名或日志，走插件的 `config`（见下），不走设置页。

### 安装后的自检

安装后确认两件事即可：

1. 插件页里 `xunfei-compatible-adapter` 显示已启用、无诊断错误。
2. 在新会话的模型选择器里能看到 `讯飞（文本工具链修正）` 这个分组，其下有 `spark-x2.6`。

看不到时：
- 分组名对不上 → 说明插件没激活，回插件页看错误。
- 分组出现但下面没有模型 → 说明插件向 `xunfei` 取目录失败，检查原 `xunfei` 配置与凭据。

### 插件选项

在 profile 的 `cordis.patch.yml` 里改这一行的 `config`。这些是**适配器行为，不是凭据**：

| 选项 | 默认 | 含义 |
|---|---|---|
| `route` | `xunfei-compatible` | 要注册的 route 名。不能等于 `targetProvider`。 |
| `targetProvider` | `xunfei` | 真正执行请求、并持有凭据的已有 route。 |
| `displayName` | `讯飞（文本工具链修正）` | provider 选择器里显示的名字。 |
| `parseTextToolCalls` | `true` | 设为 `false` 即退化为纯转发 route，便于对比排查或立即止血。 |
| `logEnabled` | `true` | 设为 `false` 停止写请求日志。 |
| `logPath` | `~/.dsh/xunfei-compatible-adapter/adapter-requests.jsonl` | JSONL 请求日志位置。 |

这里**故意没有** `apiKey` / `apiKeyEnv` / `baseURL`：它们属于 `targetProvider`。

## 请求日志

每个结束的请求向 `logPath` 追加一行 JSON：

```json
{"t":"...","route":"xunfei-compatible","model":"spark-x2.6","toolsShape":30,"toolsCount":30,
 "toolNames":["bash","read",...],"hasToolHistory":true,"converted":false,"inFlight":0,"durationMs":2411}
```

`toolsShape` 是适配器转发出去的声明数量，请求里完全没有 `tools` 字段时是 `"MISSING"`。转换相关事件单独记一行，`event` 取值为 `converted`、`marker-detected`、`parse-rejected`、`rewrite-failed`、`passthrough-native-tool-calls` 之一。日志是 best-effort：写失败只通过插件 logger 报一次，绝不影响模型调用。

`toolsCount` 正是这份日志的意义所在。本 harness 靠工具声明而非文字描述，所以请求通常带非空 `tools` 数组——这意味着已确认的触发条件（`tools` 为空或缺失）**在这条 route 上可能根本不出现**。这份日志就是用来定论的：若工具数始终大于 0 却仍能复现故障，本文的诊断就是不完整的。

## 回滚

1. 在**插件**页禁用 `xunfei-compatible-adapter`，route 消失，不再改写任何请求。
2. 想彻底不用这条 route，删掉你新加的 `xunfei-compatible` provider 条目，并在原 `xunfei` provider 下重新选模型。
3. 想卸载包，调用 `plugin_manager` 的 `remove_bundle`，`target` 填 `@local/xunfei-compatible-adapter`。

本插件从不修改你原来的 `xunfei` route、`baseURL` 或凭据引用，所以回滚时那边没有任何东西需要复原。

## 测试

用 bundled Node 运行（本沙箱拦截 `node --test` 的子进程 spawn，属已记录的 `EPERM` 边界，因此逐个文件在当前进程内执行）：

```powershell
node test/stream-rewriter.test.mjs      # 37 例：解析器、改写器、流式保留、不丢正文
node test/adapter.test.mjs              # 14 例：转发、route 隔离、消息重建、加载顺序
node test/streaming-probe.mjs           # 实测「正文确实是流式吐出」而非结尾一次性积压
```

与宿主官方 `BlockAssembler` 的交叉验证需要能读 ASAR 的运行时，因为 `@deepseek-ai/dsh-llm` 在 `app.asar` 里、普通 Node 看不见：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '<DeepSeek Harness 安装目录>\DeepSeek Harness.exe' test/real-assembler.electron.mjs
```

结果写入 `test/results/`。

关于「哪些是实测、哪些只验证了合成 chunk 流、哪些仍是假设」，见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。
关于「安装会不会让 DSH 崩溃或丢数据」，见 [docs/SAFETY.md](docs/SAFETY.md)。

## 已知限制

- **线上触发条件尚未完全证实。** 文本化工具链行为已在真实端点上、以 `tools: []` 或缺失 `tools` 的方式复现；但**没有**在 DSH 自身的请求流里直接观测到。请求日志就是为了补上这一环。
- **只处理 `stop` 响应。** 因长度截断（`max-tokens`）而结束的响应不做处理，因为被截断的调用无法安全执行。
- **改写时丢弃 replay 元数据。** 上游 `replayState` 描述的是原来那段文本响应；块结构变化后已对不上，因此改写路径不携带它，harness 会退化为 provider 中立内容。
- **合成 call id。** 改写出的调用带适配器生成的 id（`xfcall_…`），因为讯飞从未给过。
- **缓冲被压缩但没有消失。** 在看到标记之前会扣住最多 `MAX_MARKER_LEN - 1` 个字符，以便识别被切分到多个 delta 里的标记。因此正文比无适配器时晚几个字符开始流动，之后正常流动。
- **工具名必须与请求匹配。** 本次请求没有声明的工具名绝不被执行，只会作为文本保留。