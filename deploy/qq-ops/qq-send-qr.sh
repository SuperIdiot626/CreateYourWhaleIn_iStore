#!/bin/sh
# 人工确认「发码」时调用（宿主侧）：
#   先看现成的二维码够不够新，不够新就重启 NapCat 逼它重新出码，再把图推到微信。
# 用法（任何 agent / 你自己在 iStore 终端都能跑）：
#   sh /mnt/sata1-4/dsh/home/im/bin/qq-send-qr.sh
exec /usr/bin/python3 /mnt/sata1-4/dsh/home/im/bin/qq-ops.py --send-qr "$@"
