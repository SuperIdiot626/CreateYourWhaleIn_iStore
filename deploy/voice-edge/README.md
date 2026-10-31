# voice-edge：给 SurfCore 用的免费语音引擎（voxd 契约，Edge 默认 + 可切引擎）

SurfCore 的语音子系统只认一个 HTTP 契约（`POST /v1/speak/file`，见 `docs/guides/SUBSYSTEM-VOICE.md §4`）。
这个目录就是该契约的实现：**文字 → 按语气标记分段 → 引擎合成 → ffmpeg 转 24k 单声道 WAV → 拼接**。

## 为什么需要它

家里那台服务器（iStoreOS，x86_64，无独显）跑不了官方两个语音包：

- 本地包要 NVIDIA 显卡（6G+）→ 没有；
- 云端包要火山引擎的复刻音色 ID + 密钥 → 没配。

但 SurfCore 只要求"能按契约返回音频"，不关心后端是谁。于是用微软 Edge TTS（免费）兜底，
先把「像人发语音条」这条链路跑通；以后想换更好的音色，改 `engine.json` 或替换这个壳即可，桥接侧零改动。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | v2 服务本体：分段、韵律、缓存、HTTP |
| `engine.json` | 引擎（`edge` / `openai`）+ 韵律基准；**不含密钥** |
| `voices.json` | 角色名 → 音色 id 映射 + 预热清单 `prewarm` |
| `start.sh` / `stop.sh` | 守护循环（崩了 3 秒拉起）与进程组停止 |
| `prewarm.py` | 预热高频短句进缓存（`--check` 只查命中） |
| `selftest.py` | 14 项契约自检（契约 / 24k / 缓存 / 分段 / style / 裸 PCM / 错误码） |

## 部署（容器内）

```sh
# 1) 依赖（Debian 12 的 PEP668：装到 root 的 user site，不动系统 python）
pip3 install --user --break-system-packages edge-tts

# 2) 拷文件 + 启动（带守护循环：崩了 3 秒后自动拉起）
mkdir -p /root/.dsh/voice-edge
cp server.py engine.json voices.json prewarm.py selftest.py start.sh stop.sh /root/.dsh/voice-edge/
chmod +x /root/.dsh/voice-edge/{start,stop}.sh /root/.dsh/voice-edge/*.py
cd /root/.dsh/voice-edge && ./start.sh

# 3) 预热高频短句（可选，20 句约 30 秒）
python3 prewarm.py

# 4) 自检
python3 selftest.py

# 5) 宿主机 cron 兜底（容器重启后自动拉起）
* * * * * docker exec dsh sh -c "/root/.dsh/voice-edge/start.sh" >/dev/null 2>&1
```

升级时：`cp` 覆盖代码 → `./stop.sh && ./start.sh` → `python3 selftest.py`。
旧版本先备份（`cp server.py /root/backups/voice-edge-server.py.bak-v1-<时间戳>`）。

## 引擎

`engine.json`：

```jsonc
{ "engine": "edge" }          // 默认，免费，无需密钥
```

```jsonc
{ "engine": "openai",         // 任何 OpenAI 兼容的 /audio/speech
  "openai": {
    "baseUrl": "http://127.0.0.1:8767",
    "model": "tts-1",
    "voice": "alloy",
    "apiKeyEnv": "VOICE_OPENAI_KEY",   // 只写变量名，密钥放环境变量
    "format": "mp3"
  } }
```

- 环境变量 `VOICE_EDGE_ENGINE` 优先于文件（临时试听用）
- `engine=openai` 这条路是**契约级兼容**，接具体厂商（火山 / CosyVoice / 自建）时按厂商实际接口填
  `baseUrl/model/voice`；它返回什么格式都行，服务统一用 ffmpeg 转 24k 单声道
- SurfCore 自己的 `local/cloud` 双路由（`endpoints.local` / `endpoints.cloud`）也可以两个实例各跑一个引擎

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

改完 `tts.*` / `endpoints` 要重启桥接（内存配置）。改 voice-edge 自己不用动桥接。

## 契约细节

| 项 | 说明 |
|---|---|
| `POST /v1/speak/file` | `{text, format, sr, cache, character, voice, style}` |
| 返回 | `format=wav` → 标准 WAV；缺省 → 裸 PCM(s16le) |
| 响应头 | `X-Duration-Ms`、`X-Cached`、`X-Voice`、`X-Engine`、`X-Segments` |
| 语气标记 | `[笑] [叹气] …` → 语速/音高/音量/停顿（21 个，见 `server.py` 的 `PROSODY`） |
| `style` | 请求级韵律覆盖：`rate` / `pitch` / `volume` / `pauseMs` / `emotion` |
| 缓存 | 按 `engine|voice|sr|段内容+韵律` 落盘，默认留 300 条 |
| 音色 | `characters` 映射（xiaoyu→XiaoyiNeural）或直接传引擎音色 id |

## 踩过的坑

1. **跨容器路径**：SnowLuma/NapCat 跑在另一个容器里，桥接传本地绝对路径会得到
   `文件处理失败: 识别URL失败`。→ 桥接已改为把音频以 `base64://` 塞进 record 段
   （`src/bridge.js` 的 `sendVoiceV2`，≤8MB 走 base64，更大仍走路径）。
2. **venv 建不起来**：Debian 12 没有 `python3-venv` 的 ensurepip → 用 `pip3 --user --break-system-packages`。
3. **edge-tts 并发**：高并发会被限流，服务里用 `VOICE_LOCK` 串行合成。
4. **分段会拖长时长**：`[叹气]` = 慢 10% + 350ms 停顿。标记滥用会让人觉得在念诗，
   所以预设里限「一条 1~2 个标记」。
5. **`[笑]` 不是真笑**：Edge 没有情感模型，只能做到更快更高 + 前置拍子。
   真笑声去 `surfcore/audio/` 放现成音频，用 `qq_list_voices` 发。
