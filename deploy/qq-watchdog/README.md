# qq-watchdog：桥接「假在线、其实聋了」的自愈

## 为什么需要它（2026-11-01 事故）

NapCat 被风控踢下线时，桥接和它的那条 WebSocket 断了（`close code=1006`）。之后：

- 桥接进程活着、控制台端口开着、`/api/status` 里 `connected: true` —— 所有"活着"的判据都通过；
- 但 QQ 消息一条都进不来，**能发不能收**，整整 10.5 小时（13:38 → 00:11）。

桥接自己其实**发现了**，13:48 就打了一行警告：

```
⚠️ SnowLuma 上游不健康：已连接但 10 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）
```

**发现之后什么也没做。** DSH 插件的自愈轮询（`maybeAutoStartBridge`，每 2 分钟）只看
控制台端口在不在、root 对不对、DSH 地址变没变，所以也认为一切正常。

这个脚本补的就是「发现之后怎么办」，而且**不需要改桥接**。

## 判据

```
NapCat 的 HTTP（/get_status）能应答
  AND 桥接 /api/status 的 snowluma 满足任一：
       · connected === false
       · silent === true
       · degraded === true
       · lastPacketAgoMs > 5 分钟
  ⇒ 重启桥接
```

两个刻意的设计：

1. **用 `lastPacketAgoMs` 而不是"有没有新消息"**：NapCat 每 30 秒无条件发一次心跳，
   心跳停了就说明这条链路死了。夜里没人说话时心跳照发，所以不会误判。
2. **先探 NapCat**：NapCat 自己挂了，重启桥接没用、只会让重启次数暴涨。
   这时只记日志，等 NapCat 恢复后的下一次检查再判。

重启动作：先调桥接自己的 `POST /api/restart`（它退出，DSH 插件 2 分钟内拉起）；
拿不到响应就按 `/proc` 找到 `bridge.js` 发 SIGTERM。

**兜底**：如果桥接进程整个不在了、而且超过 4 分钟还没被 DSH 插件的自愈轮询拉起
（那个自愈开关可能在设置里被关掉），脚本会自己 `node src/bridge.js` 起一个。
并发风险可控：桥接有单实例锁和 3100 端口两道闸，抢输的那个自己 `exit(2)`。

频率限制：两次重启至少隔 10 分钟、一小时内最多 4 次（防 NapCat 侧原因导致反复重启）。
日志 `state/qq-watchdog.log`：平时每 30 分钟一行"入站健康"，异常时记录原因与动作，
超过 256KB 轮转成 `.1`。

## 部署

```sh
# 1) 放进容器
docker cp qq-watchdog.py dsh:/root/.dsh/surfcore/qq-watchdog.py
docker exec dsh chmod +x /root/.dsh/surfcore/qq-watchdog.py

# 2) 宿主 cron，每 2 分钟
*/2 * * * * docker exec dsh python3 /root/.dsh/surfcore/qq-watchdog.py >/dev/null 2>&1
```

## 用法（人工排查）

```sh
docker exec dsh python3 /root/.dsh/surfcore/qq-watchdog.py --status   # 打印判据
docker exec dsh python3 /root/.dsh/surfcore/qq-watchdog.py --dry-run  # 只判断不动手
docker exec dsh python3 /root/.dsh/surfcore/qq-watchdog.py --force    # 忽略频率限制立刻重启
```

## 它治不了什么

- **NapCat / QQ 账号自己掉线**：脚本只能记录。掉线时心跳也会停，所以不会误重启桥接。
- **掉线期间丢的消息**：桥接重新连上时会跑 `runHistoryCatchUp('connect')` 尝试补，
  但补历史依赖 NapCat 的 `get_friend_msg_history`，且只补允许的会话（见 `socialV2.history`）。
  这条补历史在 2026-11-01 那次因为「模式就绪晚于 WS open」被跳过了，**还没修**。
- **桥接重启后的空窗（约 100 秒）**：重启期间进来的消息还是会丢（OneBot 推送没有重放）。
  要彻底消灭这个空窗，得在桥接里做"静默时自己重建 WS 客户端"而不是整进程重启——见
  `cases/2026-11-01-qq-inbound-deaf.md` 的「下一步」。
- **"消息到了但被过滤"**：会话白名单、非文本、挂起提问等分支会让消息不进队列。
  脚本看的是心跳，不关心这个；要区分得改桥接加丢弃计数（同上）。
