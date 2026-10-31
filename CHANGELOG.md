# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
