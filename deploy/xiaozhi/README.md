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

## 第二阶段：整条链路跑通（2026-11-02 深夜）✅

```
板子（麦克风）→ Opus 上行
     ↓ VAD（asr.mjs，能量+自适应底噪）
  本地 ASR（asr_server.py，faster-whisper small/int8，~2s）
     ↓ 文字
  她的大脑（iStore: SurfCore pet-api `/chat`，modality=voice，~3-4s）
     ↓ 回复文字 + 她的语音 WAV（voice-edge，24k）
  转码（xiaoyu.mjs：24k→16k、线性重采样、Opus 60ms/包）
     ↓ Opus 下行
板子播放（她自己的声音）
```

真机实测两轮（2026-11-02 23:3x）：

```
[VAD] 一句话结束：1260ms（底噪 836）
[ASR] 识别(1994ms) → 「你在干什么呢」
[BRAIN] (4328ms) → 「没干嘛，就趴在你桌面角上待着呢，看你。你呢，忙完了没？」
[TTS] WAV 293KB → 102 包 Opus（6.1s）
第二轮: ASR 1642ms / BRAIN 2749ms / 播放 5.2s
```

### 三个服务怎么起

| 服务 | 命令 | 端口 |
|---|---|---|
| ASR | `py -3.10 -u asr_server.py` | 8004（只绑回环） |
| 小智后端 | `node server.mjs` | 8003（局域网） |
| 她的大脑 | iStore 上已在跑（SurfCore） | 192.168.31.200:3080 |

后端读 `server/pet.env.json`（**已 gitignore**）里的 `{base, token}`，令牌取自
iStore 的 `~/.dsh/surfcore/pet/host.json`。

### 已知问题 / 可优化

| 问题 | 说明 |
|---|---|
| **首字延迟 ~6s** | ASR 2s + 她 4s（pet-api 是"想完 + 合成完"才返回）。想快得让 voice-edge 对局域网开放、按句流式合成 |
| ASR 会误听（"天气"→"听起"） | small 模型；可换 medium（慢一倍）或加 `initial_prompt` 提示词 |
| 设备持续推音频 | `mode=auto` 连续对话行为；VAD 在服务端兜底 |
| 主动说话还没接 | 需要固件保持长连接 + 轮询 pet-api `/events` |

### 已提前做的两件（2026-11-02 深夜）

| 件 | 做法 |
|---|---|
| **她可以控灯** | 固件加 MCP 工具 `self.led.set_color`（r/g/b 0-255，`clear=true` 交还状态配色）。实现：`Led` 接口加 `SetUserColor/ClearUserColor` 虚函数（默认空实现，不影响别的板子），`SingleLed` 记住用户色并压住状态配色。测试端点 `POST /test/led` |
| **主人能关掉板子** | 后端 `poweredOn` 状态（落盘 `state.json`）+ 网页开关：`http://<PC-IP>:8003/` 点一下就关。关掉后**不听也不说**，板子只剩灯 |

> 总开关的设计动机：主人 PC 不是一直在线，且不是每时每刻都想让她讲话。
> PC 关机 → 板子天然哑掉；PC 开着 → 用网页开关控制。

## 待办

- [ ] **主动说话**：固件保持长连接 + 轮询 pet-api `/events`（她自己决定说不说）
- [ ] **延迟优化**：voice-edge 开放到局域网 + 按句流式合成
- [ ] **LED 情绪色**接进回复流程（现在工具通了，还没让她用）
- [ ] **记忆摘要**：板子对话只写摘要（`appendMemoryInboxEvent` 已有，摘要在 SurfCore 侧补）
- [ ] ASR 换 medium / 加 initial_prompt 提升中文准确率

## 怎么跑

```sh
cd server
npm install

# 1) ASR（PC 本地，模型加载约 18 秒）
py -3.10 -u asr_server.py        # 127.0.0.1:8004

# 2) 小智后端（另开一个窗口）
node server.mjs                  # 0.0.0.0:8003
```

| 入口 | 用途 |
|---|---|
| `GET /` | **总开关页面**（手机也能开）：点一下关掉她 |
| `GET /status` | JSON 状态：设备数、开关、收包 |
| `POST /api/power` | `{"on":false}` 关 / `{"on":true}` 开 |
| `POST /test/push` | 手动触发一次服务端主动推送 |
| `POST /test/led` | `{"r":255,"g":140,"b":0}` 控制板载灯；`{"clear":true}` 交还默认配色 |
| `GET /xiaozhi/ota/` | 固件启动时拿 WS 地址（自动挑局域网 IP） |
| `WS /xiaozhi/v1/` | 小智协议 v1 |

环境变量：`PORT`、`PUBLIC_HOST`（强制下发地址）、`XZ_TOKEN`（留空=不校验）、
`PET_BASE`/`PET_TOKEN`（也可写 `server/pet.env.json`）。


## 已经踩到的坑

| 坑 | 说明 |
|---|---|
| **PC 有多块网卡** | 直接取「第一个非 internal 地址」会拿到 tailscale 的 `100.x`，板子连不上。已改成优先 `192.168.*`（并排掉 `192.168.137.*` 这块热点网卡），也可用 `PUBLIC_HOST` 强制 |
| voice-edge 返回的是**裸 PCM**（`audio/L16`） | 不是 WAV，得自己加 44 字节 WAV 头 |
| **`pet.env.json` 不能带 BOM** | PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，Node 的 `JSON.parse` 直接抛错 → 令牌读成空、报"没配令牌"。代码里已 strip BOM，写文件时也注意 |
| **端口占用** | 旧后端没退干净就起新的会 `EADDRINUSE`，表现为"改了代码不生效"。先 `Get-NetTCPConnection -LocalPort 8003` 看谁占着 |
| **VAD 阈值必须封顶** | 原来阈值 = 底噪×3 且不封顶。播完她的语音后麦克风收到扬声器残留，底噪基线被抬高 → 阈值升到人声之上 → 表现就是"一直聆听中、怎么喊都不触发"。改成 底噪×1.8 且封顶 2200 |


---

# 第三阶段：双模式 + QQ 可控输出（2026-11-03 凌晨）✅

**目标变了**：主人认为"板子当输入设备"不如"板子当 QQ 的嘴"有价值 —— 聊天回 QQ，板子只负责出声。

## 双模式（独立按键切换）

| 模式 | 连谁 | 行为 |
|---|---|---|
| 普通小智 | 官方 `api.tenclass.net` | 原厂行为，语音对话 |
| 小鱼的嘴 | 我们（PC:8003） | 常连、**不用麦克风**、只播推送 |

切换：**GPIO40（自接按键）长按 2 秒** → 写/清 NVS 的 `wifi/ota_url` → 重启。
判据在固件 `IsMouthOnlyMode()`；官网 OTA 地址仍是编译默认值，所以"清空 = 官方"。

## 链路

```
QQ 里的她 ──board_say──> iStore：(voice-edge 合成她的声音) ──WAV──> PC 后端 /speak
                                                                      ↓ 转 Opus
                                                                    板子播放 + 屏幕显示文字
```

板子离线时后端排队（最多 5 条），下次连上自动播。

## 真机验证（2026-11-03 01:10）

- 听到她的声音 ✅
- 屏幕显示正确中文 ✅（之前是 URL 编码乱码，已修）

## 这一阶段踩的坑

| 坑 | 根因 | 修法 |
|---|---|---|
| 切模式后重启又变回去 | `Settings::SetString` 只置 dirty_，commit 在析构；`esp_restart()` 不走析构 | Settings 放内层作用域，析构后再重启 |
| 按一次切两次 | 手指跨过重启，新一轮开机又触发长按 | 等按键松开再重启 + 开机 5 秒内忽略 |
| 长按 BOOT 进配网并崩溃 | 原厂 BOOT 短按在 Starting 阶段进配网；长按松手被当成短按 | 改用独立按键，Starting 阶段忽略短按 |
| 屏幕显示 `%E8...` | 中文 URL 编码后塞进 HTTP 头，后端当文本推给板子 | 后端 decode + 工具端先截断再编码 |
| 日志说播了但没声 | 死 socket 残留，播放推到旧连接 | 同设备只留最新连接 + 心跳 + 取最近活跃 |

> 完整交接（按键、起服务、固件改动清单、剩余待办）见
> `DSH/notes/2026-11-03-xiaozhi-board-handoff.md`

---

# 第四阶段：A/B/C/D 收尾（2026-11-03 凌晨）

主人在睡前的最后一批需求，全做完。

## A. 她能控灯 ✅

新工具 `mcp__board__board_led(r,g,b,clear)` → 后端 `/led` → 设备 MCP `self.led.set_color`。
提示词里写了用途：暖黄=开心、暗蓝=困了，可以用完交还默认配色。

## B. 板子的 MCP 工具桥 ✅

板子固件自带 7 个 MCP 工具（设备状态、音量、屏幕主题、灯、灯控），之前她看不见。
现在后端实现了最小 MCP 桥：

```
iStore 工具 board_device_tools / board_device_call
        ↓ HTTP
PC 后端 /device/tools、/device/call
        ↓ WS {"type":"mcp","payload":{jsonrpc,id,method,params}}
板子 McpServer（tools/list、tools/call）
```

实测：列出 7 个工具、调 `self.audio_speaker.set_volume` 返回 `true`。

## C. 屏幕换成小鱼 ✅（已刷机，待主人目视确认）

屏幕原本显示的是 **Noto Emoji 子集字体**里的"圆脸"，那套字体里没有鱼。
所以改成 **LVGL 1bpp 画布程序化画一条鱼**（椭圆身体 + 三角尾巴 + 挖空的眼睛和嘴），
不依赖字体子集：

- `display.h`：加 `virtual bool SetFishIcon(bool)`
- `oled_display.*`：`EnsureFishIcon()` 懒创建画布；`SetFishIcon(true)` 显示小鱼并藏起表情；
  `SetEmotion()` 在 fish 模式下直接返回（不让表情覆盖）
- `application.cc`：纯输出模式开机时 `SetFishIcon(true)`，官方模式 `false`

## D. 主动说话 ✅（实现完成，需白天验证）

后端长轮询 `pet-api /events`（先对齐水位、之后带 `since`），
收到 `type=proactive` 事件就取她的语音（WAV）转 Opus 推给板子；板子没连就进队列。

实测注意：她的「目的机制」有静默时段（`quietStart 23:30 / quietEnd 08:30`），
半夜强制触发会返回 409 —— **这是设计如此**，不是 bug。要验证得白天。

## 这一轮的坑

| 坑 | 说明 |
|---|---|
| `board_status` 判在线写错 | `/status` 的 `devices` 是**数组**，拿它跟 0 比较永远 false → 改成 `j.devices.length` |
| 屏幕 emoji 是子集字体 | 不能假设 `🐟` 存在，自绘更稳 |

---

# 第五阶段：连接稳定性（2026-11-04 凌晨）

上一版有个明显毛病：**每隔约两分钟断一次再重连**。查清了根因并修掉。

## 根因

固件 `Protocol::IsTimeout()`：**120 秒收不到任何数据 → 判定通道超时**。
而她安静的时候后端一条消息都不发 → 板子每 120~130 秒自己判超时、断开、重连。

## 修法（两边一起）

| 侧 | 改动 |
|---|---|
| **后端** | 每 30 秒给设备发一个 `{"type":"ping"}`：固件对未知类型只打一行警告，但会重置那个 120 秒计时器 |
| **固件** | ① 纯输出模式保持 `PERFORMANCE` 电源档（原来会降到 LOW_POWER 开 WiFi 省电，链路更易抖）② 通道关闭时也不降温 ③ 加 `mouth_keepalive` 任务：每 10 秒检查通道，断了自动重连（不再需要手动按 RST） |

## 实测

修前：每 ~130 秒一次 `断开 code=1006` + 新连接。
修后：**5 分钟内零断连**，连接稳定在 1 台；播放正常（`[PLAY] 播完 65 包（约 3.9s）`）。

## 鱼没画出来的原因（2026-11-04 修）

第一次刷完鱼，主人说屏幕还是小智的圆脸。两个 bug：

1. **父容器挂错**：`EnsureFishIcon()` 把画布挂在 `content_left_` 上，但那个成员只在 **128x64** 布局里创建；
   我们是 128x32，左边那块叫 `content_`。`content_left_ == nullptr` 直接 return 了 → 什么也没画。
2. **鱼太大**：原来画 42x24，而 128x32 布局左侧只有 32x32 —— 就算画出来也会溢出。

改成挂在 `content_` 上、缩到 30x22（椭圆身 9x7 + 三角尾 + 挖空眼睛和嘴）。
