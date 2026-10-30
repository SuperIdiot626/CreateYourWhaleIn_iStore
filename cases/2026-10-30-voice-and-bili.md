# 2026-10-30 语音条上线 + B站评论白名单放开

## 现象

1. 小鲸鱼只能打字：`qq_list_voices` 报「语音功能已关闭」，`qq_send_voice` 报「工具未启用」。
2. 她想发 B站评论被拒：`工具 "bili_reply" 不在 QQ 桥接白名单内，已拒绝`。

## 根因

**语音**

- 部署主机是低功耗 x86（无独显），官方两个语音包都装不了：
  本地包要 NVIDIA 6GB+，云端包要火山引擎复刻音色 + 密钥。
- `socialV2.voice.enabled / tts.enabled / tools.sendVoice` 全是 false，也没有 voxd 服务在 8765。

**B站评论**：两道闸同时关着。

- 工具面白名单（`qq-tool-restrict.mjs` 的 `SAFE_EXACT`）只放了 B站只读工具，
  `bili_reply` 不在里面 → 执行期 guard 直接拒（就是主人看到的「不在桥接白名单」）。
- 插件自己的闸：`commentOn = autoComment && mentionName && dmMode !== 'only'`，
  实际是 false / 空 / `only` → 就算过了守卫也会被插件拒。

## 修法

1. 新引擎 `voice-edge`：实现 `POST /v1/speak/file` 契约，edge-tts 合成 → ffmpeg 转 24k 单声道 WAV，
   监听 `127.0.0.1:8765`；`start.sh` 守护循环 + 宿主机 cron 每分钟兜底。
2. `config.json`：`voice.enabled` / `tts.enabled` / `tools.sendVoice` 打开，`character=xiaoyu`；
   触发闸门保持「仅主人 / 2 条每分钟 / 10 条每小时」。
3. 桥接 `sendVoiceV2`：网关在另一个容器，看不到本容器绝对路径 → record 段改 `base64://`（≤8MB）。
4. `qq-tool-restrict.mjs`：`SAFE_EXACT` 加 `bili_reply`（只解这一只）。
5. 插件配置：`autoComment=true`、`mentionName=<B站昵称>`、`dmMode=both`。
6. 预设 `qq-chat-v2` 第 16 条重写（口语稿 / 40 字 / 拆 1~3 条 / 语气标记 / 失败不假装），
   重建 patch。
7. 语音库 `audio/` 放 12 条短语气。

## 验证

| 项 | 结果 |
|---|---|
| 契约测试（3 句） | 200 + 标准 WAV + `X-Duration-Ms`，首包 1.4~2.7s |
| 端到端语音 | `/api/voice/send` 两次均 `verified=true`（现场合成 1 条 + 语音库 1 条） |
| 工具白名单单测 | `bili_reply => ALLOWED`；`pwsh => 拒绝` |
| 配置生效 | `/api/voice/rules` → `aiEnabled=true, route=local, triggerWho=owner` |

## 回滚

- 备份都在 `backups/`：`config.json.bak-voice-on-*`、`config.json.bak-comment-on-*`、
  `qq-tool-restrict.mjs.bak-bili-reply-*`、`bridge.js.bak-voice-base64-*`、`agent.cordis.yml.bak-voice-*`。
- 关语音：`voice.enabled / tts.enabled / tools.sendVoice` 置 false → 重启桥接。
- 关评论：白名单删 `bili_reply` + `autoComment=false` → 重启 DSH。

## 残余

- 尚未验证：QQ 真实对话里她**自发**发语音 / 发评论（要真机对话）。
- 音色是 Edge 的 `XiaoyiNeural`，一般；想换只改 `voices.json` 或换引擎。
- 桥接的 base64 是本地补丁，升级 SurfCore 会被覆盖。
