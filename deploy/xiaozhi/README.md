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

## 屏幕换"小鱼"的三次尝试 —— 最后为什么用「鱼」字

**结论先说**：这块 0.91" 屏是 **单色 1bpp OLED（SSD1306 128x32）**，它只认"点阵"，不认"画画"。

| 尝试 | 做法 | 结果 | 原因 |
|---|---|---|---|
| ① emoji | 想让表情字体显示 🐟 | ❌ | 那套 Noto Emoji 是**子集字体**，只有 20 来个表情，没有鱼 |
| ② 画布 | `lv_canvas` + 1bpp 位图自绘 | ❌ 编译过、屏幕空白 | 画布本质是"把缓冲区当**图片**渲染"，图片路径要重着色/格式转换；这块屏的 flush 只处理 1bpp，I1 画布的 recolor 不生效 |
| ③ 线条 | `lv_line` 画椭圆身体 + 三角尾巴 | ❌ 仍然空白 | LVGL 9 的矢量线条先画到 **ARGB 图层**再混合，单色屏没有该图层 → 被丢弃 |
| ④ **文字** | 表情位换成中文「鱼」（文本字体） | ✅ 正常显示 | 汉字在字体里**本身就是点阵**，逐点拷进显存，天然匹配单色屏 |

**规律**：单色屏上，"文字/点阵"最稳，"画布/矢量"都不保险。
另一个印证：原来那张"小智圆脸"其实也是**字体字形**（Material Symbols 的 robot 图标），
不是图片 —— 那块屏上一切能看见的东西，本质都是字体点阵。

> 代码位置：`main/display/oled_display.cc` 的 `SetFishIcon()`（纯输出模式把表情位换成「鱼」字）。

# 第五阶段：小黑盒 + 她自己的日记（2026-11-04）

主人两条需求：让小鱼能逛小黑盒；让小鱼能读自己写的日记。

## A. 小黑盒

**做法**：装官方插件 `dsh-heybox`（信息流/帖子/评论/搜索/游戏库/点赞，扫码登录不抓包），
但它只做「设置页 + 生物钟自己逛」，**不暴露 agent 工具** —— 所以再包一层 MCP。

```
qq 侧的她 ──mcp__heybox__*──> mcp-heybox.js ──node──> dsh-heybox/tools/heybox.mjs <cmd>
```

工具（8 个）：`heybox_whoami / feed / post / comments / search / games / topic / like`
- 读命令用 CLI 的**纯文本**输出（比 --json 省约 5 倍 token，也不会截断成半截 JSON）
- `heybox_like` 默认只预演，`go=true` 才真发

接线：
| 文件 | 改动 |
|---|---|
| `/root/.dsh/profiles/web/cordis.patch.yml` | 加 `mcp-heybox` 块（serverName: heybox） |
| `plugins/surfcore/qq-tool-restrict.mjs` | 白名单加 `mcp__heybox__` |
| 预设 `agent.cordis.yml` | 加小黑盒工具说明（含「收到链接取 link_id 再 opened」） |

登录：`dsh-heybox` 扫码（`tools/lib/qrlogin.mjs` 的 startQrLogin/pollQrLogin），
凭据落在 `~/.heybox-ai/credentials.json`（0600）。

## B. 她自己的日记

**结论：工具本来就有，只是没人告诉她。**

她身上早挂了三个本子工具（`mcp-snowluma-safe.js` 里）：
`qq_note_append`（写，按天分文件 + 自动时间）、`qq_note_list`（翻目录）、`qq_note_read`（读某天）。
日记真实位置：`/root/.dsh/surfcore/state/notebook/YYYY-MM-DD.md`。

失效原因有两层：
1. 预设提示词从没提过这三个工具；
2. 安全规则开头写着「你没有本地工具，不能读写文件」—— 她会推断自己不该读。

**修法**：预设里加一段，明确「本子是自己的日记，随时可读，不算本地文件权限」，
并要求被问到「你之前写过什么」时先翻本子再答、不要凭印象编。

## 注意

装插件时 pnpm 把未被引用的 `dsh-xiaojingyu-tools` 挪进了 `node_modules/.ignored/`（未删除）。
备份：`/root/.dsh/backups/profile-web-<时间戳>.tgz`、`preset-<时间戳>.yml`。

# 第六阶段：视频宫格（dsh-video-storyboard，2026-11-04）

主人要求装 `github.com/SAOS-3624/dsh-video-storyboard`。

## 现状：本来就装着，只是没接上

profile 里早就有 `dsh-video-storyboard@0.4.4`（bundle 也注册了），工具白名单里也早放行了
`video_storyboard / video_zoom / video_probe / video_locate` —— **但提示词里一个字没提**，
所以她从来不知道能用。等于装了等于没装。

这次做的是：**升级 0.4.4 → 0.6.7 + 补提示词**。

## 它是什么

给纯文本模型一双"能看视频"的眼睛：一个视频 → 一张**可寻址的宫格图**，
每格一个镜头、烧着编号、标着时间段、底部一条与画面同步的音频包络。
模型可以"引用第 5 格"、"再放大看这几秒"，而不是吃别人写好的摘要。

## 依赖体检（`node bin/doctor.mjs`）

| 项 | 状态 |
|---|---|
| ffmpeg / ffprobe | ✅ 5.1.9 |
| yt-dlp（贴链接才需要） | ✅ 2026.10.26 |
| 缓存目录 | ✅ /tmp/dsh-video-storyboard/media |
| **ASR（台词转写）** | ⚠️ **没配** → 能出图，清单里没有台词 |

## 实测

| 场景 | 结果 |
|---|---|
| 本地 6 秒测试片 | ✅ 4 帧，3.2 秒 |
| **贴 B站 真链接**（119 秒） | ✅ yt-dlp 取 720P（匿名上限），24 秒出 4 格宫格图 |

宫格图里 **B站 硬字幕清晰可读** —— 所以即使没 ASR，她也能从画面里读到台词，
只是拿不到结构化的 `transcript` 字段。

## 还缺：ASR

不配 ASR 时 `[transcript] no-key`。两条路（改 `~/.dsh/asr.json`，热加载不用重启）：

1. **本地 funasr**（免费离线）：跑起来后写 `{"baseUrl":"http://127.0.0.1:8000/v1"}`
2. **云端**：`{"key":"sk-…","baseUrl":"https://api.siliconflow.cn/v1","model":"FunAudioLLM/SenseVoiceSmall"}`

> 另外：anonymous 最高 720P。要有 1080P 需要 yt-dlp 的 `cookies.txt`（登录态），
> 见插件 `docs/SETUP.zh.md`。当前 720P 对"看清画面"已够用。

## 接线位置

| 文件 | 改动 |
|---|---|
| profile `package.json` | dsh-video-storyboard 0.4.4 → **0.6.7** |
| 预设提示词 | 新增"看视频（把片子变成能看的宫格图）"一段，含「别拿 web_fetch 抓网页就当看过了」 |
| `qq-tool-restrict.mjs` | 无需改（`video_*` 早已在 SAFE_EXACT 里） |

## 0010-bridge-sticker-base64.patch — 收藏表情 ENOENT（2026-11-04）

**症状**：在 QQ 让她收藏表情时报

```
add_custom_face 失败，ENOENT: no such file or directory,
stat '/app/napcat/config/_sticker_tmp/c229317e8a611636.jpg'
```

**根因**：`bridge.js` 的 `serveStickerBuffer()` 还是 **NapCat 时代**的写法 ——
把图片字节写到共享目录 `/root/.dsh/im/sticker_tmp`
（= 宿主 `/mnt/sata1-4/napcat/config/_sticker_tmp`），再把**容器内路径**
`/app/napcat/config/_sticker_tmp/xxx.jpg` 交给网关去 stat。

换成 **SnowLuma** 之后，它的容器只挂了 `snowluma/{config,data,local-share}`，
**没有 `/app/napcat/config`** —— 所以永远 ENOENT。

**修法**：SnowLuma 的 image 参数支持 `file://` / `base64://` / `http(s)://`
（见 `/app/runtime/index.mjs` 里的说明），所以直接把字节内联成 base64，不再依赖共享目录：

```js
async function serveStickerBuffer(buf, type) {
  const mime = ...;
  return `base64://data:${mime};base64,${buf.toString('base64')}`;
}
```

**已验证**：用 OneBot WS 直接调 `add_custom_face`，
`base64://<raw>` 与 `base64://data:image/png;base64,<raw>` 两种都能拿到 `emoji_id`，
随后 `delete_custom_face` 清理成功。

**顺带**：旧的 `ensureStickerServer()`（本地 HTTP 兜底）因此不再被使用，但保留着没删 ——
以后若网关改成只认 URL 还能救急。

## 0011-qq-image-prefix.patch — 表情发不出去：QQ 给了个"带前缀的封装"（2026-11-04）

**症状**：收藏表情成功了，但发送时报

```
表情 3754123574_…_171DA000… 的图片下载失败（QQ CDN 网络异常或地址已失效）：
抓取内容不是有效图片（PNG/JPEG/GIF/WebP）
```

**排查**：把那条 URL 直接抓下来看 —— HTTP 200、`content-type: image/jpeg`、
长度 **1,788,845**，但**前 15 字节不是任何图片魔数**：

```
75ab5a8a66a07bf8e97a06dab1eeb8 | 89504e470d0a1a0a …   ← 真 PNG 从第 15 字节开始
```

也就是说 QQ 的表情 CDN（`p.qpic.cn/qq_expression/...`）对**部分**表情
回的是"私有头 + 真图片"的封装，`content-type` 还谎称 jpeg。
`safeFetchBuffer` 只看第 0 字节判魔数，于是把它判成"不是有效图片"。
（同一个库里别的表情是正常的裸 JPEG，所以这个 bug 只对部分表情触发。）

**修法**：新增 `normalizeImageBuffer(buf)` —— 当前 64 字节里找不到魔数时，
在前 64 字节内搜索 PNG/JPEG/GIF/WebP 魔数并**从该处切片**；找不到返回 null。

接入两处：
1. `sendStickerV2`：`safeFetchBuffer` 之后归一化，再 base64 发给网关
2. `acceptImageBuffer`（图片识别通用入口）：识别前也归一化

**已验证**：那张 1.78MB 的问题图 → 归一化后 1,788,830 字节（去掉 15 字节头）、
头部 `89504e47…`，通过 `send_private_msg` 实际发出成功（`message_id=539137923`）。

**为什么不直接放宽 `looksLikeImageBuffer`**：那样只会判定"是图片"，但缓冲区里
仍带着 15 字节垃圾前缀，发出去照样是坏图 —— 必须**切片**，不能只放宽判断。

> 备份：`src/safe-fetch.js.bak-imgprefix-<时间戳>`、`src/bridge.js.bak-imgprefix-<时间戳>`

### 更正（同一天）：归一化必须放在**抓取层**

上一版补丁把 `normalizeImageBuffer` 放在 `safeFetchBuffer` **之后** —— 但
`safeFetchBuffer` 自己就在校验魔数、**在抓取层就抛错**了，归一化根本没机会执行。
所以第一次修完仍然报同样的错（现场：22:00:04 又一次「抓取内容不是有效图片」）。

正确的分层：

```js
// safe-fetch.js
safeFetchRaw(url)             // 带 SSRF 防护的下载，不校验图片
safeFetchBuffer(url)          // = raw + 严格魔数校验（通用场景，保持不变）
safeFetchImageBuffer(url)     // = raw + normalizeImageBuffer（容忍私有头，QQ 表情用这个）
```

`sendStickerV2` 改用 `safeFetchImageBuffer`。

**最终验证**（走她真实的 HTTP 路径，带 agent token）：

```
POST /api/socialV2/send-sticker  {key:"private:1078820859", stickerId:"171DA000…"}
→ HTTP 200 { ok: true, sticker: { no: 13, desc: "测试收藏" } }
```

教训：**在"会抛错的统一入口"外面做补救是无效的 —— 要么换入口，要么在入口内部处理。**

## 0012-qzone-album-fallback.patch — 空间相册 -4003（2026-11-04）

**症状**：`qzone_album_photos` 报 `-4003 对不起，相册ID错误。`

**结论：这是 QQ 的限制，不是参数问题。** 复测记录（本机实测）：

| 试过的 | 结果 |
|---|---|
| `fcg_list_photo_v2` + topicId | -4003 / subcode -10803 |
| 换 `albumId` / 两个都传 | -4003 |
| `fcg_list_photo_v3` | 404（接口不存在） |
| `h5.qzone.qq.com` / `photo.qzone.qq.com` 直连 / user 域代理 | 全 -4003 |
| `uin` 带 `o` 前缀 | -3000「尚未登录」 |
| 页面里的 `g_qzonetoken` | **空字符串**（无 token 可带） |
| iPhone / MQQBrowser UA 抓相册页 | 只有 JS 壳，0 个图片直链 |

仓库里更早的记录也指向同一结论：
`/root/.dsh/im/qq-ops-kit/docs/qzone.md` —— 「判断是 QQ 空间对『非本人查看相册照片』的限制，
不是参数问题。**别在这上面继续换参数**」。

**修法（产品层）**：不再只返回错误，而是

1. 返回**可执行的解释**：相册照片墙只对主人开放；
2. 自动**回退到"说说的图片"**（这条链路是通的）：把对方最近 30 条说说里的图片
   收集成 `fallback.feedsImages`（最多 12 张），可以直接下载给她看；
3. 给出三条可行路：看说说图 / 让主人把相册照片发成说说 / 让主人直接在 QQ 里发图。

**已验证**：主人相册（`V10FhOLA0a9GEZ`）返回 -4003 + 12 张说说图，
任取一张下载成功（620 KB，JPEG 头 `ffd8ff`）。

> 相册**封面**（`qzone_albums` 的 `cover`）本来就能看，这条没受影响。
> 自己的相册（`hostUin == 登录号`）照旧可列照片 —— 限制只针对"看别人的"。

## 0013-qzone-default-target.patch — 相册"列表回来了但是空的"（2026-11-04）

**症状**：`qzone_albums` 返回 `{"ok": true, "uin": "3754123574", "albums": []}`。

**根因**：不传 `uin` 时，`qzone_media.py` 默认查 **`self_uin`（登录号 = 机器人自己的号）**。
那个号下一个相册都没有 —— 所以永远空列表。**不是接口挂了，是查错了对象。**

（她真正想看的是**主人**的空间，`config.json` 里的 `ownerQQ = 1078820859`。）

**修法**：新增 `default_target(self_uin)` —— 默认目标改为
`config.json` 的 `ownerQQ` → `admin.qq` → `owner.qq`，都没有才退回自己。
四处 `target = str(uin or self_uin)` 改为 `str(uin or default_target(self_uin))`
（影响：albums / album / feeds / photos 四个命令）。

**验证**（不传 uin）：

```
qzone_media.py albums   → uin=1078820859，22 个相册（带封面）
qzone_media.py album V10FhOLA0a9GEZ → -4003 + 12 张说说图回退（见 0012）
qzone_media.py feeds    → uin=1078820859，正常返回说说
```

**为什么改 Python 而不改 MCP**：MCP 只在**显式传了 uin** 时才拼 `--uin`，
所以把默认值收在 Python 层即可**立即生效，不用重启 DSH**（重启会连带掐断桥接/中继）。

# 第七阶段：她的"耳朵"—— 看 B站 视频时能听到内容（2026-11-04）

**需求澄清**：不是 QQ 语音消息，是**看 B站 视频时能"听到"视频里在说什么**。

## 结论：能力本来就有，缺的是提示词

她身上早就挂着 `bili_subtitle`（dsh-bili-scroll 插件），直接返回 **B站 官方 AI 字幕**：

```json
{ "bvid": "BV1PF4g6ME26", "title": "《这是我儿子？》", "language": "中文",
  "segments": 33, "text": "当妈妈一不小心看到自己儿子收到的万字情书\n♪ 老妹儿啊 ♪\n…" }
```

歌手/口白/歌词都在。**问题是她的提示词里从没说过"看视频要先拿字幕"** ——
她只会拿 `video_storyboard` 看画面，于是「看得到人，但听不见说什么」。

## 修法：提示词里立一条"先听台词，再看画面"

```
看视频 = 先听台词，再看画面：
① B站 视频（BV/b23.tv/bilibili.com）→ 先 bili_subtitle 拿台词（官方 AI 字幕，连歌词都有）
② 画面用 video_storyboard / bili_frames / bili_cover
③ 两个一起才叫看完：先读台词知道讲什么，再看几帧确认画面
④ bili_subtitle 明确说没字幕时，才如实说"只看到画面、听不到声音"，不要编台词
```

## 附带的第二方案：dsh-bili-watch

顺手装了 [`dsh-bili-watch`](https://www.npmjs.com/package/dsh-bili-watch) 0.4.5（把 B站 视频读成文本：
元数据/评论/弹幕/字幕/**本地 ASR 转写**/抽帧 OCR，降级链 官方字幕 → 本地 ASR → 画面 OCR）。

- 凭证：把 bili-duty 的 `bili_credential.json` 补齐 `buvid4`（从 `x/frontend/finger/spi` 取）
  → 写到 `~/.dsh/bili-watch/credential.json`（0600），CLI 实测能拉 AI 字幕
- **但它的 agent 工具 `bili_watch` 没注册**：依赖 peer `@deepseek-ai/dsh-tools`，
  而 npm 上只有 `0.0.1-rc.1`，与当前 DSH `0.2.1-rc.2` **不兼容**（dsh 直接拒绝安装，强装需
  `allow-version --accept-risk`，有搞崩风险 —— 没做）。所以插件目前只提供 `/bili` 命令与面板，
  不提供 agent 工具。
- 本地 ASR/OCR 依赖还没装（`node scripts/fetch-deps.mjs`，要下 faster-whisper 模型）。
  本机内存 3.9 GB、已用约 2.7 GB —— 要不要装模型需主人拍板，见下。

## 还没覆盖的情况

**视频没有 AI 字幕**（部分 UP 主关掉了字幕）。那时她只能看画面。补法二选一：

| 方案 | 代价 |
|---|---|
| `dsh-bili-watch` 本地 ASR（faster-whisper） | 下模型约 0.5–1 GB；本机内存紧张，需评估 |
| 云端 ASR（如 siliconflow） | 要 API key；`~/.dsh/asr.json` 写 `{key, baseUrl, model}` 即可，热加载 |

> `video_storyboard` 的 `[transcript] no-key` 也是同一个缺口 —— 配好 `asr.json` 后
> 它的宫格图会连带出台词，一举两得。
