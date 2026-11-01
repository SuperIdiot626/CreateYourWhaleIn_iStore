# 2026-11-01 QQ 动图（GIF/WebP）取不到、也「动不了」

## 现象

- 主人在 QQ 里发了两张动图（表情包），她只看到第一张（还是静止的），第二张直接「图片获取失败」；
- 她说「第二张取两次都失败」，主人以为是她"读不了 GIF/WebP"。

## 根因（三层，各是一件事）

### 1. 媒体字节上限 8MB，QQ 动图表情经常更大

bridge.log 里有直接证据：

```
[media] 表情获取失败（3 次尝试）：
  https://multimedia.nt.qq.com.cn/download?...: 图片超过大小限制（8388608 字节）
  https://gxh.vip.qq.com/club/item/parcel/item/82/823168DB.../raw300.gif: 图片抓取失败：HTTP 404
  get_image url: 图片超过大小限制（8388608 字节）
```

`socialV2.media.maxBytes` 是 8MB，`safeFetchBuffer` 超过就直接放弃。
兜底的市场表情 CDN（`raw300.gif`）那条又 404 —— 两条都断，于是「获取失败」。

### 2. 就算取到，模型也只能看到一帧

视觉模型拿到的是静态图：GIF/WebP 的动画它看不见。所以"动图动不了"不是她读不懂格式，
是**给模型的东西只有一帧**。要让她知道"在动"，唯一办法是把多帧当多张图喂进去。

### 3. 原始动图直接塞上下文很贵

一张 8MB 动图 → base64 约 10.6MB 字符串，DSH 上传和上下文都吃不消；
而且只有第一帧有意义——花大价钱传了一堆用不上的帧。

## 影响面

- 只影响入站媒体（图片/表情/动图），不影响文字、语音、B站链路。
- 改 `src/bridge.js`（3 处）+ 新增 `src/media-normalize.js` + `config.json` 的 `socialV2.media.maxBytes`。
- 不进模型的数据量下降：8MB 动图 → 3 帧 × 45KB ≈ 135KB。

## 修法

1. **放宽取图上限**：`maxBytes` 8MB → 24MB（bridge 侧 clamp 上限 20MB → 32MB）。
   取得到之后立刻归一化，所以不会把大图塞进上下文。
2. **新增 `src/media-normalize.js`**（纯函数、不联网、可单测）：
   - `ffprobe` 判断是不是动图（`format_name` 含 gif/webp 且帧数>1 或时长>0.3s）；
   - 动图：`ffmpeg` 等距抽 ≤3 帧；
   - 静态图：缩一张；
   - 统一小 JPEG：长边 ≤960、单帧 ≤900KB（超了再缩一档）。
3. **`fetchOneBotImage()`** 拿到原始字节后先归一化，返回 `{ frames, animated, note }`；
   归一化失败退回原始字节（行为与旧版一致，不会因为新模块挂掉就取不到图）。
4. **两个消费方展开多帧**：`resolveMediaList()`（拼给模型的 message parts）与
   `fetchMediaData()`（`qq_get_message_images` 工具返回）都按帧推，并带上
   `[动图，已抽 3 帧，按顺序看]` 的说明。
5. **收藏表情那条路不变**：`collectStickerV2` 仍然用原始字节（不然收藏下来的动图会变成静图）。

## 验证

| 项 | 结果 |
|---|---|
| 模块单测（852KB 动图 GIF） | `frames=3 animated=true note="[动图，已抽 3 帧，按顺序看]"`，每帧 ~45KB |
| 模块单测（1920×1440 静图 JPEG） | `frames=1 animated=false`，36KB（长边缩到 960） |
| 容器内语法检查 | `node --check src/bridge.js`、`src/media-normalize.js` 均通过 |
| 上线 | bridge pid 979，`media.maxBytes=25165824`，启动日志正常、入站对账/看门狗都在 |
| 端到端 | ⏳ 待主人重发那张 GIF 后看 `bridge.log` 是否出现抽帧日志、以及她能不能描述"在动" |

## 回滚与残余

- 备份：容器内 `/root/backups/bridge.js.bak-before-media-20261101-112345`、
  `config.json.bak-before-media-20261101-112345`；补丁 `deploy/patches/0004-media-normalize.patch`。
- 残余 1：SILK/QQ 侧的大文件（>24MB 的真视频表情）仍然取不到——那是另一个量级，不建议硬解。
- 残余 2：市场表情 CDN `raw300.gif` 404 是 QQ 侧的，换不来；现在靠 `media.url` 直链（已能取到）。
- 残余 3：抽帧是**等距**的（第1/中/末附近的 3 帧），非常短的循环动画可能看起来差别不大；
  真要精细看，可以让 agent 用 `video_*`/`bili_frames` 类工具逐帧看（对聊天表情不划算）。
