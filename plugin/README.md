# dsh-xiaojingyu-tools · 小鲸鱼工具组

给 **SurfCore 上的小鲸鱼**（QQ 群友）用的 DSH 插件：**只提供工具 + 一个设置页，自己不主动做事**。

- 没有定时器、没有「每天刷一轮」、没有日报、没有私信监听 —— 什么时候用，由 agent 自己决定。
- B站 能力全部由本插件用 **纯 Node** 实现：不需要 Python venv，不需要 `bilibili_api`。
- 工具名保持 `bili_*`，与 SurfCore 的 QQ 桥接白名单（`SAFE_EXACT`）兼容，迁移时白名单不用改。

## 为什么有它

原来小鲸鱼 的 B站 工具来自第三方插件 `dsh-bili-scroll`（MIT，作者 c1overzz）。
那个插件同时带了一整套"自主行为"（定时刷、日报、私信监听、Python MCP、venv）。
我们只想要**工具**，不想要它替我们决定什么时候动 —— 所以自己写了一个。

> 工具名与参数与 `dsh-bili-scroll` 保持兼容，**实现是独立的**（没有复制它的代码）。
> 需要它的完整"刷一轮/日报"能力时，仍然可以回到那个插件。

## 工具

### 只读（`readTools`，默认开）

| 工具 | 参数 | 说明 |
|---|---|---|
| `bili_whoami` | — | 登录的是谁（mid/昵称/是否有效） |
| `bili_search` | keyword, num≤50, order | 搜视频 |
| `bili_subtitle` | bvid | 字幕全文（没有字幕会明说） |
| `bili_comments` | bvid, num≤100 | 热门评论 |
| `bili_cover` | bvid | 封面图（缩到 `coverWidth`，默认 512） |
| `bili_frames` | bvid, num≤6, at[] | 故事板抽帧（480×270） |

### 登录 / 状态（`loginTools`，默认开）

| 工具 | 说明 |
|---|---|
| `bili_login_start` | 出二维码 PNG（存 `$DSH_HOME/whale-tools/`），返回 key |
| `bili_login_poll` | waiting / scanned / ok / expired；成功时从 `Set-Cookie` 取凭据（`data.url` 里没有 SESSDATA，这是参考实现踩过的坑），buvid3 缺时补一次 nav |
| `bili_status` | 登录态、凭据时间、今日写操作计数、工具组开关 |

### 写操作（`writeTools` / `dynamicTools`，**默认关**）

P2 迁移中：`bili_reply`、`bili_video_like`、`bili_video_fav`、`bili_comment_like`、
`bili_comment_replies`、`bili_received_replies`、`bili_dynamic_*`。
每个动作都有每日额度 + 最小间隔 + 撞风控冷却（`lib/limits.mjs`）。

## 设置

设置页字段全部是 volatile（改完立刻生效，不用重启）：

| 分组 | 字段 |
|---|---|
| 工具组 | `readTools` / `loginTools` / `writeTools` / `dynamicTools` |
| 写闸门 | `commentEnabled`、`mentionName`、`commentPerDay=3`、`likePerDay=30`、`favPerDay=3`、`dynamicPerDay=3`、`minGapMs=2000`、`cooldownMin=30` |
| 只读偏好 | `searchOrder`、`coverWidth=512`、`framesMax=6`、`subtitleMaxChars=20000`（模块内硬上限 20000，设更大无效） |
| 凭据 | `credentialsPath`（默认 `/root/.dsh/surfcore/bili/credentials.json`） |

## 挂载

profile 的 `package.json` 里加依赖与 bundle，profile 的 `cordis.patch.yml` 里加一行：

```yaml
- id: whale-tools           # 必须叫这个（设置页命名空间 = loader entry id）
  name: dsh-xiaojingyu-tools
  config: {}                # 可省，缺省值见 cordis.patch.yml
```

## 凭据

`/root/.dsh/surfcore/bili/credentials.json`，字段 `sessdata / bili_jct / buvid3 / dedeuserid`，
权限 600。`bili_login_poll` 成功后写入；不要把它提交进仓库。

## 许可

MIT（本仓库）。参考了 `dsh-bili-scroll` 的工具契约（MIT，c1overzz），实现独立；
它自己的 `duty.md` 章程、日报模板、提示词等**没有**被复制。
