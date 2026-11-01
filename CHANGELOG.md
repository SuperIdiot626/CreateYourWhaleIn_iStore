# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **B站评论区点赞**：小鲸鱼现在能在评论区给评论点赞 / 取消点赞（`mcp__bili__comment_like`）。
  走独立 MCP server（`deploy/surfcore/mcp-bili-comment.js`），不碰插件 node_modules；
  带每日上限 30 次 + 最小间隔 2 秒 + 撞风控自动冷却 30 分钟。发评论仍走原有 `bili_reply`。
  说明见 [docs/bili-comment.md](docs/bili-comment.md)，部署见
  [deploy/surfcore/README.md](deploy/surfcore/README.md)。

### Fixed

- **部署机主机名被 Tailscale MagicDNS 抢走**：同一台机器在局域网和 tailnet 里的名字只差大小写，
  Tailscale 把短别名写进 Windows hosts，导致按短名访问 SMB 报 `0x80070035`（流量去了 tailnet
  地址，而 Samba 只绑 LAN）。修法：LAN 名与 tailnet 全名都在 hosts 里固化，并关掉该机的
  MagicDNS。根因链与验证见 [cases/2026-10-31-istoreos-smb-access.md](cases/2026-10-31-istoreos-smb-access.md)。

## [0.2.7] - 2026-11-01

发码不再动容器：先走 NapCat WebUI 的轻刷新，失败才退回重启。

### Changed

- `deploy/qq-ops/qq-ops.py` 的 `--send-qr` 变成两级：
  1. **轻刷新**：`POST /api/QQLogin/RefreshQRcode` 让 NapCat 的登录服务当场重吐一张码
     （不重启容器、**不走"快速登录"**，1~2 秒完成）；
  2. 轻刷新失败才退回 `docker restart napcat`（约 20 秒，会多一次快速登录尝试）。
- 新增 `--probe-webui` 排障模式：验证 WebUI 鉴权与登录态。

### Notes

- 主人提的顾虑成立：重启 NapCat 会先发一次必然失败的"快速登录"，等于多敲一次门，风控上不划算。
  轻刷新直接让登录服务重出码，避开了这一步。
- NapCat WebUI 的鉴权不是直接传 token：`POST /api/auth/login {"hash": sha256(token + ".napcat")}`
  → 拿到 base64 签名 Credential → 之后 `Authorization: Bearer <Credential>`（1 小时有效）。
  WebUI 端口配置写 6099，运行时可能被挑成别的（当前 6101），脚本从启动日志里读。
- 轻刷新路径**还没在"掉登录"状态下实测过**（她当时在线，接口回 `QQ Is Logined`）；
  但它失败会自动退回重启，所以功能不会因这条新路径挂掉。

## [0.2.6] - 2026-11-01

按主人要求收紧：**不重复提醒**，发码**每次现场生成**，不再复用容器里的旧码。

### Changed

- `deploy/qq-ops/qq-ops.py`：
  1. 删掉「每 30 分钟提醒一次」的逻辑——被踢只发一条说明，之后静默等你回「发码」；
  2. `--send-qr` 不再判断"现成码够不够新"：**每次都 `docker restart napcat`**，
     等它在这轮重启后吐出全新二维码（≤90 秒）再推图。

### Notes

- 为什么不再复用现成码：实测 NapCat 掉登录后只吐一张码就停住（9 小时离线窗口里
  `二维码已保存` 只出现 1 次），而 QQ 的码约 2 分钟失效 ⇒ 容器里那张基本都是废码。
  "每两分钟自动出新码"的印象来自 QQ 二维码的有效期，以及旧看门狗 10-30 反复重登时的告警刷屏，
  并非 NapCat 会自动刷新。
- 平时完全不碰 NapCat：只有「发码」那一刻才重启它出新码。

## [0.2.5] - 2026-11-01

被踢改成**两段式发码**：先只说明，等主人确认手边方便扫再出码，码不再白过期。

### Changed

- `deploy/qq-ops/qq-ops.py`：
  1. 掉线时**只推说明**（「方便扫码时说一声『发码』」），不再自动附码；
  2. 新增 `--send-qr`：人工确认后出码——现成的码够新（<150 秒）就直接用，
     不够新就 `docker restart napcat` 逼它重新出码（等 ≤90 秒），再放大推微信；
  3. 掉线期间每 30 分钟提醒一次（最多 3 次），确认后不再提醒；
  4. 上线时清掉待扫码状态。
- 新增 `deploy/qq-ops/qq-send-qr.sh`（宿主 wrapper）与 `weixin-note.md`
  （微信那只大肥鱼的 `AGENTS.md` 里加的「值班小工具」段：主人说「发码」→ 跑这条命令）。

### Notes

- 两段式的意义：码只有约 2 分钟有效期，自动推送很可能在你没看手机时就过期；
  人工确认后现出码，几乎每次都能扫上。
- 确认渠道：微信回「发码」/ GUI 里说一声 / 自己在 iStore 终端跑 wrapper，三选一。

## [0.2.4] - 2026-11-01

被踢之后别再「无码、没人知道」：宿主机侧抓码推微信 + 被踢频率监控。

### Added

- **`deploy/qq-ops/qq-ops.py`**（宿主 cron，每分钟）：
  1. QQ 掉线时读出 NapCat 刚生成的二维码（<180 秒才算新码）→ ffmpeg 放大 480 →
     **微信直接推图**，扫一下就能恢复；旧的「掉线（无码）」文本从此不会出现；
  2. 被踢频率：最近 6 小时掉线 ≥2 次 → 推「这个号被盯上了，考虑换小号」（6 小时最多一条）；
  3. 在线但桥接没连上 OneBot（假在线/聋了）→ 推提醒（30 分钟最多一条）；
  4. 首次运行从 `qq-alerts.log` 捡历史掉线时间做种子。
- 实测：`--test-text` 微信文字成功；图片推送链路 `wx-notify.mjs image` 返回 `ok:true`；
  宿主 cron 在 10:46 实际执行（`logread` 可见）。

### Removed

- **删掉 `lagrange` 容器**：同一 QQ 号的第二套非官方协议客户端（C#/.NET 实现），
  10-30 起过一次就一直 `All login failed` 崩着（`restart=unless-stopped` 有被拉起来抢账号的风险）。
  同一账号两套客户端来回切只会加重风控。

### Notes

- QQ 的「设备身份」存在宿主机挂载 `/mnt/sata1-4/napcat/qq`（= 容器的 `/app/.config/QQ`），
  **重启容器不会变**；只有删容器/清这个目录才会被当成新设备。11-01 扫码不再提示新设备就是这个原因。
- 被踢是这类非官方协议的固有代价，代码层面躲不掉；能优化的是「踢了以后多快恢复」。

## [0.2.3] - 2026-11-01

补上第一层自愈的盲点：心跳会把「停滞」判据喂饱，于是「连着也不通」发现不了。

### Added

- **桥接补丁 `deploy/patches/0003-bridge-inbound-reconcile.patch`**：
  1. `snowlumaHealth.lastBusinessAt`：只有 `message/notice/request` 算业务事件（心跳不算），
     `/api/status.snowluma` 暴露 `lastBusinessAgoMs`；
  2. **入站对账**：连着但业务事件静默 >10 分钟 → 拉一次网关历史，漏掉的消息按
     messageId + 水位去重后补进未读并正常唤醒（既能发现也能恢复，不是只报警）；
  3. `good=false` 时改为立即对账补历史（重建 WS 治不了 hook 坏）；
  4. 修掉 `retry(retry(retry(...)))` 日志嵌套；
  5. 运维钩子 `touch state/force-inbound-reconcile`，30 秒内响应。
- 实测：启动 90 秒首跑 `[对账] … 无漏消息，入站链路正常`；手动钩子 30 秒内响应。

### Notes

- **自愈的边界**：账号被踢/需要扫码只能人扫码。11-01 01:33 被踢 → 到 10:27 扫码为止离线 9 小时，
  期间桥接每 2.5 分钟正确重试、微信通知发过「掉线（无码）」，但抓码链路没把二维码推出来，
  `qq-notify` 的"无码"是下一个要修的点。

## [0.2.2] - 2026-11-01

让桥接自己活过来：入站静默时**进程内**重建 WebSocket，不用等整进程重启。

### Added

- **桥接补丁 `deploy/patches/0002-bridge-inbound-selfheal.patch`**（5 处改动）：
  1. 入站停滞自愈：120 秒没有事件包（NapCat 每 30 秒心跳）且连续两周期停滞 ⇒
     `bot.close()` → 1 秒后重建连接。SDK 的 `reconnect` 只认 `close` 事件，半开连接永远不触发；
  2. `healTokenIfStale()` 失败后 60 秒独立重试（原来试一次就永久放弃，而自愈要打的
     HTTP 3000 恰恰同时不可用）；
  3. 补历史触发点移到「DSH 就绪 + 模式确定为 reserved2」，不再被 `skipped:'mode'` 吞掉；
  4. 单实例锁改成看 `/proc/<pid>/cmdline`，消除"新实例还没 listen 就被抢锁"的 TOCTOU；
  5. 静默告警措辞按 `connected` 分开，不再"断开还说已连接"。
- 运维钩子：`touch state/force-inbound-rebuild` 30 秒内手动触发一次重建，用来验证自愈链路。

### Notes

- 实测：手动重建 1 秒完成（close→自愈→reconnect），补历史首次真正跑通
  （`[history] … 补回 0 条群友消息 / 2 条自己的旧消息（dsh-ready）`，水位去重正常）。
- 换文件重启桥接时空窗只有几秒；外部看门狗仍是兜底（内部自愈失败时才会走整进程重启）。
- SurfCore 升级会覆盖 `src/bridge.js`，这 5 处要重打，见 `deploy/patches/README.md`。

## [0.2.1] - 2026-11-01

修「能发不能收」：桥接聋了 10.5 小时，自己知道，但没人（也没程序）去救。

### Added

- **入站看门狗 `deploy/qq-watchdog/`**：宿主 cron 每 2 分钟检查一次
  `NapCat 可达 + 桥接 /api/status.snowluma 静默/断线/降级` → 调 `/api/restart`
  （失败则按 `/proc` 找 `bridge.js` 发 SIGTERM，由 DSH 插件 2 分钟内拉起）。
  限频 10 分钟一次、每小时 4 次。判据用 `lastPacketAgoMs`（NapCat 每 30 秒无条件发心跳），
  夜里没人说话不会误判；NapCat 自己挂掉时只记录不重启。

### Notes

- 桥接**本来就有**健康检测（`snowlumaHealth`，10 分钟静默告警，`bridge.js:3699+`），
  缺口是"发现之后没有动作"——不是没有观测。
- 出站走 HTTP 3000、入站走 WS 3001，是两条通道；「能发」不能推断「能收」。
- 真正根治要改桥接（静默时主动重建 WS 客户端、补历史触发点与模式就绪解耦），
  见 [cases/2026-11-01-qq-inbound-deaf.md](cases/2026-11-01-qq-inbound-deaf.md)。
- 复盘纠正了一份外部故障总结里的四处理解（次因不成立、`readThroughSeq` 不是入站指标、
  健康接口与补历史都已有、重复日志不是双实例）。

## [0.2.0] - 2026-10-31

让她的语气真的能听出来，以及「换引擎」从口号变成一行配置。

### Added

- **语气标记 → 韵律**：`[笑] [叹气] [小声]` 等 21 个标记不再只是逗号，
  而是语速 / 音高 / 音量 / 前置停顿四项。实现方式是按标记分段合成再拼接
  （Edge 不接受 SSML，单次请求只能有一组全局参数）。
- **引擎可切换**：`engine.json` 里 `engine: "edge" | "openai"`；openai 兼容层直接套
  任何 `/audio/speech`（火山 / CosyVoice / 自建），密钥只从环境变量读。
  环境变量 `VOICE_EDGE_ENGINE` 优先，方便临时试听。
- **预热**：`prewarm.py` 把 `voices.json` 的 `prewarm` 清单（20 句高频短语气）预生成进缓存，
  冷启动 31s，之后命中 2ms——「嗯」「诶」不再等 1.5 秒。
- **自检**：`selftest.py` 14 项断言（契约 / 24k 单声道 / 缓存 / 分段 / `style.rate` / 裸 PCM / 错误码）。
- 响应头加 `X-Engine`、`X-Segments`（老字段和行为全保留）。

### Notes

- 契约没变：SurfCore / 桥接 / 预设零改动。
- 分段会让句子变长（`[叹气]` = 慢 10% + 350ms），预设里仍限「一条 1~2 个标记」。
- `engine=openai` 只用契约验证过，没接真实云端密钥；真接时要补实测。

## [0.1.0] - 2026-10-30

第一次让「小鲸鱼」有嘴、能去 B站 留言。

### Added

- **语音引擎 `voice-edge`**：实现 SurfCore 的 voxd 契约（`POST /v1/speak/file`），
  edge-tts 合成 + ffmpeg 转 24k 单声道 WAV；带守护循环与宿主机 cron 兜底。
- **语音条上线**：`socialV2.voice` / `tts` / `tools.sendVoice` 打开；仅主人触发，
  2 条/分钟、10 条/小时。
- **发语音的说话规则**：预设 `qq-chat-v2` 第 16 条重写——口语稿、40 字内、拆 1~3 条短的、
  语气标记 1~2 个、语音库短语气优先、失败不假装。
- **语音库短语气**：`audio/` 放 12 条语气词（嗯 / 诶 / 哈哈 / 在的 / 确实 / 草…）。
- **B站评论放开**：桥接工具白名单加 `bili_reply`；插件侧 `autoComment` / `mentionName` /
  `dmMode=both` 打开。
- **仓库**：角色卡、架构、语音链路、B站闸门、ADR、部署脚本、案例记录。

### Fixed

- **跨容器发语音失败**：网关在另一个容器看不到桥接的绝对路径
  （`文件处理失败: 识别URL失败`）→ record 段改 `base64://`（≤8MB）。
- **Debian 12 装不了 venv**：改用 `pip3 --user --break-system-packages`。

### Notes

- Edge TTS 免费但没有 SLA；挂了只会退回打字。
- 桥接的 base64 补丁是本地补丁，上游 SurfCore 升级会覆盖，见 `deploy/patches/`。
- B站评论真正的风险是账号风控，`commentPerRound` 保持 1。
