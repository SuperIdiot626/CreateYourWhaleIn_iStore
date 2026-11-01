# B站互动 · 独立 MCP server

给 QQ 里的「小鲸鱼」加一套**B站互动**能力：点赞视频、收藏视频、点赞评论、看评论回复、
**想发才发动态**。

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
| `dynamic_post` | **发一条动态**（`dryRun=true` 先彩排） | SurfCore 额度闸（默认 3） |
| `dynamic_list` | 列自己发过的动态（只读，用来拿 id） | — |
| `dynamic_remove` | 删掉自己的一条动态（发错补救） | — |

> **动态不再定时**：SurfCore 自带的「四类动态」每天 8/12/16/20 会各发一条，
> 已用 `config.json` 的 `dynamics.enabled=false` 关掉；现在只有她/主人想发时才发。

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
| **发动态不要自己实现** | `bili.mjs dynamic post` 里有三样自己写必漏的东西：WBI 签名（`w_rid`）、额度闸 `gate({type:'dynamic'})`、**出站身份闸** `assertOutboundIdentitySafe`（拦住把主人 QQ 号/mid 贴到公开面）。工具是 shell 出去调它 |
| `bili.mjs dynamic list` **上游已坏** | 用的是废弃的 `api.vc.bilibili.com/.../space_history`，现在返回 HTML → `JSON.parse` 直接抛错。所以 `dynamic_list` 改成自己查 `x/polymer/web-dynamic/v1/feed/space` |
| 空间列表**不给 DRAW 类动态正文** | 实测 `module_dynamic.desc` 是 `null`，正文只在 `/x/polymer/web-dynamic/v1/detail?id=<id>` 里 → 列表工具逐条补详情 |
| `dynamic rm` 的老接口**还能用** | `api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic` 仍返回 `code=0 成功`，删除继续走 `bili.mjs dynamic rm` |
| **`--dry` 不校验身份闸** | `dynamic.mjs` 的 dry 分支在 `gate`/`assertOutboundIdentitySafe` **之前**就 `exit(0)`。彩排只验 URL/报文，真正的身份拦截发生在真发时（实测含 QQ 号会被拒且不发出） |

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

---

# 附：SurfCore 控制台的 Host 白名单（2026-11-01 修）

## 症状

在 DSH 的 SurfCore 面板里读配置，报 **「读取 token 额度失败：只接受本机回环访问」**。

## 根因

不是鉴权问题，是 `src/bridge.js` 的 **Host 头白名单**太窄。原来按「主机名:端口」精确匹配：

```js
const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`,
  `192.168.31.200:${boundPort}`, `istoreos.tail9fd4a6.ts.net:3101`, `istoreos:3101`];
```

实测这些会 403：`100.112.160.109:3101`、`192.168.31.200:3101`、`istoreos.tail9fd4a6.ts.net`（不带端口）。
报错文案只显示尾巴「只接受本机回环访问」，很容易误判成 token/鉴权问题（其实前面还有一句
「Host 头不被允许（<实际 Host>）」，界面上被截掉了）。

## 修法

改成**按主机名判断、不卡端口**，放过本机自己的名字与所有网卡地址；外部域名仍拒（DNS rebinding 防护不破）：

```js
const hostNameOnly = String(hostHeader).replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
const allowedHostNames = new Set(['127.0.0.1', 'localhost', '::1', String(os.hostname() || '').toLowerCase(),
  'istoreos', 'istoreos.tail9fd4a6.ts.net']);
for (const list of Object.values(os.networkInterfaces()))
  for (const addr of list || []) if (addr?.address) allowedHostNames.add(String(addr.address).toLowerCase());
if (!allowedHostNames.has(hostNameOnly)) { /* 403 */ }
```

补丁脚本：`DSH/scripts/patch-bridge-host-whitelist.py`（仓库外，属本机运维材料）

## 验证（在容器里跑）

```
127.0.0.1:3100                 -> 200
istoreos.tail9fd4a6.ts.net:3101 -> 200
100.112.160.109:3101           -> 200   ← 修之前 403
192.168.31.200:3101            -> 200   ← 修之前 403
istoreos.tail9fd4a6.ts.net     -> 200   ← 修之前 403（不带端口）
evil.example.com:3100          -> 403   ← 仍然拒（防护有效）
```

## 重启桥接的注意事项

`bridge.js` 是 DSH 插件拉起的子进程，**改完必须重启它**。注意：

- 容器里**没有 `pkill`**，要用 `kill -9 <pid>`
- 重启时插件和宿主机 cron 的 `qq-watchdog.py`（每 2 分钟）会**各拉一次**，
  容易留下多个进程抢 3100 端口 —— 旧的占着端口、新的抢不到，于是「改了代码却没生效」。
  实测出现过 3 个并存；**必须确认只剩一个、且启动时间晚于文件修改时间**。
- 判断方法：`ls -l --time-style=+%H:%M:%S src/bridge.js` 对比进程启动时间。

## ⚠️ 另一个观察：控制台现在绑 0.0.0.0

上游 `bridge.js` 是 `server.listen(port, '0.0.0.0')`；本机曾经打过补丁改成只绑 `127.0.0.1`
（靠 tailscale serve 转发）。今天重启后变回 `0.0.0.0` —— 也就是**局域网内能直接访问 3100**。
仍有 token + Host 白名单两道，但比原来松。要恢复回环硬化，把它改回 `'127.0.0.1'` 即可。
