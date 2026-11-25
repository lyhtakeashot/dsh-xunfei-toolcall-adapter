# 安装风险核查（Safety review）

结论先行：**安装本 bundle 不会导致 DSH 崩溃，也不会损坏或丢失会话数据。**
以下是逐条依据，以及唯一需要注意的一个真实风险（已修复）。

核查时间：2026-11-25。依据为当前安装版 DSH `0.2.2-rc.3` 的实际源码。

---

## 一、会崩吗？——不会，插件加载失败被完全隔离

### 1.1 加载器对插件异常的隔离（读源码确认）

三个层级各自兜住了异常，任何一层都不会把进程带走：

| 位置 | 行为 |
|---|---|
| `cordis-plugin-loader` `_init()` 582-587 | `import()` 失败 → 只 `logger.error(error)` 后 `return`，不抛到外面 |
| `cordis-plugin-loader` `EntryGroup.update()` 92-94 | `create(...)` 失败 → `.catch` 后 `logger.error` |
| `cordis-plugin-loader` `init()` 575 | `fiber?.await().catch(() => {})` —— `Fiber.await()` 会重抛启动错误（`cordis` 729 行），但这里被显式吞掉 |

也就是说：即使本插件的 `apply()` 抛异常，结果是**这个插件显示为加载失败、其余一切照常**，
而不是宿主崩溃。

### 1.2 已修掉的真实风险：加载顺序依赖

**这是核查中发现并修复的唯一真实缺陷。**

原实现在 `apply()` 里检查「下游 `xunfei` route 必须已注册」，缺失就 `throw`。
但本插件与 `dsh-llm-pi-ai` 的加载顺序由 profile 的 bundle 列表决定，**并不保证**
pi-ai 已经注册完 route（它的注册发生在自己的 `apply()` 内，见 pi-ai 3154 行）。
若顺序不利，本插件会加载失败。

修复：`apply()` 不再抛错，只在缺失时记一条 `warning`；真正的可用性检查移到请求期，
并给出可读的中文诊断（而不是裸的 `NO_ADAPTER`）。
回归用例 `下游 route 未注册时只警告、不阻断插件加载（顺序无关）` 覆盖此点。

### 1.3 插件自身的异常处理

- 解析器任何意外都被 `try/catch` 包住，失败则**原样透传**，绝不抛出
  （`stream-rewriter.js` 的 `rewrite` 调用处与 `parse-rejected` 分支）。
- 日志写盘失败只经 `logger.warn` 报一次，之后静默，不影响模型调用。
- `providerRetryPolicy` 在下游未就绪时返回 `undefined` 走默认策略，不抛。

---

## 二、会丢数据吗？——不会，写入范围与数据位置不相交

### 2.1 会话数据不在会改动的目录里

| 数据 | 位置 | 安装会动它吗 |
|---|---|---|
| **全部会话记录**（1449 个文件 / 约 596 MB） | `~/.dsh\sessions` | **不会** —— 不在 profile 目录内 |
| 凭据 | `~/.dsh\.credentials.yaml` | **不会** —— 只读引用，不写 |
| 记忆 / 附件 / 任务板等 | `~/.dsh\` 下各自目录 | **不会** |
| profile 清单 | `~/.dsh\profiles\desktop\package.json` | **会**，但只追加一行依赖 + 一个 bundle 名 |
| profile 依赖树 | `~/.dsh\profiles\desktop\node_modules` | **会**，pnpm 安装本包 |

关键点：会话日志在 `~/.dsh/sessions`，**不在** `~/.dsh/profiles/desktop` 里。
安装修改的是 profile 的包清单与依赖树，与会话数据是两条不相交的路径。

### 2.2 `install_bundle` 到底改什么（读源码确认）

- `runPnpm(["add", <spec>])` —— 唯一的外部命令（`dsh-plugin-manager` 2986 行）
- `saveManifest()` 用 `writeFileAtomic()` 写 `package.json`（438-440 行）
  —— **原子写**：先写临时文件再替换，中途失败不会留下半个文件
- `reconcile()` 只增删 `dsh.profile.bundles` 数组里的名字（442-480 行）

没有删除、没有 `rm -rf`、没有对 `sessions` 的任何引用。
安装失败（如网络问题）时 pnpm 自身失败，`saveManifest` 不会执行，profile 保持原样；
`installBundle` 还带 `restoreFiles` 逻辑（2977 行）用于多 registry 重试时回滚。

### 2.3 卸载是干净的

`remove_bundle` 移除依赖与 bundle 名。本插件**不写任何自有持久状态**到 profile，
唯一的落盘是请求日志 `~/.dsh/xunfei-compatible-adapter/adapter-requests.jsonl`
（可删，删了不影响任何功能；也可用 `logEnabled: false` 关掉）。

---

## 三、会不会影响现有的 `xunfei` 配置？——不会

- 插件**只读**下游 route：转发、取目录、取元数据、取重试策略。
- 你现有的 `xunfei` provider 条目、`baseURL`、`apiKeyEnv` 都不被读取写入或修改。
- 新增的 `xunfei-compatible` 是**另一条** route，与 `xunfei` 并存。
- 已确认 `XUNFEI_API_KEY` **已存在**于凭据文件的 `refs` 中，无需新增凭据。

唯一需要你手动做的改动是**在你的 profile 的 `cordis.patch.yml` 里加一个 provider 条目**
（示例见 README）。这属于改用户配置，按约定**等你确认后**再由你或我执行。

⚠️ 注意：不要给新 route 起名 `xunfei`，否则触发 `DUPLICATE_ADAPTER`。
插件自身也会在 `route === targetProvider` 时拒绝加载（防递归）。

---

## 四、可能的「坏体验」不等于「崩」和「丢数据」

即便插件行为异常，最坏情况是：

| 情况 | 实际后果 | 是否可逆 |
|---|---|---|
| 插件加载失败 | 插件行显示失败，其他一切正常 | 可逆，禁用/卸载即可 |
| 下游 route 配错 | 该 route 的请求报可读错误 | 可逆 |
| 转换误判 | 极少见；已用白名单 + 多重条件约束 | 可逆，`parseTextToolCalls: false` 立即止血 |
| 日志写失败 | 只警告一次，请求照常 | 无影响 |

**没有任何一条会导致进程退出、会话记录损坏或历史丢失。**

---

## 五、安装前建议（可选但推荐）

1. **备份 profile 清单**（几 KB，秒完成）：
   ```powershell
   Copy-Item '~/.dsh\profiles\desktop\package.json' `
             '~/.dsh\profiles\desktop\package.json.bak-before-xunfei-compat'
   ```
   这是安装唯一会改的既有文件；有它就能一键回滚。

2. 安装后确认 `application: applied`，再在**新会话**里验证。

3. 若要回滚：禁用插件 → 删除新加的 provider 条目 → 需要时 `remove_bundle`。
   （若清单出问题，用上面的备份覆盖回去即可。）

---

## 六、安装期间的运行时影响（对「正在跑的会话」）

结论：**不会改变正在运行会话的行为**（当前会话是 `qodercn`，不是讯飞），
但**安装过程本身需要安静环境**。

### 6.1 安装 bundle 期间

`install_bundle` 执行 `pnpm add`，会重写 profile 的 `node_modules`。
期间任何会话发起的新模型请求都可能因模块解析失败而报错。
这是**短暂不可用**，不是数据损坏；pnpm 结束后恢复。

→ 必须在没有会话运行时安装。

### 6.2 改配置期间

`dsh-llm-pi-ai` 的 Config 中 `providers` 声明为 `.volatile()`
（`dsh-llm-pi-ai/lib/index.js` 1094 行），因此改它走 `_commitVolatile()`
原地更新路径，**不重启 pi-ai**（`cordis-plugin-loader` 498-520 行）。
但 `registration.replace()` 会重新注册全部 route，仍属
「请求进行中改路由」，不建议在流式请求进行时做。

→ 同样应在空闲时进行。

### 6.3 不存在的情况（澄清）

- 不需要重启 DSH 进程（`patchReload: live`）。
- 不会重启 `agent-default-model`（当前会话的模型选择保持不变）。
- 不会影响 qodercn 路由（两条 route 由不同 adapter 持有，互不干涉）。

---

## 七、这次核查**没有**覆盖的

- 没有真正执行安装（按约定需你确认），所以「pnpm 实际成功」未实测。
- 没有逐一审计 profile 里全部第三方插件是否监听 `llm/stream`；本插件是 route 级实现、
  不进 waterfall，因此不预期冲突。
- 未在真实端点上端到端跑过请求（见 `VERIFICATION.md` §3.2）。
- 结论基于当前 `0.2.2-rc.3` 源码；大版本升级后加载器行为可能变化。