# 线上配置快照（live-config）

**这些文件不是"源码"，是线上运行配置的副本。** 放在这里的原因：

`/root/.dsh/surfcore`（SurfCore 主体）和 `/root/.dsh/profiles/web`（DSH profile）
**都不是 git 仓库**。也就是说，我们这几天改的提示词、MCP 注册、工具白名单，
只活在 iStore 那台机器的文件系统里 —— 一次 SurfCore 升级或 DSH 重装就会覆盖掉。

所以这里存一份可读快照 + 可重放的补丁。

| 文件 | 线上位置 | 说明 |
|---|---|---|
| `agent.cordis.yml` | `/root/.dsh/surfcore/dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 她的系统提示词（人格、工具说明、板子/小黑盒/本子） |
| `cordis.patch.yml` | `/root/.dsh/profiles/web/cordis.patch.yml` | DSH profile 的插件/MCP 注册（含 mcp-board、mcp-heybox） |
| `0009-qq-tool-restrict-heybox.patch` | `plugins/surfcore/qq-tool-restrict.mjs` | 工具白名单补丁（放行 `mcp__heybox__`） |

## 怎么恢复（升级/重装后）

1. **提示词**：把 `agent.cordis.yml` 覆盖回线上同名路径。
   注意先备份线上版本；如果新版 SurfCore 改了预设结构，要按新结构合并，**不要盲目整份覆盖**。
2. **MCP 注册**：`cordis.patch.yml` 里的 `mcp-board` / `mcp-heybox` 两块，按同样格式插回 profile。
   这两个块依赖 `src/mcp-board.js`、`src/mcp-heybox.js`（在 `deploy/xiaozhi/`，属于本仓库，可直接部署）。
3. **白名单**：在 `plugins/surfcore/qq-tool-restrict.mjs` 的 MCP 前缀数组里加 `'mcp__heybox__',`
   （或套用 `0009` 补丁）。
4. 重启 DSH，并重新拉起 PT 中继：
   `docker exec -d dsh sh -c 'cd /root/.dsh/im/pt-work && nohup python3 announce_bridge.py 8899 >> bridge.out 2>&1 &'`

## 变更历史

- 2026-11-02 板子（mcp-board + 提示词「从板子说话」「控灯」「设备工具」）
- 2026-11-04 小黑盒（mcp-heybox + 提示词）+ 本子/日记（qq_note_*）说明
