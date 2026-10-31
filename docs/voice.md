# 语音链路

## 一句话

**桥接只认一个 HTTP 契约**（SurfCore 的 voxd 契约），所以「引擎」就是实现这个契约的一个小服务。
当前实现 v2 用微软 Edge TTS（默认），语法上可以一行切到任何 OpenAI 兼容的 `/audio/speech`；
语气标记不再只是停顿，而是真的改语速 / 音高 / 音量。

## 契约（SurfCore 侧，不再改）

```http
POST /v1/speak/file
{"text":"…","format":"wav","sr":24000,"cache":true,
 "character":"xiaoyu","voice":"（可选）",
 "style":{"rate":"+10%","pitch":"+5Hz","volume":"+0%","pauseMs":200,"emotion":"笑"}}

200 OK
content-type: audio/wav
X-Duration-Ms: 1752
X-Cached: 0
X-Engine: edge
X-Segments: 2
<WAV 字节>
```

- `format` 缺省 = 裸 PCM（s16le），`wav` = 标准 WAV；桥接固定传 `wav` + `sr=24000`
- `character` 走角色名映射（`voices.json`），`voice` 直接给引擎的音色 id，两者互斥
- `style` 是**请求级韵律**（SurfCore 的 `ttsKey` 会把它算进缓存键）；
  桥接目前不传，留给自己/脚本精确控制用
- 响应头多两个：`X-Engine`（当前引擎）、`X-Segments`（切了几段）

## 实现（`deploy/voice-edge/server.py`，v2）

```
text
  → 按语气标记切段（每段带自己的 rate/pitch/volume + 前置停顿）
  → 每段：引擎合成 → ffmpeg -ar 24000 -ac 1 → WAV
  → 按停顿拼接成一条 WAV → 写缓存 → 返回
```

- 标准库 `http.server`，无第三方 Web 框架
- 磁盘缓存：`sha1(engine|voice|sr|段内容+韵律)`，默认留 300 条，超出按 mtime 淘汰
- 串行合成（`VOICE_LOCK`）：引擎并发高会被限流
- 失败返回 503 → 桥接映射成 502 → agent 改打字，**不会假装发过语音**
- 引擎挂了 / 段数变多都只影响这一条；服务本身不会因为某个标记崩

## 语气标记 → 韵律

v1 把标记换成逗号（只有停顿）。v2 里标记管的是**它后面那句话**的情绪，停顿插在那句话之前
（真人先吸一口气 / 笑一声，再说话）。表在 `server.py` 的 `PROSODY`，共 21 个：

| 标记 | 效果（语速 / 音高 / 音量） | 前置停顿 |
|---|---|---|
| `[笑]` | +12% / +6Hz / ±0 | 120ms |
| `[笑死]` | +14% / +7Hz / +2% | 100ms |
| `[开心]` `[兴奋]` | +10~14% / +5~7Hz / +4% | 100ms |
| `[叹气]` `[难过]` | -10% / -4Hz / -5% | 350ms |
| `[小声]` | -8% / ±0 / **-30%** | 250ms |
| `[害羞]` `[委屈]` | -5~8% / +2~3Hz / -10~15% | 200~300ms |
| `[无语]` | -8% / -3Hz / -5% | 400ms |
| `[不耐烦]` | +10% / +1Hz / ±0 | 150ms |
| `[认真]` `[平静]` `[温柔]` … | 小幅收 / 中和 | 150~200ms |

不认识的标记会被直接扔掉（不念出来），`[嗯]` 这种只留 200ms 停顿。

> 边界要说清：这**不是真笑**。Edge 没有情感模型，`[笑]` 只能做到「更快更高一点、前面留个拍子」。
> 真笑声得靠语音库里的现成音频（`audio/`）或换火山/CosyVoice。

## 换引擎

`deploy/voice-edge/engine.json` 一个字段：

```jsonc
{ "engine": "edge" }                                  // 默认：微软 Edge TTS，免费
{ "engine": "openai",
  "openai": { "baseUrl": "http://127.0.0.1:8767",
              "model": "tts-1", "voice": "alloy",
              "apiKeyEnv": "VOICE_OPENAI_KEY" } }      // 任何 OpenAI 兼容 /audio/speech
```

- 密钥**只从环境变量读**（`apiKeyEnv` 里写变量名），`engine.json` 里不出现明文
- 临时试另一个引擎不用改文件：`VOICE_EDGE_ENGINE=openai`（环境变量优先）
- 改完重启 voice-edge（`stop.sh && start.sh`），桥接侧零改动
- SurfCore 自己有 `local/cloud` 双路由（`endpoints.local` / `endpoints.cloud`），
  所以也可以两个实例各跑一个引擎，用 `tts.route` 切——两条路都行

## 预热（高频短句零延迟）

`prewarm.py` 把 `voices.json` 的 `prewarm` 清单先合成进缓存：

```sh
python3 prewarm.py                # 20 句，实测 31s 冷启动
python3 prewarm.py --check        # 只看命中，不生成
python3 prewarm.py --extra "别闹,真的假的"
```

之后「嗯」「诶」「在的」这种就是 2ms 命中（vs 现场 1.3~2s）。

## 自检

```sh
python3 selftest.py               # 14 项：契约 / 24k / 缓存 / 分段 / style / 裸 PCM / 400
python3 selftest.py --port 8766   # 灰度实例
```

## 实测数据（Intel Pentium N3520 / 4 核 / 3.9GB）

| 指标 | v1 | v2 |
|---|---|---|
| 单句实际耗时（冷） | 1.6 ~ 2.7 s | 1.3 ~ 2.4 s |
| 段数 | 恒为 1 | 1~N（按标记切，实测 2 段 +470ms 停顿） |
| 单句 CPU | ≈ 0.34 s | ≈ 0.35 s（多段多一次 ffmpeg，可忽略） |
| 常驻内存 | ≈ 39 MB | ≈ 39 MB |
| 缓存命中 | 2ms | 2ms（预热后短语气全命中） |

按 10 条/小时的上限算，最坏情况一小时 ≈ 3.4 秒 CPU，可以忽略。**瓶颈是网络，不是机器。**

## 踩过的坑

1. **跨容器路径**：网关看不到桥接容器的绝对路径 → `文件处理失败: 识别URL失败`。
   修法：record 段改 `base64://`（≤8MB；更大仍走路径）。
2. **Debian 12 装不了 venv**：没有 `python3-venv` 的 ensurepip →
   `pip3 install --user --break-system-packages edge-tts`。
3. **并发限流**：多句同时合成会被微软掐，服务里串行。
4. **采样率对齐**：桥接写 24k，engine 必须真输出 24k，否则变调。
5. **QQ 语音条前会过一次 SILK**：音质溢价被削，别为「高保真」升级引擎，要为「韵律」升级。
6. **v2 拆段后总时长会变**：`[叹气]` 350ms 停顿 + 慢 10%，一条 3 秒的句子可能到 3.6 秒。
   语速上限没加，因为「慢」本来就是语气的目的；嫌长就让 agent 少用标记。

## 语音库（短语气）

除了现场合成，桥接还支持发语音库里的现成音频（`qq_list_voices` 可查）。
部署会在 `surfcore/audio/` 放一批 0.3~1.2 秒的语气词（嗯 / 诶 / 哈哈 / 在的 / 确实 / 草…），
短反应直接发现成的：省合成时间、也更像真人。

> 注意语音库走的是**桥接自己的文件直发**，不经过 voice-edge，所以预热它没有意义——
> 预热针对的是「agent 现场写一句话让它念」这条路。
