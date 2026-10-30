#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给「小鲸鱼」写语音 + B站评论配置。幂等：重复跑只会覆盖同样的值。

只改三处（每处先备份到 <surfcore>/backups/）：
  1. <surfcore>/config.json                              语音开关 / 音色 / 工具开关
  2. <bili-home>/config.json                             B站评论三道闸
  3. <surfcore>/plugins/surfcore/qq-tool-restrict.mjs    工具白名单加 bili_reply

用法：
  python3 apply_config.py --surfcore /root/.dsh/surfcore \\
      --bili-home /root/.dsh/bili-duty \\
      --owner-qq 123456789 --bili-name 你的B站昵称 --bili-uid 1234567

  # 只改语音：
  python3 apply_config.py --surfcore ... --owner-qq 123456789 --voice-only
  # 只改B站评论：
  python3 apply_config.py --surfcore ... --bili-home ... --bili-name 昵称 --comment-only
"""

import argparse
import json
import os
import shutil
import sys
import time

TS = time.strftime('%Y%m%d-%H%M%S')


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def save(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(tmp, path)


def backup(path, tag, backups_dir):
    os.makedirs(backups_dir, exist_ok=True)
    dst = os.path.join(backups_dir, f'{os.path.basename(path)}.bak-{tag}-{TS}')
    shutil.copy2(path, dst)
    print(f'  备份 → {dst}')


def apply_voice(surfcore, owner_qq):
    cfg_path = os.path.join(surfcore, 'config.json')
    cfg = load(cfg_path)
    voice = cfg.setdefault('socialV2', {}).setdefault('voice', {})
    tts = voice.setdefault('tts', {})

    backup(cfg_path, 'voice-on', os.path.join(surfcore, 'backups'))
    voice['enabled'] = True
    tts['enabled'] = True
    tts['route'] = 'local'
    tts['character'] = 'xiaoyu'
    tts.setdefault('maxChars', 120)
    tts.setdefault('endpoints', {})['local'] = 'http://127.0.0.1:8765'
    cfg['socialV2'].setdefault('tools', {})['sendVoice'] = True
    voice.setdefault('trigger', {})['who'] = 'owner'
    voice['maxPerMinute'] = 2
    voice['maxPerHour'] = 10
    if owner_qq:
        cfg['ownerQQ'] = int(owner_qq)
    save(cfg_path, cfg)
    print('  语音：voice.enabled / tts.enabled / tools.sendVoice 已打开，character=xiaoyu')


def apply_comment(surfcore, bili_home, bili_name):
    path = os.path.join(bili_home, 'config.json')
    cfg = load(path)
    backup(path, 'comment-on', os.path.join(surfcore, 'backups'))
    cfg['autoComment'] = True
    cfg['mentionName'] = bili_name
    cfg['dmMode'] = 'both'          # 只私信模式会硬关评论通道
    cfg.setdefault('commentPerRound', 1)
    save(path, cfg)
    print(f'  B站评论：autoComment=true, mentionName={bili_name}, dmMode=both')

    # 工具白名单
    restrict = os.path.join(surfcore, 'plugins/surfcore/qq-tool-restrict.mjs')
    src = open(restrict, encoding='utf-8').read()
    if "'bili_reply'," in src:
        print('  工具白名单：已是放行状态，跳过')
        return
    anchor = "  'bili_whoami',\n  'bili_status',\n"
    if anchor not in src:
        print('  ⚠️ 找不到 bili 只读工具白名单锚点，跳过（手工加 bili_reply）')
        return
    backup(restrict, 'bili-reply', os.path.join(surfcore, 'backups'))
    add = (anchor
           + "  // 发评论 / 回复评论：只解 QQ 桥接这一层；插件自己还有\n"
           + "  // autoComment / mentionName / dmMode 三道闸，改配置 / 发布 / 私信仍然不给。\n"
           + "  'bili_reply',\n")
    open(restrict, 'w', encoding='utf-8').write(src.replace(anchor, add, 1))
    print('  工具白名单：已加入 bili_reply')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--surfcore', default='/root/.dsh/surfcore')
    ap.add_argument('--bili-home', default='/root/.dsh/bili-duty')
    ap.add_argument('--owner-qq', default='')
    ap.add_argument('--bili-name', default='')
    ap.add_argument('--bili-uid', default='')
    ap.add_argument('--voice-only', action='store_true')
    ap.add_argument('--comment-only', action='store_true')
    a = ap.parse_args()

    if not os.path.isdir(a.surfcore):
        sys.exit(f'❌ 找不到 surfcore 目录：{a.surfcore}')
    do_voice = not a.comment_only
    do_comment = not a.voice_only
    if do_comment and not a.bili_name:
        sys.exit('❌ 开 B站评论要给 --bili-name（评论里 @ 谁）')

    if do_voice:
        print('[语音]')
        apply_voice(a.surfcore, a.owner_qq)
    if do_comment:
        print('[B站评论]')
        apply_comment(a.surfcore, a.bili_home, a.bili_name)

    print('\n完成。生效方式：')
    print('  · 语音配置 → 重启桥接（POST /api/restart 或重启容器）')
    print('  · 工具白名单 → 重启 DSH（guard 在会话启动时注册）')
    print('  · 改完记得在 QQ 里 /reset 一次，让新规则进上下文')


if __name__ == '__main__':
    main()
