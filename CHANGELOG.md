# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
