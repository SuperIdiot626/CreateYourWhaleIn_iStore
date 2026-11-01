# NOTICE · 第三方与来源

本插件（`dsh-xiaojingyu-tools`）的代码由本项目独立编写。以下是对外依赖与参考来源：

## 运行时依赖

| 组件 | 许可 | 用途 |
|---|---|---|
| [qrcode](https://github.com/soldair/node-qrcode) | MIT | 把扫码登录 URL 画成 PNG |
| `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-tools` | 随 DSH 发布 | 插件契约（Config schema / defineTool），**不打包**，运行时从宿主树解析 |
| ffmpeg | LGPL/GPL（视构建） | 封面缩放、故事板裁帧；**不打包**，调用系统命令 |

## 参考（未复制代码）

| 项目 | 许可 | 参考了什么 |
|---|---|---|
| [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | MIT | **仅工具契约**：工具名、参数形状、返回字段保持兼容，方便从它迁移过来。实现（HTTP/WBI/抽帧/限额/登录）是本项目自己写的；它的 `duty.md` 章程、日报模板、提示词、Python MCP 均未复制。 |

## 数据来源

B站 网页端公开/登录态接口（`api.bilibili.com`、`passport.bilibili.com`、`i0.hdslb.com` 等），
调用方自行承担账号与风控责任。凭据保存在使用者的 DSH 数据目录里，不上传、不进仓库。
