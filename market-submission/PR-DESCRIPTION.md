# Add `lyhtakeashot/dsh-xunfei-toolcall-adapter`

Adds one entry file: `data/plugins/lyhtakeashot__dsh-xunfei-toolcall-adapter.yml`.

## What the plugin does

Xunfei MaaS `spark-x2.6` answers HTTP 200 with `finish_reason: "stop"` and writes the intended tool call into `content` as plain text when the request carries no tool declarations:

```
<tool_call>get_weather<arg_key>city</arg_key><arg_value>Beijing</arg_value></tool_call>
```

To the agent loop, `stop` means "finished, here is the answer", so the turn ends and the tool never runs. Prompt engineering cannot work around it: asking the model in the system prompt to emit `TOOL_CALL: {...}` makes it comply, and it still returns `stop`.

The plugin registers a `xunfei-compatible` provider route that wraps an existing Xunfei route and translates at the `StreamChunk` level. When a response ends with `stop`, carries no native tool call, and contains a complete call for a tool **declared in that same request**, it emits standard `tool-call` blocks and finishes with `{ kind: 'tool-calls' }`. Every other response passes through untouched.

It holds no credential of its own and starts no proxy: it forwards to the wrapped route, which authenticates.

## Reproducible symptom

Measured against the live endpoint:

| Case | Request | Result |
|---|---|---|
| N1 | `tools: []` + tool history | 200 / `stop` / `tool_calls: null` / text-rendered call |
| N2 | no `tools` field + history | 200 / `stop` / text-rendered call |
| N3 | `tools: []`, no history | 200 / `stop` / text-rendered call |
| N4 | no `tools`, system asks for `TOOL_CALL: {...}` | 200 / `stop` / model complies, still `stop` |
| N5 | valid `tools` | 200 / **`tool_calls`** / correct arguments |

Ruled out: `strict: false`, `stream`, developer role, `reasoning_effort`, `max_completion_tokens`, `stream_options`, 30 complex schemas, multi-turn replay, `thinking`.

## Verification

- 37 rewriter cases, 14 adapter cases, 23 smoke assertions.
- 7 contract checks driving the adapter through DSH's **real** `LlmRuntime` and a **real** Cordis `Context`; 5 more feeding rewritten chunks to the **real** `BlockAssembler`.
- End-to-end on a live session: 41 tool calls, 41 results, 26 steps, zero leaked `<tool_call>` tags across 221 KB of session log.

## Submission requirements

- Public repository, real working code, not a placeholder.
- `package.json` declares `dsh.bundle`: `{ "patch": "./cordis.patch.yml" }`, with that file at the repository root.
- Repository age: created 2026-11-25T05:05:46Z; this PR is opened after the 1-day minimum.

## Category

`model` — the plugin registers a provider route and translates model responses; it is not a tool the agent calls.

## Note on scope

The adapter is deliberately narrow: it only reacts to a `stop` response that contains a parseable call naming a tool declared in that request. If Xunfei fixes the underlying behaviour, the plugin becomes redundant but harmless — it passes everything through, verified as zero conversions across 34 real requests.

## Disclosure

I am the author. MIT licensed. Not affiliated with iFlytek or DeepSeek.