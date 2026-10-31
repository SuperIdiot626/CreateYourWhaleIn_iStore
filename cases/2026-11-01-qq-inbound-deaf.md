# 2026-11-01 QQ「只出不进」：桥接假在线 10.5 小时 + 入站看门狗

## 现象

- 小鲸鱼能主动发消息（手机收得到），但主人发过去的消息她**完全没反应**。
- `qq_get_unread_messages` 恒为 `unreadCount: 0`，会话水位不动。
- 网关侧一切正常：`get_login_info` 正常、`get_status: {online:true, good:true}`、端口都在。
- 真相：**消息到了 NapCat（网关历史里查得到），没到桥接** —— 桥接和 NapCat 之间的入站
  WebSocket 已经死了。从 10-31 13:38 到 11-01 00:11，**10 小时 33 分**连心跳都没收到。

## 根因

### 0. 先记住这件事：出站和入站是两条独立通道

```
发出去： bridge → HTTP POST 127.0.0.1:3000 (NapCat OneBot HTTP)     bridge.js:8693-8724
收进来： NapCat → WS 127.0.0.1:3001 → bridge (SnowLumaWebSocketClient)  bridge.js:14967-14971
```

所以「能发」**不能**用来推断「能收」。SnowLuma/NapCat 的 HTTP 先恢复、WS 客户端后恢复时，
结构上必然表现为「只出不进」。本次就是：00:05 出站恢复（`工具统一发送 成功 1/1`），
入站直到 00:40 才恢复。

### 1. WS 断了，进程内再没恢复过

```
13:38:07  ⚠️ token 自愈失败（close code=1006）：连不上 OneBot HTTP API
13:38:08  SnowLuma 错误：Received network error or non-101 status code.
13:48:16  ⚠️ SnowLuma 上游不健康：已连接但 10 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）
```

链路上三条相关代码，看起来"有重连"，实际是个死结：

| 位置 | 代码 | 问题 |
|---|---|---|
| `bridge.js:14967-14971` | `new SnowLumaWebSocketClient({ reconnect: true })` | 重连**委托给 SDK**；半开连接不触发 close，SDK 没有机会 |
| `bridge.js:15120-15124` | `if (wsChanged) { bot.close(); bot.connect() }` | 真正的自重建，但只在 **token 自愈成功**时执行 |
| `bridge.js:15138-15147` | `healTokenIfStale()`：先 `discoverSnowLumaConnection()`（打 HTTP 3000），**失败就 `return`** | token 自愈依赖的正是**同一时刻挂掉的 HTTP API** → 失败后不重试、不重建 |

**结论**：不是"没写重连"，是**重连被 token 自愈的闸门锁死，且完全依赖未经验证的 SDK
`reconnect:true`；失败后只记录日志，永不重试**。

### 2. 健康检测只报警、不行动

代码里有完整的健康模型（`bridge.js:3699-3837`）：`snowlumaHealth` 记录最近事件包时间、
心跳里的 `status.good`、账号在线状态；`SNOWLUMA_SILENCE_WARN_MS`（config 里 600 秒）判定静默，
`setInterval(reportSnowlumaHealth, 30_000)` 每 30 秒评估一次。

它 13:48 确实报了警 —— **但 `reportSnowlumaHealth()` 只 `log()`，不重连、不退出、不通知人。**
唯一的生命周期兜底是 DSH 插件的 `maybeAutoStartBridge`（每 2 分钟），判据只有
「控制台端口在不在、root 对不对、DSH 地址变没变」，一个聋掉的桥接三项全合格。

顺带一个把排查带偏的措辞 bug：`bridge.js:3758-3762` 在 `silent` 分支固定写"**已连接**但 N 分钟
没有收到事件包"，而该分支命中的恰恰是**已经断开**的时候。

### 3. 补历史的补偿没生效（竞态）

`runHistoryCatchUp`（`bridge.js:13257-13504`）在 `bot.on('open')` 之后触发
（`bridge.js:15051-15054`），但它开头有一道闸：

```js
13468  if (currentMode !== 'reserved2' || cfg.socialV2?.enabled === false)
13469    return { ok: true, skipped: 'mode', results: [] };
```

`currentMode` 初值是 `'chat'`，要等 `startDshWatch()`（`bridge.js:15256`）里 `refreshMode()` 才变
`reserved2` —— 而这比 `bot.connect()`（`15176`）晚。WS `open` 早于模式就绪 ⇒ 这次补历史被判
`skipped: 'mode'`。唯一的补偿是账号上线边沿（`3737`），但它同样是边沿触发：第一次心跳若在
模式就绪前到达，`accountOnline` 已经被置 true，**这个边沿就永远用掉了**。

实证：`social-v2.json` 的 `lastHistoryCheckedAt = 10-30 21:43:07`，到 11-01 00:44 仍是它
（中间跨了 27 小时、两次重连），说明补历史确实一次都没跑成。

### 4. 单实例锁有一处空窗（本次没造成后果）

00:37 主人手动起第二个实例时：

```
[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…
00:37:33 桥接已启动… 控制台服务错误: listen EADDRINUSE: 127.0.0.1:3100
[bridge] 控制台端口 3100 已被占用（可能已有实例在运行），退出。
```

第二实例被 3100 占用拦下、自己退出了，**没有变成双实例**。锁为空的原因没查清；
代码里另有一个 TOCTOU 空窗（`bridge.js:1353-1357`：新实例刚拿到锁、还没 listen 时，
另一个进程会把"PID 活着 + 端口空闲"判成过期锁并抢走），但这次没走到那条路。

> 备注：`bridge.log.1` 里 10-30 22:54 起有 620 处**相邻完全重复**的日志行。
> 这更像"启动时 stdout 重定向进 bridge.log + 内部日志也写同一个文件"造成的双写，
> 而不是两个进程（3100 只有一个进程能绑）。**别再拿重复日志当双实例证据。**

## 影响面

- 10.5 小时所有入站 QQ 消息（私聊 + 群）全丢，且**没有任何告警到人**：机器人看起来在线，
  还在按自己的排期写日记、冒泡，主人只会觉得"她不回我"。
- 不花钱、不碰密钥、不写用户数据。
- 静默失败：最坏的一类 —— 日志里有一行 ⚠️，但没有任何人/程序读它。

## 修法

### 已上线（不改桥接、零重启）：外部入站看门狗

`deploy/qq-watchdog/qq-watchdog.py` + 宿主 cron（每 2 分钟）：

```
NapCat HTTP 可达  AND  桥接 /api/status.snowluma 满足任一：
     connected === false / silent === true / degraded === true / lastPacketAgoMs > 5min
  ⇒ POST /api/restart（失败则 /proc 找 bridge.js 发 SIGTERM，由插件 2 分钟内拉起）
     限频：间隔 ≥10 分钟、每小时 ≤4 次
```

为什么是这个判据：NapCat 每 30 秒**无条件**发心跳，心跳停在 5 分钟就说明这条链路死了；
夜里没人说话时心跳照发，所以不会误判。NapCat 自己挂掉时只记录不重启（重启桥接没用）。

为什么选外部看门狗：**不需要重启桥接**今晚就生效，且复用已经验证过的重启链路
（本次 00:09:38 `/api/restart` → 00:11:17 插件拉起，99 秒）。

### 下一步（需要一次桥接重启窗口）：让桥接自己恢复

外部看门狗重启整进程，最坏有约 100 秒空窗（这期间消息照样丢）。根治要改 `src/bridge.js`：

| 优先级 | 改哪里 | 做什么 |
|---|---|---|
| 必须 | `startSnowlumaWatch()` `3829-3837` | 静默超过 90~120 秒 ⇒ `bot.close()` 后重建客户端并 `connect()`（`bot` 要从 `const` 改 `let`，handler 抽成 `wireBot()`），连续失败两次才升级为退出 |
| 必须 | `healTokenIfStale()` `15138-15154` | 自愈失败**不要 return**：起一个 60 秒的独立重试定时器（不受 close/error 边沿约束） |
| 必须 | `runHistoryCatchUp` 触发点 | 在 `bridge.js:3614`（`dshReady && mode==='reserved2'` 首次成立）补一次调用，与 WS open 解耦 |
| 建议 | `acquireLock()` `1343-1388` | 去掉"端口空闲即判过期"的单次采样；改成"PID 存活即认为在跑" |
| 建议 | `handleIncoming` 各 return 分支 | 加限频丢弃计数并在 `/api/status` 暴露，让"没到"和"到了被过滤"可区分 |
| 建议 | `appendSocialV2Message()` `12309` | 按 `messageId` 实时去重（现在只有补历史去重），防客户端重建导致重复回复 |
| 顺手 | `snowlumaHealthSnapshot()` `3758-3762` | `silent` 分支按 `connected` 分开措辞，别再说"已连接" |

## 验证

| 项 | 结果 |
|---|---|
| 看门狗读懂判据 | `--status` → `needRestart:false, silent:false, agoMs:12589, napcatOk:true` |
| 模拟静默 | `QQ_WATCHDOG_SILENCE_MS=800 --dry-run` → 「⚠️ 入站不健康：29 秒没收到任何事件包」，不动手 |
| 健康态心跳日志 | `入站健康（lastPacketAgoMs=29284，NapCat 可达）` |
| cron 真的在跑 | `logread` 里 `00:50:00 crond: USER root pid 6784 cmd docker exec dsh python3 …/qq-watchdog.py` |
| 重启链路是否可靠 | 有现成证据：00:09:38 `POST /api/restart` → 00:11:17 插件 `autoStartBridge` 拉起（`plugin.log` 16:11:16Z），99 秒 |
| 入站确实恢复 | 00:40:43 `消息已入未读：鱼`；`bridge.log` 里 `private@seq164 → 166 → 167 → 168`；`lastIncomingAt = 00:44:17` |
| 补历史没跑成（根因 3 的实证） | `lastHistoryCheckedAt` 停在 10-30 21:43:07 |

## 回滚与残余

- 停用：删掉宿主 crontab 里那行 `*/2 * * * * …qq-watchdog.py`（人肉恢复完全不受影响）。
  crontab 备份 `/root/backups/crontab.bak-20261101-004920`；脚本备份 `/root/backups/qq-watchdog.py.20261101-004914`。
- 残余 1：整进程重启仍有约 100 秒空窗，窗口内消息会丢 → 靠上面"让桥接自己恢复"。
- 残余 2：锁文件曾为空的原因未查清；双实例被 3100 占用拦下，但没有告警级日志。
- 残余 3：补历史的竞态（根因 3）**没修**，所以下次重连后漏掉的消息仍大概率补不回来。
  眼下可以用 `POST /api/socialV2/history-catchup {force:true}` 手动补（本次没做，怕给旧消息
  触发重复回复；主人是自己转发过来的）。
- 残余 4：看门狗只写日志，没有推送给主人（微信/钉钉都没接）。

## 附：对那份《QQ只出不进-故障总结》的核对

| 总结里的说法 | 核对结果 |
|---|---|
| 主因：bridge 的 WS 入站流断了、无自动重连 | ✅ 方向对；准确说法是"重连被 token 自愈闸门锁死，失败后永不重试"（见根因 1） |
| 次因：`/api/restart` 没守护接住，断线 26 分钟 | ❌ 不对：00:09:38 重启 → 00:11:17 插件就拉起了（`plugin.log`/`bridge-supervisor.log`）。"26 分钟"是**这期间本来没人发消息**的误读 |
| 证据：`readThroughSeq` 卡在 162 | ❌ 不能当入站证据：它是**已读水位**（模型看过的 seq），只在模型读消息时前进。恢复后它**还是 162**（`lastUnreadSeq=168`），入站却完全正常 |
| 可能起了两个 bridge 实例 | ⚠️ 不成立：00:37 那个被 `EADDRINUSE` 拦下并自行退出；620 处重复日志是双写artifact。真正的双实例风险来自锁的 TOCTOU 空窗（见根因 4），但本次没发生 |
| 建议加健康检查 / 入站计数 | ❌ 已有：`/api/status.snowluma` 带 `connected/accountOnline/good/lastPacketAgoMs/silent/degraded/hint`。缺的不是"看得到"，是"看到之后有人行动" |
| 建议重启后补历史 | ⚠️ 已有 `runHistoryCatchUp`，但这次因模式就绪竞态被跳过（根因 3）——需要修触发点，不是新增功能 |
| 建议 `/api/restart` 改自重启 | ⚠️ 可选：插件 2 分钟自愈已能接住，只是慢；真正该修的是"别让桥接聋掉" |
| 漏掉的：出站/入站是两条通道 | ✅ 补充：出站 HTTP 3000、入站 WS 3001，"能发"不能推断"能收" |
