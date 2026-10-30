# 语音链路

## 一句话

**桥接只认一个 HTTP 契约**（SurfCore 的 voxd 契约），所以「引擎」就是实现这个契约的一个小服务。
当前实现用微软 Edge TTS：算力在微软，本地只做搬运和一次 ffmpeg 转码。

## 契约（SurfCore 侧，不再改）

```http
POST /v1/speak/file
{"text":"…","format":"wav","sr":24000,"cache":true,"character":"xiaoyu","voice":"（可选）"}

200 OK
content-type: audio/wav
X-Duration-Ms: 1752
X-Cached: 0
<WAV 字节>
```

- `format` 缺省 = 裸 PCM（s16le），`wav` = 标准 WAV；桥接固定传 `wav` + `sr=24000`
- `character` 走角色名映射（`voices.json`），`voice` 直接给 edge 音色 id，两者互斥
- 文本里的语气标记 `[笑] [叹气] [小声]…` 会被剥掉换成停顿（Edge 不支持 SSML）

## 实现（`deploy/voice-edge/server.py`）

```
text → 剥语气标记 → edge-tts 合成 mp3（走微软 WSS）→ ffmpeg -ar 24000 -ac 1 → WAV
```

- 标准库 `http.server`，无第三方 Web 框架
- 磁盘缓存：`sha1(voice|sr|text)`，默认留 300 条，超出按 mtime 淘汰
- 串行合成（`VOICE_LOCK`）：edge-tts 并发高会被限流
- 失败返回 503 → 桥接映射成 502 → agent 改打字，**不会假装发过语音**

## 实测数据（Intel Pentium N3520 / 4 核 / 3.9GB）

| 指标 | 数值 |
|---|---|
| 单句实际耗时 | 1.6 ~ 2.7 s（绝大部分是等微软网络） |
| 单句 CPU | ≈ 0.34 s（ffmpeg 0.18s + python 0.16s） |
| 常驻内存 | ≈ 39 MB |
| 空闲 CPU | 0 |
| 单条音频 | 80 ~ 160 KB |
| 缓存上限 | 300 条 ≈ 30 MB |

按 10 条/小时的上限算，最坏情况一小时 ≈ 3.4 秒 CPU，可以忽略。**瓶颈是网络，不是机器。**

## 踩过的坑

1. **跨容器路径**：网关看不到桥接容器的绝对路径 → `文件处理失败: 识别URL失败`。
   修法：record 段改 `base64://`（≤8MB；更大仍走路径）。
2. **Debian 12 装不了 venv**：没有 `python3-venv` 的 ensurepip →
   `pip3 install --user --break-system-packages edge-tts`。
3. **并发限流**：多句同时合成会被微软掐，服务里串行。
4. **采样率对齐**：桥接写 24k，engine 必须真输出 24k，否则变调。
5. **QQ 语音条前会过一次 SILK**：音质溢价被削，别为「高保真」升级引擎，要为「韵律」升级。

## 换引擎怎么换

| 想要 | 换法 |
|---|---|
| 换个 Edge 音色 | 改 `voices.json` 的 `characters`，重启 voice-edge |
| 换成火山引擎大模型 TTS | 新写一个 `/v1/speak/file` 壳，`endpoints.local` 指过去（按字符计费，韵律最好） |
| 换成本地 CosyVoice / GPT-SoVITS | 同上，需要 6GB+ 显存；CPU 上跑太慢 |
| 云端/本地双开 | 两个服务不同端口，`tts.route` 切换（SurfCore 原生支持 local/cloud） |

## 语音库（短语气）

除了现场合成，桥接还支持发语音库里的现成音频（`qq_list_voices` 可查）。
仓库对应的部署会在 `audio/` 放一批 0.3~1.2 秒的语气词（嗯 / 诶 / 哈哈 / 在的 / 确实 / 草…），
短反应直接发现成的：省合成时间、也更像真人。
