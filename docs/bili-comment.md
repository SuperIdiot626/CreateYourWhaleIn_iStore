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
