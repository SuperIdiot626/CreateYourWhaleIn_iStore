# 桥接补丁

SurfCore 默认假设**桥接和 QQ 网关在同一台机器**（同一份文件系统），所以 `record` 段直接传本地绝对路径。
容器化部署时网关在另一个容器里，看不到这个路径，表现：

```
OneBot send_private_msg 失败: 文件处理失败: 识别URL失败, uri= /root/.dsh/surfcore/state/voice-tts/xxx.wav
```

## 0001-surfcore-record-base64.patch

把 `src/bridge.js` 的 `sendVoiceV2()` 里 record 段改成：

- 文件 ≤ 8MB → `file: 'base64://' + bytes`（跨容器可用）
- 更大 → 仍走路径（base64 会撑大请求体；QQ 语音条实际用不到）

网关侧 OneBot 实现支持 `base64://`（NapCat / SnowLuma 都支持），转 SILK 照旧由网关做。

## 0002-bridge-inbound-selfheal.patch

2026-11-01「聋了 10.5 小时」事故的根治补丁（复盘见 `cases/2026-11-01-qq-inbound-deaf.md`）。
改 5 处，全部围绕「入站断了要自己活过来」：

| # | 位置 | 改动 |
|---|---|---|
| 1 | `startSnowlumaWatch()` + `snowlumaHealth` | 新增**入站停滞自愈**：120 秒收不到任何事件包（NapCat 每 30 秒发心跳）且连续两个检查周期都停滞 ⇒ `bot.close()` 后 1 秒重建连接。SDK 自带的 `reconnect` 只认 `close` 事件，半开连接永远不会触发它 |
| 2 | `healTokenIfStale()` | 自愈失败不再"试一次就永久放弃"：起一个 60 秒的独立重试定时器（原来失败就 `return`，而自愈要打的 HTTP 3000 恰恰同时不可用） |
| 3 | `checkDsh()` 的 `dshReady` / 模式切换分支 | 在「DSH 就绪 + 模式确定为 reserved2」时补一次 `runHistoryCatchUp`。原来补历史挂在 WS `open` 上，而模式就绪晚于 open ⇒ 被判 `skipped:'mode'`，漏的消息再也补不回来 |
| 4 | `acquireLock()` | 「PID 活着 + 端口空闲 ⇒ 锁过期」改成看 `/proc/<pid>/cmdline` 是不是 `bridge.js`。新实例从写锁到真正 listen 之间有十几秒，原逻辑在这个窗口会把锁抢走（双实例隐患） |
| 5 | `snowlumaHealthSnapshot()` | 静默告警的措辞按 `connected` 分开：原来在**已经断开**时也说"已连接但…"，把排查方向带偏 |

附带一个运维钩子：`touch state/force-inbound-rebuild` 可以在 30 秒内手动触发一次重建，
用来验证自愈链路（不需要等真的出事）。

## 0003-bridge-inbound-reconcile.patch

2026-11-01 上午的第二层补丁。起因：0002 的停滞判据看的是 `lastPacketAt`，
而 NapCat **每 30 秒无条件发一次心跳**，心跳会一直刷新它 —— 于是
「WS 连着、心跳在跑、但 NapCat 的 hook 收不到 QQ 数据（`good=false`）」这种
**连着也不通**的故障，0002 判不出来。这一层改用网关自己的历史接口对账：

| # | 位置 | 改动 |
|---|---|---|
| 1 | `noteUpstreamPacket()` + `snowlumaHealth` | 新增 `lastBusinessAt`：只有 `message / notice / request` 算业务事件，心跳不算；`/api/status.snowluma` 多暴露 `lastBusinessAgoMs` / `lastBusinessKind` |
| 2 | `startSnowlumaWatch()` | 新增**入站对账**：连着 + 业务事件静默超过 10 分钟 → `runHistoryCatchUp(force)` 拉一次网关历史，漏掉的消息按 messageId + 水位去重后补进未读并正常唤醒（不是只报警，是直接恢复） |
| 3 | `reportSnowlumaHealth()` | 网关自报 `good=false` 时不再指望重建 WS（治不了），改为立即对账补历史并打一行说明 |
| 4 | `scheduleTokenHealRetry()` | 修日志嵌套：原来是 `retry(retry(retry(...)))` 越套越长 |
| 5 | 运维钩子 | `touch state/force-inbound-reconcile` 30 秒内触发一次手动对账 |

实测（上线当分钟）：启动 90 秒后首跑 `[对账] 从未收到业务事件（心跳仍在），核对网关历史消息… → 无漏消息，入站链路正常`；
手动钩子 30 秒内响应；`/api/status` 已出现 `lastBusinessAgoMs`。

> 仍然的边界：账号被踢、需要扫码这种，任何自愈都救不了，只能人扫码。
> 11-01 01:33 被踢 → 09 小时离线就是这个（NapCat 干等扫码，`3000`/`3001` 全程没开，
> 桥接一直在正确地重试，但没码就没戏）。

## ~~0004-media-normalize.patch~~（已撤回，2026-11-01）

试过一版「把 QQ 动图归一化成 3 帧小 JPEG」的补丁（8MB 上限放宽到 24MB + ffmpeg 抽帧），
主人看过之后决定**不为聊天场景做图像处理**，当天撤回，补丁文件与 `src/media-normalize.js` 都已删除。
只保留一条改进 —— 见下面的 0005。

## 0005-media-oversize-message.patch

2026-11-01：图片/表情**超过大小上限时，把原因说清楚**。

旧行为：取不到就只写一行 `[图片1]（获取失败）`，agent 只能含糊地告诉主人"取不到"；
主人也不知道是图太大、还是网络问题、还是格式不支持。

新行为：`fetchOneBotImage()` 识别"超过大小限制"这一类失败，返回 `{ tooLarge: true }`；
两个消费方（`resolveMediaList` / `fetchMediaData`）把它翻译成
`[图片1（超过 8MB 大小上限，看不了）]`，大小上限按实际配置动态显示。

> 只做这一件事：**不再抽帧、不放宽上限、不为聊天图做任何图像处理**。
> QQ 动图 >8MB 就明确告诉主人"这张太大我看不了"，主人要么发小图，要么算了。

## 怎么打

```sh
cd <surfcore>
git init  # 若不是 git 仓库，先备份
patch -p1 --dry-run < .../0001-surfcore-record-base64.patch   # 先试
patch -p1 < .../0001-surfcore-record-base64.patch
# 0002 是 2026-11-01 的入站自愈补丁；基线是「打完 0001（和 replay 那版本地改动）之后」的 bridge.js
patch -p1 < .../0002-bridge-inbound-selfheal.patch
# 0003 的第二层对账补丁，基线是「打完 0002 之后」的 bridge.js
patch -p1 < .../0003-bridge-inbound-reconcile.patch
# 0005 的超限提示补丁，基线是「打完 0003 之后、没打过 0004」的 bridge.js
patch -p1 < .../0005-media-oversize-message.patch
node --check src/bridge.js
# 重启桥接
```

> ⚠️ 0002 的 `diff` 基线是**这台机器当时线上那份** `bridge.js`（含 0001 与 replay 本地改动），
> 0003 的基线是打完 0002 之后的那份。都不是上游原版。换机器/升级 SurfCore 后先看
> `patch --dry-run` 输出，冲突就按上面的表格手改。
> 容器里没有 `patch` 命令，可以在宿主机或本地打完再 `docker cp` 进去。

## 注意

- 这是**本地补丁**，SurfCore 升级会覆盖 `src/bridge.js`，升级后要重打。
- 打之前备份：`cp src/bridge.js backups/bridge.js.bak-$(date +%s)`。
- 如果哪天桥接和网关同机（Windows 单机部署），这个补丁可以不打。
