# Xunfei tool-call adapter for DeepSeek Harness

[中文](README.zh.md)

A DeepSeek Harness bundle that fixes Xunfei MaaS (`spark-x2.6`) printing tool calls as **plain text** and ending the turn instead of running the tool.

> **Status**: working, tested end-to-end against the live endpoint. See [Verification](#verification).

---

## The problem

Xunfei's `/v2/chat/completions` implements standard OpenAI tool calling correctly — **when the request actually declares tools**. When `tools` is an empty array or absent while the system prompt still describes tools in prose, Xunfei answers HTTP 200 with `finish_reason: "stop"` and writes the intended call into `content`:

```
<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>
```

To the agent loop, `finish_reason: "stop"` means "done, here is the answer", so it accepts that text as the final reply and the turn ends. **The tool never runs.**

Prompt engineering does not fix it. Verified: asking the model in the system prompt to emit `TOOL_CALL: {...}` makes it comply — and it still returns `stop`.

### Reproduced against the live endpoint

| Case | Request | Result |
|---|---|---|
| N1 | `tools: []` + tool history | 200 / `stop` / `tool_calls: null` / text-rendered call |
| N2 | no `tools` field + history | 200 / `stop` / text-rendered call |
| N3 | `tools: []`, no history | 200 / `stop` / text-rendered call |
| N4 | no `tools`, system asks for `TOOL_CALL: {...}` | 200 / `stop` / model complies, still `stop` |
| N5 | valid `tools` | 200 / **`tool_calls`** / correct arguments |

Ruled out as causes: `strict: false`, `stream`, developer role, `reasoning_effort`, `max_completion_tokens`, `stream_options`, complex schemas (30 tools), multi-turn replay, `thinking` field.

---

## What this does

It registers one **new** provider route, `xunfei-compatible`, that wraps your existing Xunfei route and translates at the `StreamChunk` level — no local proxy, no HTTP reimplementation:

```
request  →  ctx.llm.stream({ ...options, provider: targetProvider })
response →  rewriteTextToolCalls(upstream)  →  agent loop
```

When a response ends with `stop`, carries no native tool call, and contains a complete call for a tool **declared in that same request**, the adapter drops the label text, emits standard `tool-call` blocks, and finishes with `{ kind: 'tool-calls' }`.

Everything else streams through untouched — including every other response, which is most of them.

### Recognized formats

| Form | Example |
|---|---|
| Tagged with argument pairs | `<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>` |
| **Truncated tag** (observed in practice) | `<pwsh<arg_key>command</arg_key><arg_value>ls</arg_value></tool_call>` |
| Tagged with JSON | `<tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}</tool_call>` |
| Prefixed line | `TOOL_CALL: {"name":"get_weather","arguments":{"city":"Beijing"}}` |
| Prefixed line, one tool declared | `TOOL_CALL: {"city": "Beijing"}` |

The truncated form is real: Xunfei sometimes omits the opening `<tool_call>` and starts straight at `工具名<arg_key>`. It is accepted **only** when the name matches a tool declared in that request and is immediately followed by `<arg_key>`, so ordinary prose that merely mentions a tool name is never mistaken for a call.

Values coerce as booleans, then numbers, then JSON, else raw string. Multiple calls per message are supported, and prose interleaved with calls keeps its original order.

### When it refuses to convert

All of these must hold: a `stop` finish, no native tool call, at least one parsed call, and **every** parsed tool name present in that request's declarations. Malformed bodies, unclosed tags, unknown tool names, and ambiguous lines under multiple declared tools all pass through unchanged. Nothing throws.

---

## Install

```powershell
# From the DSH UI: Plugins > Add plugin, choose this directory
# Or with the plugin_manager tool:
#   action: install_bundle
#   target: <path to this directory>
```

That is the only installation step. The route registers itself, and the GUI model selector discovers routes through `ctx.llm.listProviders()` + `listModels()`, so `xunfei-compatible` appears on its own with its catalog mirrored from `xunfei`.

> ⚠️ Do **not** add a `xunfei-compatible` entry to the `providers` dictionary of `@deepseek-ai/dsh-llm-pi-ai`. That makes pi-ai register a route of the same name, colliding with this plugin (`DUPLICATE_ADAPTER`).

Leave your existing `xunfei` entry untouched.

### Where your API key goes (and where it does not)

This is the part people get wrong, so it is spelled out.

**The key belongs to the `xunfei` route, not to this plugin.** This adapter holds no credential of its own: it forwards each request to the route named by `targetProvider` (default `xunfei`), and that route authenticates. The adapter never reads, writes, or logs a key.

So do two separate things:

| Step | Where | What |
|---|---|---|
| 1. Credential | **Settings → Models**, the plain `讯飞` / `xunfei` row | Enter your Xunfei MaaS API key. It is stored write-only under the profile's credential reference and referenced as `apiKeyEnv: XUNFEI_API_KEY`. |
| 2. Model choice | The composer's model selector | Pick the `讯飞（文本工具链修正）` group, then `spark-x2.6`. |

If you have not configured `xunfei` at all yet, do that first: it needs `api`, `baseURL` (`https://maas-api.cn-huabei-1.xf-yun.com/v2`), `apiKeyEnv: XUNFEI_API_KEY`, and at least one model. The **Add provider** action on the Models page hand-declares such a route without editing any file.

**Why `xunfei-compatible` has no row on the Models page.** This plugin deliberately does not register a configurable-provider directory entry, so it stays free of settings namespaces and dependencies. The consequence is that the Models page lists only `xunfei`; `xunfei-compatible` appears in the **model selector** only, and its catalog is mirrored from `xunfei`. That is intended — there is nothing on that row to configure. Changing its label, route name, or logging is done through the plugin's `config` (see below), not through the Models page.

### Options

Set these in the plugin's `config`. These are adapter behaviour, **not** credentials:

| Option | Default | Meaning |
|---|---|---|
| `route` | `xunfei-compatible` | Route name to register. Must differ from `targetProvider`. |
| `targetProvider` | `xunfei` | Existing route that performs the request and holds the credential. |
| `displayName` | `讯飞（文本工具链修正）` | Label in provider selectors. |
| `parseTextToolCalls` | `true` | `false` degrades this route to pure forwarding. |
| `logEnabled` | `true` | `false` stops the request log. |
| `logPath` | `~/.dsh/xunfei-compatible-adapter/adapter-requests.jsonl` | Where the JSONL log is appended. |

There is no `apiKey` / `apiKeyEnv` / `baseURL` option here on purpose: those belong to `targetProvider`.

---

## Design notes

### Why a thin wrapper instead of forking pi-ai

- pi-ai's `toStreamChunks()` is **not exported**; wrapping its event stream means forking the whole package.
- Re-implementing the HTTP layer would duplicate auth, retries, attribution headers, image projection, and model metadata.
- The `StreamChunk` protocol is expressive enough: text and tool-call are independent block types, `block-index` correlates deltas, and `block-end` carries the authoritative block. Rewriting is legal and `BlockAssembler` reconstructs it.

### Two bugs this code fixes in itself (do not regress)

1. **Full-response buffering destroys streaming.** Buffering until `finish` means *every* ordinary chat with tools loses streaming — measured at 562 ms of text arriving all at once. Now prose streams with only a `MAX_MARKER_LEN - 1` tail held back (so a marker split across deltas is still recognized). Approach mirrors sglang's `ends_with_partial_token`.

2. **Never silently drop prose.** A model may *quote* the `<tool_call>` tag while explaining the format. Holding text back and never releasing it truncates the reply — the same defect as [vllm-project/vllm#63309](https://github.com/vllm-project/vllm/issues/63309). Here, if no conversion happens, every held character is released.

3. **Adapter contract completeness.** `LlmRuntime` calls `adapter.prepareCall()`, `imageRequestPricing()`, and `imageRequestTarget()` unconditionally. This adapter is a plain object (not a subclass of `LlmAdapter`, to stay dependency-free), so it implements all three itself. Missing one makes every request fail with `registration.adapter.prepareCall is not a function`.

### Traceability

The session log records the chunks **emitted by this adapter**, not the raw upstream text. After rewriting, the log holds a normal assistant message with a `tool-call` block, reconstructable by `BlockAssembler`. The discarded label text never enters the log, so `model-visible ⟺ logged` holds. Requests are never modified — loop-built requests are deep-frozen, and this adapter only replaces the `provider` field on a copy.

---

## Verification

### Test suites

```bash
node test/stream-rewriter.test.mjs    # 44 cases: parser, rewriter, streaming, no-text-loss
node test/adapter.test.mjs            # 14 cases: forwarding, route isolation, message rebuild
node test/streaming-probe.mjs         # measures that prose still streams
node test/installed-smoke.mjs out.txt # 23 assertions against the real plugin code
```

`node --test` is not used because it spawns child processes, which some sandboxes block; each file runs in-process instead.

### Against the harness's own runtime

`@deepseek-ai/dsh-llm` ships inside DSH's `app.asar`, which plain Node cannot read. Run these under the Electron runtime:

```bash
ELECTRON_RUN_AS_NODE=1 '<path to DeepSeek Harness executable>' test/real-contract.electron.mjs
ELECTRON_RUN_AS_NODE=1 '<path to DeepSeek Harness executable>' test/real-assembler.electron.mjs
```

`test/locate-dsh.mjs` finds the installed packages automatically (`DSH_NODE_MODULES` overrides it); when it cannot, the test reports `SKIP` with instructions rather than pretending to pass.

- `real-contract` drives the adapter through the **real** `LlmRuntime` and a **real** Cordis `Context`: 7/7.
- `real-assembler` feeds rewritten chunks to the **real** `BlockAssembler`: 5/5.

### End-to-end

On a live session using `xunfei-compatible`: **41 tool calls, 41 results, 26 steps, 0 leaked `<tool_call>` tags** in 221 KB of session log.

---

## Known limitations

- **The online trigger is not fully confirmed.** The text-rendering was reproduced with `tools: []` or absent; it has **not** been observed in DSH's own request stream. In real usage so far, 32 of 34 requests carried 108 tools and all passed through with zero conversions — so on normal paths Xunfei behaves correctly and this adapter is insurance rather than a necessity. The request log exists to settle it.
- **Only `stop` responses are considered.** A length-truncated response is left alone; a partial call cannot be executed safely.
- **Replay metadata is dropped when rewriting.** Upstream `replayState` describes the original text response and no longer matches the new block structure.
- **Synthetic call ids.** Rewritten calls carry adapter-generated ids (`xfcall_…`) since Xunfei produced none.
- **Bounded buffering.** Up to `MAX_MARKER_LEN - 1` characters are held while no marker is seen, so prose starts a few characters later than without the adapter.
- **Tool names must match the request.** A call naming a tool the request did not declare stays as text and is never executed.

---

## Rollback

1. Disable `xunfei-compatible-adapter` in **Plugins** — the route disappears and nothing is rewritten.
2. To stop using the route entirely, select a model under your original `xunfei` provider.
3. Remove the package with `plugin_manager` `remove_bundle`.

Your original `xunfei` route, `baseURL`, and credential reference are never modified.

---

## License

MIT. Not affiliated with iFlytek or DeepSeek. Xunfei and DeepSeek are trademarks of their respective owners.