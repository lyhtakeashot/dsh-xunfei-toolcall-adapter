# dsh-market 上架材料与执行手册

> 生成于 2026-11-25。目标：把 `dsh-xunfei-toolcall-adapter` 收录进 `dsh-market`。
> 定时任务：**2026-11-26 10:00** 自动提 PR。

---

## 一、机制（已核实）

`dsh-market`（`dshmarket` v1.80.1）本身**不是插件目录**，它只是渲染器。
真正的列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

上架方式：往那个仓库的 `data/plugins/` 加**一个 YAML 文件**，提 PR。
合并后 README 与站点自动重新生成，`dsh-market` 通常一天内收录。

---

## 二、硬门槛（已核对）

| 要求 | 状态 |
|---|---|
| 公开仓库 | ✅ |
| `package.json` 声明 `dsh.bundle` | ✅ `{ "patch": "./cordis.patch.yml" }` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 有真实可用代码（非占位） | ✅ 28 文件 |
| **仓库存续 ≥ 1 天** | ⏳ 创建于 2026-11-25T05:05:46Z，**26 日 05:05 UTC 后满足** |
| `description.en` 必填 | ✅ |

⚠️ 最后一条是**唯一的时间门槛**。这就是为什么定时到明早 10:00（本地时间），
此时距创建已约 29 小时，留足余量。

---

## 三、材料清单

| 文件 | 用途 |
|---|---|
| `lyhtakeashot__dsh-xunfei-toolcall-adapter.yml` | **要提交的那个文件**，原样放入 `data/plugins/` |
| `PR-DESCRIPTION.md` | PR 正文，粘贴到 GitHub 的 PR 描述框 |
| `verify-market-entry.mjs` | 本地预演 CI 校验，避免被打回 |
| `verify-result.txt` | 上次校验结果（PASS） |

本地校验：

```bash
node verify-market-entry.mjs lyhtakeashot__dsh-xunfei-toolcall-adapter.yml
# 期望：RESULT PASS
```

它复刻了官方 `scripts/lib/entries.mjs` 的规则：字段白名单、url 格式、
文件名匹配、name 与 url 一致、category 取值、description 必填与引号要求。

---

## 四、执行步骤（明天 10:00）

### 方式 A：网页（最稳，推荐）

1. 打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 点 **Fork**（如果你的账号还没 fork 过）
3. 在你 fork 的仓库里，进入 `data/plugins/`
4. **Add file → Create new file**，文件名填：
   ```
   lyhtakeashot__dsh-xunfei-toolcall-adapter.yml
   ```
5. 粘贴 `lyhtakeashot__dsh-xunfei-toolcall-adapter.yml` 的全部内容
6. Commit → 界面会提示 **Compare & pull request**
7. 标题：`Add lyhtakeashot/dsh-xunfei-toolcall-adapter`
8. 描述：粘贴 `PR-DESCRIPTION.md` 全文
9. Create pull request

### 方式 B：命令行（你要是更顺手）

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
cp <本目录>/lyhtakeashot__dsh-xunfei-toolcall-adapter.yml data/plugins/
git checkout -b add-xunfei-toolcall-adapter
git add data/plugins/lyhtakeashot__dsh-xunfei-toolcall-adapter.yml
git commit -m "Add lyhtakeashot/dsh-xunfei-toolcall-adapter"
git push -u origin add-xunfei-toolcall-adapter
gh pr create --title "Add lyhtakeashot/dsh-xunfei-toolcall-adapter" \
             --body-file <本目录>/PR-DESCRIPTION.md
```

⚠️ **本机 git 的 HTTPS 已损坏**（`schannel: SEC_E_NO_CREDENTIALS`），
方式 B 在本机会失败。用方式 A，或先修好 git。

---

## 五、PR 会被怎么审

官方说明：**CI 绿是前提，不是决定**。
CI 只验形状（manifest、仓库年龄、格式、README 能否重新生成），
无法判断插件是否做到条目里说的事。维护者会**实际读仓库**再合并。

所以 `PR-DESCRIPTION.md` 里写了可复现的 N1–N5 表格与验证数据 ——
这比形容词有用。

分类选了 `model`（注册 provider route、翻译模型响应），
官方明确说「分类不会成为打回理由，不贴切维护者直接改」，所以不必纠结。

---

## 六、合并之后

1. `awesome-dsh-plugin.com/plugins.json` 与 `dshmarket.com/index.json` 会自动更新，
   通常**一天内**生效。
2. 用户可在 `dsh-market` 里搜到并一键安装。
3. 你的 `dsh-market` 本地缓存可能需要刷新（重启 DSH 或等 TTL 过期）。

---

## 七、可选增强（不影响收录）

官方建议给 GitHub Release 附**预构建 tarball**，市场会优先展示它而不是源码构建命令。
条目里对应可选字段 `tarball:`。

当前**没做**，原因：本机 git TLS 损坏，但 `gh release create` 走 API 可绕开 —— 需要的话可以补。

即使不做，插件照样能从 GitHub 源码安装，收录不受影响。

---

## 八、如果被拒

官方列出常见拒绝原因，逐条自查：

| 原因 | 本仓库情况 |
|---|---|
| 只声明 `dsh.client`，没 `dsh.bundle` | ✅ 有 `dsh.bundle` |
| 占位 / 纯 README 仓库 | ✅ 28 文件真实代码 |
| 仓库不满 1 天 | ⏳ 已避开，10:00 提 |
| 字段白名单外 | ✅ 只有 url/name/category/description |
| description 含 `: ` 未加引号 | ✅ 已用单引号 |
| 聚合包（只装别人插件） | ✅ 自身有行为 |
| 依赖指向非原作者 | ✅ 无外部插件依赖 |

若仍被拒，看 CI 的 `::error` 行，它会给具体文件与原因。