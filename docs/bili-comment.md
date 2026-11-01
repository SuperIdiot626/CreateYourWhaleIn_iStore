# B站评论：两道闸

大肥鱼刷 B站时想留言，一开始报：

> 工具 `bili_reply` 不在 QQ 桥接白名单内，已拒绝

原因不是一处，是**两道闸同时关着**。

## 闸 1：QQ 会话的工具面白名单

`plugins/surfcore/qq-tool-restrict.mjs` 的 `SAFE_EXACT` 决定 QQ 里的 agent 能碰哪些工具。
2026-10-30 之前只放了 B站**只读**工具：

```
bili_search / bili_subtitle / bili_comments / bili_cover / bili_frames / bili_whoami / bili_status
```

`bili_reply`（发评论 / 回复评论）不在里面 ⇒ 执行期 guard 直接拒绝。

**修法**：加一行 `'bili_reply',`，并保留注释说明「只解这一只；改配置/发布/私信仍然不给」。
注意 `pwsh` 等仍然被拒——白名单不是打开了就全放行。

## 闸 2：插件自己的评论开关

`dsh-bili-scroll` 的宿主工具层还有一道：

```js
const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.dmMode !== 'only')
if (!commentOn && !args.force) return { ok:false, blocked:true, hint:'…' }
```

三个条件缺一不可：

| 配置 | 含义 |
|---|---|
| `autoComment` | 「自动评论并 @ 你」总开关 |
| `mentionName` | 评论里要 @ 谁（纯文本 @，填你的 B站昵称） |
| `dmMode !== 'only'` | 「只私信」模式会硬关评论通道（插件 2.0.4 的安全设计） |

**修法**：`autoComment=true`、`mentionName=<B站昵称>`、`dmMode="both"`。

> 配置优先级：插件面板存过的键 > 插件自己的 `config.json` > 默认值。
> 如果 `_set` 里有 `dmMode`，改 `config.json` 是生效的；否则要看 DSH 插件设置页那一层。

## 验证

- 白名单单测：`bili_reply => ALLOWED`，`pwsh => 拒绝`。
- 端到端：在 QQ 里让她「去 B站 留个言」，看她是否调用成功（要真机对话才能验）。

## 风险

- **账号风控**：连续高频评论会触发 B站风控（新号尤其）。默认 `commentPerRound=1`，别急着调大。
- **@ 到人**：`mentionName` 填错就是给陌生人发通知，先在测试视频上试。
- **评论内容**：她写的是口语短句，但仍是公开内容；身份守卫（`identity-guard.js`）会拦截在公开面
  复述私密信息。

---

# 评论区点赞（2026-11-01）

「发评论」之外，她还想给别人的评论**点赞**。原来整套工具链里没有这个能力
（`bili-duty/mcp_server.py` 没有 `reply/action`，插件里也没有），所以补了一个独立 MCP。

## 形态

- 工具：`mcp__bili__comment_like`（`status=false` 即取消点赞）
- 接口：`POST https://api.bilibili.com/x/v2/reply/action`，载荷 `{oid, type=1, rpid, action, csrf}`
- 凭据：`/root/.dsh/surfcore/bili/credentials.json`（和 `bili.mjs` / 鱼群保护同一份）
- 部署与升级影响面：见 [`../deploy/surfcore/README.md`](../deploy/surfcore/README.md)

## 为什么不是「再加一个 bili_ 工具」

`bili_*` 那 13 个工具是 `dsh-bili-scroll` 插件注册的，落在
`profiles/web/node_modules/` 下 —— 重装即失效。而且它的 Python 服务端在
`/root/.dsh/bili-duty/mcp_server.py` 里，那个文件**每次挂载都会被 `state.mjs`
从 `vendor/bilibili-mcp/mcp_server.py` 覆盖**，改它等于白改。

所以走和 `mcp-qzone.js` 同样的形态：SurfCore `src/` 下一个独立 stdio MCP。

## 三道刹车

1. **每日上限 30 次**（`BILI_COMMENT_LIKE_MAX_PER_DAY`）
2. **最小间隔 2 秒**（`BILI_COMMENT_LIKE_MIN_GAP_MS`）
3. **风控冷却**：返回 -509 / 12015 / 12035 / 12051 / 12011 时写 `blockedUntil = now + 30min`

超限时**明确返回拒绝**（带 `dailyLimit` / `retryAfterMs`），不做「静默失败」——
静默失败会让模型以为点上了，然后反复重试。

## 验证

白名单单测（在容器里跑）：

```js
import { apply } from '/root/.dsh/surfcore/plugins/surfcore/qq-tool-restrict.mjs';
let guard; apply({ tools: { restrict() {}, guard(fn) { guard = fn; } } });
for (const n of ['mcp__bili__comment_like', 'bili_reply', 'pwsh', 'read'])
  console.log(n, guard({ name: n }) ? 'DENIED' : 'ALLOWED');
```

期望：`mcp__bili__comment_like` / `bili_reply` → ALLOWED，`pwsh` / `read` → DENIED。

端到端（可逆，不对外留痕）：对她的**自己**的一条评论先点赞再取消，两次都应 `code: 0`。

## 边界

- 只做点赞/取消点赞，**不发评论、不发私信、不改配置**。
- 评论内容与点赞对象都由模型决定，仍受 `identity-guard.js` 约束（不在公开面复述私密信息）。
- 点赞**对方可能收到通知**，所以提示词里写了「只在真的觉得好时才用，不要刷」。
