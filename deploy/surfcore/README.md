# B站互动 · 独立 MCP server

给 QQ 里的「小鲸鱼」加一套**B站互动**能力：点赞视频、收藏视频、点赞评论、看评论回复。

「发评论」不在这里 —— 它走插件自带的 `bili_reply`（那边有语感闸和判重表，别绕过）。

## 为什么单独做一个 MCP

| 方案 | 结论 |
|---|---|
| 往 `dsh-bili-scroll` 插件里加工具 | 插件在 `profiles/web/node_modules/` 下，任何 npm/pnpm 重装都会冲掉；还要同时改 `vendor/bilibili-mcp/mcp_server.py` + `index.js` 两处 |
| 改 `bili-duty/mcp_server.py` | **会失效**：`state.mjs` 每次挂载从 vendor 覆盖，改了被冲掉 |
| **独立 MCP server（本方案）** | 跟已有的 `mcp-qzone.js` / `mcp-host-server.js` 同形态；只碰 `src/` 新文件 + 两处配置 |

## 工具

文件：`mcp-bili.js` → 部署到 `/root/.dsh/surfcore/src/mcp-bili.js`

| 工具（前缀 `mcp__bili__`） | 作用 | 每日上限 |
|---|---|---|
| `video_like` | 给视频点赞 / 取消（`status=false`） | 30 |
| `video_fav` | 收藏视频 / 移除（可指定 `folder`，默认进「默认收藏夹」） | **3**（移除不占额度） |
| `comment_like` | 给评论点赞 / 取消 | 30 |
| `comment_replies` | 读某条评论下的楼中楼（只读） | — |
| `received_replies` | 看「谁回复了我 / 谁 @了我」（只读） | — |

公共行为：

- 凭据读 `/root/.dsh/surfcore/bili/credentials.json`（与 `bili.mjs` 同一份，600 权限）
- 点赞类动作有 **2 秒最小间隔**，收藏 3 秒；撞风控码自动冷却 **30 分钟**
- 超限**明确报错**（带 `retryAfterMs` / `dailyLimit`），不静默失败 —— 静默失败会让模型反复重试
- 状态落在 `bili/action-state.json`，按北京时间切日

## 踩过的接口细节

| 坑 | 说明 |
|---|---|
| **视频取消点赞是 `like=2`** | `POST /x/web-interface/archive/like` 里 `1`=点赞、`2`=取消，**不是 0**（评论点赞才是 0/1） |
| 收藏要 `rid`=aid | `POST /x/v3/fav/resource/deal`，`rid`=aid、`type=2`、`add_media_ids` / `del_media_ids` 二选一 |
| 收件箱字段不可信 | `/x/msgfeed/reply` 的 `item.title` 不总是新回复正文，要确认内容得用 `root`/`parent` 配 `comment_replies` 回读楼层 |
| 19 位 id 丢精度 | 动态 id 超过 JS 安全整数，`JSON.parse` 会截断；优先从 `item.uri` 里取字符串 id |
| 楼中楼会回吐 root | 没有子回复时 `/x/v2/reply/reply` 把 root 自己塞回来，工具里已过滤 |

## 部署步骤

### 1. 放文件

```sh
cp mcp-bili.js /root/.dsh/surfcore/src/mcp-bili.js
```

### 2. 注册 MCP — `/root/.dsh/profiles/web/cordis.patch.yml` 末尾追加

```yaml
# === bili MCP (video like / fav / comment like / replies) ===
- insert:
    - id: mcp-bili
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: bili
        transport: stdio
        command: '/usr/local/bin/node'
        args:
          - '/root/.dsh/surfcore/src/mcp-bili.js'
        toolCallTimeoutMs: 30000
```

> `serverName: bili` 决定前缀 → `mcp__bili__*`。
> ⚠️ 不要塞进 `qq-bridge MCP BEGIN/END` 区块，那段会被 `scripts/setup-dsh.mjs` 整体重写。

这一步**不用重启容器**：DSH 会热重载并拉起新的 MCP 子进程（实测保存后几秒内生效）。

### 3. 加白名单 — `/root/.dsh/surfcore/plugins/surfcore/qq-tool-restrict.mjs`

```js
const SAFE_PREFIXES = [
  'mcp__qzone__',
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  'mcp__bili__',        // ← 加这条（一条覆盖全部 5 个工具）
]
```

> ## ⚠️ 改完必须重启 `dsh` 容器，热重载**不够**
>
> 2026-11-01 实测踩到：改了这个文件后 DSH 确实热重载了（日志里 `[qq-tool-restrict]` 重新打印），
> 但**模型调用新工具仍被拒**。原因是 DSH 的热重载只重新执行插件的 `apply()`，
> **不会让 Node 的 ESM 模块缓存失效** —— `SAFE_PREFIXES` 还是进程启动那一刻加载的旧值。
>
> 判断依据：`dsh web` 进程 10-30 22:50 启动、白名单 11-01 11:08 才改，
> 期间重载多次但守卫一直是旧版；重启进程后立刻正常。
>
> ```sh
> docker restart dsh
> ```
>
> **重启会杀掉容器里跑的 PT announce 中转**（`/root/.dsh/im/pt-work/announce_bridge.py`，
> 85 个种子指着它），必须手动拉回来：
>
> ```sh
> docker exec -d dsh sh -c 'cd /root/.dsh/im/pt-work && nohup python3 announce_bridge.py 8899 >> bridge.out 2>&1 &'
> ```
>
> 重启后 `bridge.js`（DSH 自己拉起）、`voice-edge`（每分钟 cron 兜底）会自动回来，
> **只有这个中转需要手动补**。

## 验证

```sh
# MCP 子进程起来了
docker exec dsh sh -c 'for d in /proc/[0-9]*; do tr "\0" " " < $d/cmdline | grep -q "mcp-bili.js" && echo "$d alive"; done'
```

白名单单测（容器里跑）：

```js
import { apply } from '/root/.dsh/surfcore/plugins/surfcore/qq-tool-restrict.mjs';
let guard; apply({ tools: { restrict() {}, guard(fn) { guard = fn; } } });
for (const n of ['mcp__bili__video_like', 'mcp__bili__video_fav', 'mcp__bili__comment_like',
                 'mcp__bili__comment_replies', 'mcp__bili__received_replies', 'pwsh', 'read'])
  console.log(n, guard({ name: n }) ? 'DENIED' : 'ALLOWED');
```

端到端（全部可逆，测完立刻撤）：对同一支视频
`video_like(true)` → `video_like(false)`、`video_fav(true)` → `video_fav(false)`、
`comment_like(true)` → `comment_like(false)`，四次都应 `code: 0`。

## 升级注意

| 文件 | 会不会被覆盖 |
|---|---|
| `src/mcp-bili.js` | 新文件，`npm install` 不会删，一般安全 |
| `profiles/web/cordis.patch.yml` | qq-bridge 段会被 setup-dsh 重写；本块在段外，通常保留但要复查 |
| `plugins/surfcore/qq-tool-restrict.mjs` | **会**（属于 surfcore 包）→ 白名单丢 `mcp__bili__` |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 提示词 | **会** |

升级后按上面三步重贴一遍，再跑验证。
