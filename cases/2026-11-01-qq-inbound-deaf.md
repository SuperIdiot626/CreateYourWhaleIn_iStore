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

### 已上线（2）：桥接内部自愈（`deploy/patches/0002-bridge-inbound-selfheal.patch`）

外部看门狗重启整进程，最坏有约 100 秒空窗（这期间消息照样丢）。所以当天又改了 `src/bridge.js`：

| # | 改哪里 | 做了什么 | 状态 |
|---|---|---|---|
| 1 | `startSnowlumaWatch()` + `snowlumaHealth` | 入站停滞自愈：120 秒没有事件包（NapCat 每 30 秒发心跳）且连续两周期停滞 ⇒ `bot.close()` → 1 秒后重建连接。SDK 的 `reconnect` 只认 `close` 事件，半开连接永远不触发它 | ✅ 已上线 |
| 2 | `healTokenIfStale()` | 自愈失败改成"60 秒后独立重试"，不再试一次就永久放弃（原来失败就 `return`） | ✅ 已上线 |
| 3 | `checkDsh()` 的 ready / 模式切换分支 | 「DSH 就绪 + 模式确定 reserved2」时补一次 `runHistoryCatchUp`，与 WS `open` 解耦 | ✅ 已上线 |
| 4 | `acquireLock()` | 锁过期判据改看 `/proc/<pid>/cmdline` 而不是端口（消除"新实例还没 listen 就被抢锁"的 TOCTOU） | ✅ 已上线 |
| 5 | `snowlumaHealthSnapshot()` | 静默告警措辞按 `connected` 分开，不再"断开还说已连接" | ✅ 已上线 |
| — | 运维钩子 | `touch state/force-inbound-rebuild` 30 秒内触发一次手动重建（验证自愈链路用） | ✅ 已上线 |

上线与验证（01:00）：

```
00:59:59 入站停滞看门狗已启动（120 秒收不到事件包即判停滞，连续两个周期才重建）
00:59:59 SnowLuma 已连接：ws://127.0.0.1:3001
01:00:00 [history] private:1078820859 补回 0 条群友消息 / 2 条自己的旧消息（dsh-ready）
01:00:29 🧪 收到手动重建信号（state/force-inbound-rebuild），立即重建连接
01:00:29 🔄 重建 SnowLuma WebSocket 客户端（手动触发）
01:00:29 SnowLuma 连接断开（code=1000），重连中…
01:00:30 SnowLuma 已连接：ws://127.0.0.1:3001
01:00:30    重建后已重新连接
```

- 补历史从"被 `skipped:'mode'` 跳过"变成真的跑了（只补回 2 条自己的旧消息，水位去重正常，
  没有把 23:59 那批旧消息重灌——`historyWatermark` 取 `lastIncomingAt` 与 recent 时间的最大值）。
- 手动重建整链路 1 秒完成：close→自愈→reconnect→`connected:true`、`lastPacketAgoMs` 恢复为秒级。
- 换文件重启期间入站空窗只有几秒（新进程 00:59:59 起来），锁与 3100 端口交接正常。

### 还值得做的

| 优先级 | 做什么 |
|---|---|
| 建议 | `handleIncoming` 各 return 分支加限频丢弃计数并在 `/api/status` 暴露，让"没到"和"到了被过滤"可区分 |
| 建议 | `appendSocialV2Message()` 按 `messageId` 实时去重（现在只有补历史去重），防客户端重建导致重复回复 |
| 可选 | `/api/restart` 做成软重启（只重建 WS + DSH 事件流，不退出进程），彻底消除 ~100 秒空窗 |

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

- 停用看门狗：删掉宿主 crontab 里那行 `*/2 * * * * …qq-watchdog.py`（人肉恢复完全不受影响）。
  crontab 备份 `/root/backups/crontab.bak-20261101-004920`；脚本备份 `/root/backups/qq-watchdog.py.20261101-004914`。
- 回滚桥接补丁：容器内 `/root/backups/bridge.js.bak-before-selfheal-20261101-005951`
  （以及更早的 `bridge.js.bak-pre-watchdog-20261101-005728`）。`cp` 回去 → 重启桥接即可。
  补丁本体在 `deploy/patches/0002-bridge-inbound-selfheal.patch`。
- 残余 1：**SurfCore 升级会覆盖 `src/bridge.js`**，这 5 处要重打（见 patches/README.md 的表格）。
- 残余 2：整进程重启（外部看门狗那条路）仍有约 100 秒空窗；内部自愈不重启进程，
  所以只有在"连 WS 都重建不起来"时才会走到那条路。
- 残余 3：锁文件曾为空的原因未查清；不过抢锁判据已经改成看命令行，这类隐患基本堵上了。
- 残余 4：看门狗只写日志，没有推送给主人（微信/钉钉都没接）。
- 残余 5：23:59–00:07 那批消息**永久丢了**（补历史的水位已过它们；主人自己转发过来补上的）。
  以后再出现同类静默，补历史能在恢复时把窗口内的消息捞回来。

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
