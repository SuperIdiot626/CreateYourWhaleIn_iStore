# 部署

## 顺序

```
1. SurfCore 装好、QQ 能正常收发（上游 README）
2. deploy/voice-edge/      部署语音引擎（0 元，Edge TTS）
3. deploy/apply_config.py  写语音 + B站评论配置（幂等、带备份）
4. 打桥接补丁（跨容器部署才需要）
5. 重启：桥接 + DSH
6. QQ 里 /reset，聊两句验证
```

## 1. 语音引擎

见 [voice-edge/README.md](voice-edge/README.md)。要点：

- `pip3 install --user --break-system-packages edge-tts`
- `./start.sh` 起服务（自带守护循环）
- 宿主机 cron 每分钟 `docker exec <容器> sh -c "<路径>/start.sh"` 兜底
- 服务只监听 `127.0.0.1:8765`，不对外

## 2. 配置

```sh
python3 deploy/apply_config.py \
  --surfcore /root/.dsh/surfcore \
  --bili-home /root/.dsh/bili-duty \
  --owner-qq <你的QQ> --bili-name <你的B站昵称>
```

改的是：

| 位置 | 键 |
|---|---|
| `config.json` | `socialV2.voice.enabled`、`socialV2.voice.tts.*`、`socialV2.tools.sendVoice` |
| `bili-duty/config.json` | `autoComment`、`mentionName`、`dmMode` |
| `qq-tool-restrict.mjs` | `SAFE_EXACT` 加 `bili_reply` |

## 3. 桥接补丁（仅跨容器）

见 [patches/README.md](patches/README.md)。

## 4. 重启矩阵

| 改了什么 | 重启什么 |
|---|---|
| `config.json` 的 voice/tts | 桥接 |
| `qq-tool-restrict.mjs`、预设 yml | DSH |
| `voice-edge/*` | voice-edge（start.sh 幂等） |
| 人格卡 | 不用重启（桥接每条注入） |

都改完 → 先重启 DSH，DSH 起来后插件会自动拉起桥接；最后确认 8765 / 3100 都在听。

## 5. 验证清单

```sh
# 引擎
curl -s -X POST http://127.0.0.1:8765/v1/speak/file \
  -H 'content-type: application/json' \
  -d '{"text":"嗯，我在。","format":"wav","sr":24000,"character":"xiaoyu"}' \
  -D - -o /tmp/t.wav

# 桥接
curl -s -H "x-console-token: $(cat state/console-token)" \
  http://127.0.0.1:3100/api/voice/rules

# 端到端（会真的发一条语音条到 QQ）
curl -s -X POST http://127.0.0.1:3100/api/voice/send \
  -H "x-console-token: $(cat state/console-token)" \
  -H 'content-type: application/json' \
  -d '{"target":"private:<你的QQ>","text":"测试一条"}'
```
