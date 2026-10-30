# voice-edge：给 SurfCore 用的免费语音引擎（edge-tts 版 voxd）

SurfCore 的语音子系统只认一个 HTTP 契约（`POST /v1/speak/file`，见 `docs/guides/SUBSYSTEM-VOICE.md §4`）。
这个目录就是该契约的最小实现：**文字 → edge-tts 合成 mp3 → ffmpeg 转 24k 单声道 WAV**。

## 为什么需要它

家里那台服务器（iStoreOS，x86_64，无独显）跑不了官方两个语音包：

- 本地包要 NVIDIA 显卡（6G+）→ 没有；
- 云端包要火山引擎的复刻音色 ID + 密钥 → 没配。

但 SurfCore 只要求"能按契约返回音频"，不关心后端是谁。于是用微软 Edge TTS（免费）兜底，
先把「像人发语音条」这条链路跑通；以后想换更好的音色，只替换这个壳即可，桥接侧零改动。

## 部署（容器内）

```sh
# 1) 依赖（Debian 12 的 PEP668：装到 root 的 user site，不动系统 python）
pip3 install --user --break-system-packages edge-tts

# 2) 拷文件 + 启动（带守护循环：崩了 3 秒后自动拉起）
mkdir -p /root/.dsh/voice-edge
#   server.py / voices.json / start.sh / stop.sh 放进去
chmod +x start.sh stop.sh server.py
./start.sh

# 3) 宿主机 cron 兜底（容器重启后自动拉起）
* * * * * docker exec dsh sh -c "/root/.dsh/voice-edge/start.sh" >/dev/null 2>&1
```

## SurfCore 侧配置（config.json）

```jsonc
"socialV2": {
  "tools": { "sendVoice": true },
  "voice": {
    "enabled": true,
    "tts": {
      "enabled": true,
      "route": "local",
      "character": "xiaoyu",                    // voices.json 里的角色名
      "endpoints": { "local": "http://127.0.0.1:8765" }
    },
    "trigger": { "who": "owner" }
  }
}
```

改完 `tts.*` / `endpoints` 要重启桥接（内存配置）。

## 契约细节

| 项 | 说明 |
|---|---|
| `POST /v1/speak/file` | `{text, format, sr, cache, character, voice, style}` |
| 返回 | `format=wav` → 标准 WAV；缺省 → 裸 PCM(s16le) |
| 响应头 | `X-Duration-Ms`、`X-Cached`、`X-Voice` |
| 语气标记 | `[笑] [叹气] …` 会被剥掉并换成停顿（Edge 不支持 SSML） |
| 缓存 | 按 `voice|sr|text` 落盘，默认留 300 条 |
| 音色 | `characters` 映射（xiaoyu→XiaoyiNeural）或直接传 edge 音色 id |

## 踩过的坑

1. **跨容器路径**：SnowLuma/NapCat 跑在另一个容器里，桥接传本地绝对路径会得到
   `文件处理失败: 识别URL失败`。→ 桥接已改为把音频以 `base64://` 塞进 record 段
   （`src/bridge.js` 的 `sendVoiceV2`，≤8MB 走 base64，更大仍走路径）。
2. **venv 建不起来**：Debian 12 没有 `python3-venv` 的 ensurepip → 用 `pip3 --user --break-system-packages`。
3. **edge-tts 并发**：高并发会被限流，服务里用 `VOICE_LOCK` 串行合成。
