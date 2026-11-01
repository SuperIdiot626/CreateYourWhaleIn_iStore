# B站评论区点赞 · 独立 MCP server

给 QQ 里的「小鲸鱼」加一条**评论区点赞 / 取消点赞**的能力。
「发评论」早就有了（插件 `bili_reply`，2026-10-30 放开），这里补齐的是点赞。

## 为什么单独做一个 MCP

| 方案 | 结论 |
|---|---|
| 往 `dsh-bili-scroll` 插件里加工具 | 插件在 `profiles/web/node_modules/` 下，任何 npm/pnpm 重装都会冲掉；而且得同时改 `vendor/bilibili-mcp/mcp_server.py` + `index.js` 两处，`state.mjs` 每次挂载还会把 vendor 覆盖回来 |
| 改 `bili-duty/mcp_server.py` | **会失效**：`state.mjs` 每次挂载从 vendor 覆盖，改了被冲掉 |
| **独立 MCP server（本方案）** | 跟已有的 `mcp-qzone.js` / `mcp-host-server.js` 同一个形态；只碰 `src/` 下新文件 + 两处配置，升级影响面小 |

## 文件

`mcp-bili-comment.js` → 部署到 `/root/.dsh/surfcore/src/mcp-bili-comment.js`

它做的事：

- 工具 `comment_like`：给一条视频评论点赞 / 取消点赞
  - 接口：`POST https://api.bilibili.com/x/v2/reply/action`（`{oid, type=1, rpid, action=1|0, csrf}`）
  - 凭据：`/root/.dsh/surfcore/bili/credentials.json`（与 `bili.mjs` 同一份，600 权限）
  - `bvid` 会给一次 `web-interface/view` 解析成 `aid`；也可以直接传 `oid`
- 自带两道刹车（防止模型连点被 B站 风控）：
  - 每天最多 30 次（`BILI_COMMENT_LIKE_MAX_PER_DAY` 可覆盖）
  - 两次之间至少 2 秒（`BILI_COMMENT_LIKE_MIN_GAP_MS` 可覆盖）
  - 撞到风控码（-509 / 12015 / …）自动冷却 30 分钟，状态落在 `bili/comment-like.json`

## 部署步骤（三步）

### 1. 放文件

```sh
cp mcp-bili-comment.js /root/.dsh/surfcore/src/mcp-bili-comment.js
```

### 2. 注册 MCP — `/root/.dsh/profiles/web/cordis.patch.yml` 末尾追加

```yaml
# === bili comment MCP (comment like) ===
- insert:
    - id: mcp-bili
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: bili
        transport: stdio
        command: '/usr/local/bin/node'
        args:
          - '/root/.dsh/surfcore/src/mcp-bili-comment.js'
        toolCallTimeoutMs: 30000
```

> `serverName: bili` 决定工具名前缀 → `mcp__bili__comment_like`。
> ⚠️ 不要塞进 `qq-bridge MCP BEGIN/END` 区块里，那段会被 `scripts/setup-dsh.mjs` 整体重写。

### 3. 加白名单 — `/root/.dsh/surfcore/plugins/surfcore/qq-tool-restrict.mjs`

```js
const SAFE_PREFIXES = [
  'mcp__qzone__',
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  'mcp__bili__',        // ← 加这条
]
```

改完**不需要重启容器**：DSH 会热重载 profile 配置并拉起新的 MCP 子进程
（实测保存后几秒内 `ps` 里就能看到 `mcp-bili-comment.js`）。

## 验证

```sh
# 1) MCP 子进程起来了
docker exec dsh sh -c 'for d in /proc/[0-9]*; do tr "\0" " " < $d/cmdline | grep -q mcp-bili-comment && echo "$d alive"; done'

# 2) 白名单放行了
#    （单元测试脚本见 docs/bili-comment.md 的「验证」段）

# 3) 真机：在 QQ 里让她「给这条评论点个赞」
```

`comment_like` 成功返回：

```json
{ "ok": true, "action": "like", "rpid": "...", "oid": "...", "code": 0,
  "todayLikes": 1, "dailyLimit": 30 }
```

## 升级注意

SurfCore 升级**会覆盖**这些手改点（跟交接单里记的已知坑同类）：

| 文件 | 会不会被覆盖 |
|---|---|
| `src/mcp-bili-comment.js` | 新文件，一般保留；`npm install` 不会删 |
| `profiles/web/cordis.patch.yml` | **会**（setup-dsh 重写 qq-bridge 段；本块在段外，通常保留但要复查） |
| `plugins/surfcore/qq-tool-restrict.mjs` | **会**（属于 surfcore 包） |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 的提示词 | **会** |

升级后跑一遍上面的验证，缺哪项补哪项。
