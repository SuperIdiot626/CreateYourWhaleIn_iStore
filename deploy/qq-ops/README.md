# qq-ops：宿主机侧的 QQ 掉线运营（抓码推微信 + 被踢频率监控）

## 为什么放在宿主机

抓二维码要读 NapCat 容器自己的 overlay 目录
（`/mnt/sata1-4/docker/overlay2/*/diff/app/napcat/cache/qrcode.png`）。
以前负责通知的 `qq-notify.py` 跑在 dsh 容器里，**路径对不上**，于是每次被踢只报得出
「掉线（**无码**）」—— 2026-11-01 凌晨 01:33 那次因此空了 **9 小时**没人扫。

宿主机上 `docker / python3 / ffmpeg` 都在，而且 `dsh` 和 `napcat` 都是 **host 网络**，
`3000`（OneBot HTTP）、`3001`（OneBot WS）、`3100`（桥接控制台）在宿主机直接可达。
所以这个脚本整体放在宿主机跑，一次检查做四件事：

| # | 检查 | 动作 |
|---|---|---|
| 1 | QQ 在线吗（OneBot `3000`） | 记录上线/掉线边沿 |
| 2 | 掉线时 NapCat 有没有**新**二维码（<180 秒） | `docker cp` 出来 → `ffmpeg` 放大 480 → 塞回容器 → **微信推图**（可扫） |
| 3 | 被踢频率 | 最近 6 小时掉线 ≥2 次 → 推一条「这个号被盯上了，考虑换小号」（6 小时最多一条） |
| 4 | 在线但桥接没连上 OneBot（假在线/聋了） | 推一条提醒（30 分钟最多一条）；真正的重启由 `deploy/qq-watchdog/` 负责 |

状态存在 `im/.qq-ops-state.json`，人可读的流水写 `im/qq-alerts.log`（她也能读到）。
第一次跑会从 `qq-alerts.log` 里捡历史掉线时间做种子，不用从零攒。

## 部署

```sh
# 脚本（宿主机路径；容器里的 /root/.dsh/im 就是它）
cp qq-ops.py /mnt/sata1-4/dsh/home/im/bin/qq-ops.py
chmod +x /mnt/sata1-4/dsh/home/im/bin/qq-ops.py

# 宿主 cron，每分钟
* * * * * /usr/bin/python3 /mnt/sata1-4/dsh/home/im/bin/qq-ops.py >/dev/null 2>&1
```

## 用法

```sh
python3 qq-ops.py --status     # 只打印判据，不发消息
python3 qq-ops.py --test-text  # 发一条测试文字，验证微信链路
```

## 依赖

- `docker`（`exec/inspect/cp`）、`/usr/bin/python3`、`/usr/bin/ffmpeg`
- 微信推送复用 `im/bin/wx-notify.mjs`（`node wx-notify.mjs image <容器内路径> <说明>`），
  token 从 `dsh 容器`的 `/root/.dsh/.credentials.yaml` 读，所以推送要 `docker exec dsh node ...`
- NapCat 的二维码固定落在容器内 `/app/napcat/cache/qrcode.png`，每次掉登录重出一张，约 2 分钟有效

## 它不做什么

- **不替人扫码**：二维码只是一张图，扫不扫是人的事。
- **不改 NapCat/QQ 的登录态**：不碰 `/mnt/sata1-4/napcat/qq`（那是**设备身份**，
  删了/清了 QQ 就会当成新设备重新验证）。
- **不重启桥接**：那是 `deploy/qq-watchdog/` 的活；两边职责分开，避免同时动手。
