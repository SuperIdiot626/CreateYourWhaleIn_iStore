# 架构

## 进程与容器

典型部署是一台低功耗 x86 主机（如 iStoreOS / OpenWrt 系）上的三个容器 + 一个 agent：

| 组件 | 跑在哪 | 职责 |
|---|---|---|
| `napcat` / SnowLuma | 独立容器 | QQ 协议网关，OneBot v11（WebSocket + HTTP），负责收发消息、SILK 转码 |
| `dsh` | 独立容器 | DeepSeek Harness：agent 运行时、Web GUI、SurfCore 插件、桥接进程 |
| `voice-edge` | 与桥接**同一个**容器 | 文字 → 音频（voxd 契约，监听 `127.0.0.1:8765`） |
| DSH agent 会话 | dsh 容器内（in-process） | 按预设 + 人格卡生成回复，决定打字还是说话 |

> ⚠️ 桥接与网关**不同容器**这个事实很关键：桥接拿到的是自己容器里的绝对路径，网关看不到。
> 语音条因此必须走 `base64://`（见 `deploy/patches/0001-surfcore-record-base64.patch`）。

## 一次「她说话」的完整链路

```
1. 你在 QQ 发消息
2. NapCat → OneBot WS → 桥接（dsh 容器）
3. 桥接把消息拼成 prompt → DSH 会话（含预设 + 人格卡 + 记忆卡）
4. agent 决定：打字 / 发语音
5. 发语音：qq_send_voice(text="…")
   → 桥接 POST http://127.0.0.1:8765/v1/speak/file
   → voice-edge: edge-tts 合成 mp3 → ffmpeg 转 24k 单声道 WAV
   → 桥接读字节 → base64 → OneBot record 段
6. NapCat 收 base64 → 转 NT SILK → 发 QQ 语音条
7. 桥接 get_msg 回读 record 段 → verified=true 才算落地
```

## 两个「黑盒」边界

- **语音引擎**：桥接只认 `POST /v1/speak/file` 一个契约，后端随便换 → 可替换性高。
- **QQ 网关**：桥接只认 OneBot v11，换成别的实现（NapCat 官方版、Lagrange）也行。

## 改哪里要重启什么

| 改动 | 生效方式 |
|---|---|
| `config.json` 的 `socialV2.voice.*`（tts/trigger/endpoints） | 重启**桥接** |
| `qq-tool-restrict.mjs`（工具白名单） | 重启 **DSH**（guard 在会话启动时注册） |
| `dsh/agent-presets/*.yml`（预设提示词） | 改完 `node scripts/build-agent-preset-patches.mjs` 重建 patch → 重启 DSH |
| 人格卡（`roles/*.md`） | 即时（桥接每条消息注入） |
| `voice-edge` 代码 | 重启 voice-edge（`start.sh` 自带守护循环） |

## 安全闸门（都在桥接/预设里，不靠提示词自觉）

1. **发送白名单**：所有 QQ 发送目标必须在 `allow.groups / allow.private`。
2. **语音触发**：`trigger.who = owner`，只认主人；主人在最近 10 分钟内说过话才放行。
3. **频率**：语音 2 条/分钟、10 条/小时；B站评论每轮 1 条。
4. **工具面**：QQ 会话只能看到 MCP 工具 + B站工具白名单，`pwsh`/`read` 这类通通拒绝。
5. **不可逆动作**：改配置、发动态、发私信仍然不在 QQ agent 的白名单里。
