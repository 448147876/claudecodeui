# cloudcli-multi 网关

CloudCLI UI 的多账号入口：一个地址、多个账号，每个账号绑定一个工作目录，只能看到自己目录下的项目和会话。所有账号共用一次 `claude /login`。

设计与需求见 `mydocs/`（01 需求、03 技术方案、04 上游改动、05 升级手册、06 BDD）。

## 快速开始

```bash
npm ci
npm run build:multi      # 前端 + 服务端
npm run multi            # 或 node gateway/bin.mjs start
```

打开 http://127.0.0.1:3001 ，第一次会要求创建管理员，然后在右上角菜单的「账号管理」中新增账号。

## 命令

| 命令 | 说明 |
|---|---|
| `cloudcli-multi start` | 启动网关（默认命令） |
| `cloudcli-multi check` | 运行检查（BDD 自动场景 + 路径参数扫描）；`--upstream-tests` 同时跑上游测试，`--browser` 在真实浏览器中检查（需设置 Playwright 路径），`--dev` 不需要构建，`--keep` 保留临时目录 |
| `python3 gateway/check/mutation.py` | 变异测试：逐个去掉保护，确认检查能发现（约 25 分钟，需要 Python 3） |
| `cloudcli-multi backups` | 列出数据备份 |
| `cloudcli-multi restore <备份名>` | 恢复备份（网关需已停止） |

## 常用环境变量

| 变量 | 默认值 |
|---|---|
| `CLOUDCLI_MULTI_HOME` | `~/.cloudcli-multi`（数据目录） |
| `CLOUDCLI_MULTI_HOST` / `CLOUDCLI_MULTI_PORT` | `127.0.0.1` / `3001` |
| `CLOUDCLI_MULTI_WORKSPACES` | `~/workspaces`（新账号默认工作目录的父目录） |
| `CLOUDCLI_MULTI_IDLE_MINUTES` | `30`（普通账号空闲回收） |
| `CLOUDCLI_MULTI_TRUST_PROXY` | `false`（在 HTTPS 反向代理后面时设为 `true`） |

完整列表见 `mydocs/03-技术方案.md` 第 9 节。

## 隔离范围

界面和 API 层面隔离（文件浏览、项目、会话、搜索、新建会话、Agent API、聊天工作目录、斜杠命令、MCP、Skills）。普通账号不能通过界面修改共用配置（用户级 MCP/Skills、插件、系统更新、browser-use、全局 git），这些只有管理员能改。网页终端和 Claude 自身的工具不隔离，所有账号以同一个系统用户运行。详见 `mydocs/01-需求说明.md` 1.1 节。
