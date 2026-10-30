# 桥接补丁

SurfCore 默认假设**桥接和 QQ 网关在同一台机器**（同一份文件系统），所以 `record` 段直接传本地绝对路径。
容器化部署时网关在另一个容器里，看不到这个路径，表现：

```
OneBot send_private_msg 失败: 文件处理失败: 识别URL失败, uri= /root/.dsh/surfcore/state/voice-tts/xxx.wav
```

## 0001-surfcore-record-base64.patch

把 `src/bridge.js` 的 `sendVoiceV2()` 里 record 段改成：

- 文件 ≤ 8MB → `file: 'base64://' + bytes`（跨容器可用）
- 更大 → 仍走路径（base64 会撑大请求体；QQ 语音条实际用不到）

网关侧 OneBot 实现支持 `base64://`（NapCat / SnowLuma 都支持），转 SILK 照旧由网关做。

## 怎么打

```sh
cd <surfcore>
git init  # 若不是 git 仓库，先备份
patch -p1 --dry-run < .../0001-surfcore-record-base64.patch   # 先试
patch -p1 < .../0001-surfcore-record-base64.patch
node --check src/bridge.js
# 重启桥接
```

## 注意

- 这是**本地补丁**，SurfCore 升级会覆盖 `src/bridge.js`，升级后要重打。
- 打之前备份：`cp src/bridge.js backups/bridge.js.bak-$(date +%s)`。
- 如果哪天桥接和网关同机（Windows 单机部署），这个补丁可以不打。
