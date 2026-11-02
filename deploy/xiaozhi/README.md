# 小智开发板 · 把小鱼接到"第二张嘴"

> 状态：**第一阶段（协议验证）进行中**
> 硬件：自制 ESP32-S3-N16R8 + INMP441（I2S 麦克风）+ MAX98357A（I2S 功放）+ 0.91" OLED(128×32)

## 为什么要做这个

[ROADMAP](../../ROADMAP.md) 里 v0.3 写着「桌宠 / 开发板（ESP32）当第二张嘴」，
长期目标写着「多群/多平台同一人格（QQ / B站 / 桌宠）」。

现在的板子跑的是**官方固件 + 官方服务器**（xiaozhi.me），能对话，但那是"另一个 AI"。
目标是把它指向我们自己的服务器，让回答来自**同一只小鱼**。

## 关键判断：大脑不用重写

SurfCore 里本来就有一套「桌宠」子系统（`plugins/surfcore/lib/pet-*.js`）：

| 已有能力 | 位置 |
|---|---|
| 人格卡 + 记忆卡拼 system prompt，一次 LLM 调用出结果 | `pet-chat.js` |
| 对话写进记忆 inbox（`appendMemoryInboxEvent`） | `pet-chat.js` |
| 主动消息（`proactive()` + `/events` 推送） | `pet-chat.js` / `pet-purpose.js` |
| 合成语音（走 voice-edge，她的音色 + 语气标记） | `pet-chat.js` → `src/voice-tts.js` |
| HTTP 接口：`POST /chat`、`GET /events`、`GET /audio/<key>.wav` | `pet-api.js` |

接口前缀 `/dsh-surfcore/pet-api`，认证 `x-pet-token`（令牌在 `~/.dsh/surfcore/pet/host.json`）。
局域网访问已在 `deploy/patches/0007` 里放开（Host 白名单）。

**所以板子要的"大脑"已经存在**，缺的是：协议适配 + 音频转码 + 主动推送通道。

## 目标架构

```
ESP32-S3（自编译固件，OTA 指向 PC）
   │ WebSocket + Opus 16k / 60ms
   ▼
PC: 本目录 server.mjs（协议适配；后续加 ASR）
   │ 文本
   ▼
iStore: SurfCore pet-api  POST /chat   ← 她的大脑（人格 + 记忆 + LLM）
   │ 回复文本 / WAV(24k, voice-edge)
   ▼
PC: ffmpeg 转 Opus(16k) → 回推设备
```

主动说话：PC 侧轮询 `GET /events`（或 `POST /purpose/run`）→ 拿到她主动想说的话 → TTS → 推给设备。

## 第一阶段：三个验证点 —— **全部通过**（2026-11-02 夜）

**这一步故意不接 ASR、不接 LLM**，只回答三个"能不能"：

| # | 验证点 | 结果 |
|---|---|---|
| ① | 板子能不能连上我们自己的服务器 | ✅ 刷完自编译固件后 OTA 命中 `192.168.31.119:8003`，WS 正常握手 |
| ② | 音频能不能往返 | ✅ 上行 143~151 字节/包（60ms Opus），下行能听到测试音 |
| ③ | **服务端主动推 TTS，板子会不会播** | ✅ **能播**（`/test/push` 触发 → 屏幕显示文字 + 喇叭出声，固件切到 speaking、喇叭使能） |

第 ③ 条是整件事的前提：它过了，"她主动开口"才成立。串口日志证据：

```
I (98278) Application: << 主动推送 #2
I (98298) StateMachine: State: listening -> speaking
I (98358) AudioCodec: Set output enable to true
I (99558) StateMachine: State: speaking -> listening
```

### 真机上踩到的坑（都已在 server.mjs 里注释）

| 坑 | 现象 | 原因 |
|---|---|---|
| **OTA 是 POST 不是 GET** | 板子反复重试、永不连 WS | 固件 `ota.cc:104` `method = data.length() > 0 ? "POST" : "GET"`，带设备信息时用 POST。只写 GET → 404 |
| **OTA 响应不能带 `activation`** | 屏幕顶 6 位激活码，不连 WS | `ota.cc:137` 见到 `activation.code` 就进激活流程 |
| **设备不发 `listen:stop`** | 后端干等"说完了"，板子 9 秒后 code=1006 断开 | `mode=auto` 下结束判断在设备侧，实测没触发 → 服务端要自己兜底（收够 N 包或做 VAD） |
| **回话后设备自动再进聆听** | 不做保护会"嘀嘀嘀"死循环 | 计数要用**本轮**计数并在回完后解除"武装"（`armed`），否则累计计数立刻再次触发 |
| **淡出系数会变负** | 进程启动即崩 `RangeError: 33682` | 最后一帧 `off+i > total` → `(total-n)` 为负 → 振幅被放大出 int16 范围。要 clip |
| Opus 采样率 | — | 设备解码器按**输出 24k** 打开、输入端 16k；发 16k/60ms 包它能正常重采样播出来 |

### 板载 LED 怎么看

`single_led.cc`：**单颗 WS2812，GPIO48，GRB，RMT 驱动**。固件按状态配色：

| 状态 | 颜色 |
|---|---|
| 启动 / 配网 | 蓝灯闪（100ms / 500ms） |
| 待机 idle | **灭** |
| 连接中 | 蓝灯常亮 |
| **聆听** | **红灯**：检测到人声亮红，静默暗红 ← 主人看到的"红色强弱闪" |
| **说话** | **绿灯**常亮 |
| 升级 / 激活 | 绿灯闪 |

想让她用灯表达情绪，有三条路（待定）：
1. 改 `single_led.cc` 的状态配色表（最省事）
2. 加一个 MCP 工具 `self.led.set_color`，让**她自己在回复里控灯**（情绪色）
3. 保留官方配色，只在特定事件（她主动说话）时闪一下

## 第二阶段：还没做

- [ ] ASR（放 PC，用 faster-whisper）
- [ ] 接 pet-api `/chat`（她的大脑：人格 + 记忆）
- [ ] TTS 复用 voice-edge（她的音色）→ 转 Opus
- [ ] 主动推送接到 `/events`（`proactive` 事件 → 播出来）
- [ ] 记忆：板子对话只写摘要（`appendMemoryInboxEvent` 已有）

### 已提前做的两件（2026-11-02 深夜）

| 件 | 做法 |
|---|---|
| **她可以控灯** | 固件加 MCP 工具 `self.led.set_color`（r/g/b 0-255，`clear=true` 交还状态配色）。实现：`Led` 接口加 `SetUserColor/ClearUserColor` 虚函数（默认空实现，不影响别的板子），`SingleLed` 记住用户色并压住状态配色。测试端点 `POST /test/led` |
| **主人能关掉板子** | 后端 `poweredOn` 状态（落盘 `state.json`）+ 网页开关：`http://<PC-IP>:8003/` 点一下就关。关掉后**不听也不说**，板子只剩灯 |

> 总开关的设计动机：主人 PC 不是一直在线，且不是每时每刻都想让她讲话。
> PC 关机 → 板子天然哑掉；PC 开着 → 用网页开关控制。

## 怎么跑

```sh
cd server
npm install
npm start          # 默认 0.0.0.0:8003
```

| 入口 | 用途 |
|---|---|
| `GET /xiaozhi/ota/` | 固件启动时拿 WS 地址（会自动挑局域网 IP） |
| `WS  /xiaozhi/v1/` | 小智协议 v1 |
| `POST /test/push` | 手动触发一次**服务端主动推送**（验证点 ③） |
| `GET /` | 状态：连了几台、收了多少帧 |

环境变量：`PORT`（默认 8003）、`PUBLIC_HOST`（强制指定下发的地址）、`XZ_TOKEN`（留空=不校验）。

## 已经踩到的坑

| 坑 | 说明 |
|---|---|
| **PC 有多块网卡** | 直接取「第一个非 internal 地址」会拿到 tailscale 的 `100.x`，板子连不上。已改成优先 `192.168.*`（并排掉 `192.168.137.*` 这块热点网卡），也可用 `PUBLIC_HOST` 强制 |
| voice-edge 返回的是**裸 PCM**（`audio/L16`） | 不是 WAV，得自己加 44 字节 WAV 头才能给 ffmpeg 处理 |
| 板子上**没有可控 LED** | PWR / TX / RX 是电源和串口指示灯，另有一颗蓝绿双色款同样不受控。状态反馈只能靠那块 OLED |

## 待办

- [ ] **引脚映射**：INMP441（SCK/WS/SD）、MAX98357A（BCLK/LRC/DIN）、OLED（SCL/SDA）各接哪个 GPIO
- [ ] 板型确认：官方固件刷机时选的型号（决定能否直接复用它那套引脚）
- [ ] PlatformIO 固件工程（`firmware/`，等引脚）
- [ ] 接 ASR（放 PC）
- [ ] 接 pet-api `/chat`
- [ ] 主动推送打通（`/events` → TTS → 设备）
