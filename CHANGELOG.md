# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- **部署机主机名被 Tailscale MagicDNS 抢走**：同一台机器在局域网和 tailnet 里的名字只差大小写，
  Tailscale 把短别名写进 Windows hosts，导致按短名访问 SMB 报 `0x80070035`（流量去了 tailnet
  地址，而 Samba 只绑 LAN）。修法：LAN 名与 tailnet 全名都在 hosts 里固化，并关掉该机的
  MagicDNS。根因链与验证见 [cases/2026-10-31-istoreos-smb-access.md](cases/2026-10-31-istoreos-smb-access.md)。

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
