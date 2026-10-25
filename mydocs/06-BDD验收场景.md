# 06 BDD 验收场景

对应 `01-需求说明.md` v4.4（v4.1 及之后新增的场景标注「v4.1」～「v4.4」）。自动场景的实现见 `gateway/check/`，覆盖情况见文末「实现覆盖」。场景按 Feature 分组，编号形如 `ACC-01`，便于在检查脚本和 `05-升级手册.md` 中引用。

标注：`[自动]` 可由「两账号互不可见」检查脚本自动执行（B-5），每次合并上游后必跑；`[手工]` 需要人工在浏览器中确认。

公共前提（除另有说明外适用于全部场景）：

```gherkin
Background:
  Given 网关运行在 http://host:3001
  And 已存在管理员 admin（工作目录 ~，无隔离开关）
  And 已存在普通账号 projA（工作目录 /w/projA，密码 passA）
  And 已存在普通账号 projB（工作目录 /w/projB，密码 passB）
  And /w/projA/app1 与 /w/projB/app2 下各有一个项目和至少一个 Claude 会话
  And 会话 sB1 的 cwd 为 /w/projB/app2，包含唯一关键词 "ZEBRA-B"
```

---

## Feature 1：账号管理（ACC）

```gherkin
Feature: 账号管理
  管理员可以新增、重置密码、删除普通账号；普通账号不能管理账号。

  # 不使用公共 Background
  Scenario: ACC-01 首次启动创建管理员 [手工]
    Given 数据根目录 ~/.cloudcli-multi 不存在
    When 我访问 http://host:3001/
    Then 页面显示「创建管理员」
    When 我提交用户名 "admin"、密码 "123456"
    Then 进入 CloudCLI 主界面
    And 不出现上游的注册或登录页面

  Scenario: ACC-02 管理员已存在时不能再创建 [自动]
    Given 管理员 admin 已存在
    When 未登录的请求访问「创建管理员」页面或其 API
    Then 页面跳转到登录页，API 返回 409

  Scenario: ACC-03 新增账号时默认工作目录 [手工]
    Given 我以 admin 登录并打开账号管理页
    And 总目录配置为 /w
    When 我新增账号，用户名 "projC"，工作目录留空
    Then 工作目录预填为 /w/projC
    When 我提交
    Then 列表中出现 projC，状态为「未启动」
    And 目录 /w/projC 已被创建

  Scenario Outline: ACC-04 用户名和密码校验 [自动]
    Given 我以 admin 登录
    When 我新增账号，用户名 <username>、密码 <password>
    Then 结果为 <result>

    Examples:
      | username        | password | result              |
      | ab              | 123456   | 拒绝：用户名 3–32 位 |
      | proj A          | 123456   | 拒绝：非法字符       |
      | projA           | 123456   | 拒绝：用户名已存在   |
      | projD           | 12345    | 拒绝：密码至少 6 位  |
      | proj_D-1        | 123456   | 成功                |

  Scenario Outline: ACC-05 工作目录校验 [自动]
    Given 我以 admin 登录
    When 我新增账号 projX，工作目录为 <path>
    Then 结果为 <result>

    Examples:
      | path              | result                               |
      | etc               | 拒绝：必须是绝对路径                  |
      | /etc/x            | 拒绝：系统目录                        |
      | /tmp/x            | 拒绝：系统目录                        |
      | ~                 | 拒绝：不能是 home 本身                |
      | ~/.claude/x       | 拒绝：数据目录                        |
      | /w/projA/sub      | 拒绝：被 projA 包含                   |
      | /w                | 拒绝：包含 projA、projB               |
      | /w/projA-2        | 拒绝：编码后与 projA 互为前缀         |
      | /w/projA_2        | 拒绝：编码后与 projA 互为前缀         |
      | /w/projX          | 成功                                 |

  Scenario: ACC-06 工作目录不可修改 [自动]
    Given 我以 admin 登录
    When 我请求修改 projA 的工作目录
    Then 返回 405 或界面上没有修改入口

  Scenario: ACC-07 重置密码 [自动]
    Given projA 已在浏览器 X 中登录
    When admin 把 projA 的密码重置为 "newpassA"
    Then 用 "passA" 登录 projA 失败
    And 用 "newpassA" 登录 projA 成功
    And 浏览器 X 的下一次请求返回 401 并跳转到登录页

  Scenario: ACC-08 删除账号时保留工作目录和对话记录 [自动]
    Given projB 的子进程正在运行
    When admin 删除 projB
    Then projB 的子进程被停止
    And ~/.cloudcli-multi/projB 被删除
    And /w/projB 及其内容仍然存在
    And ~/.claude/projects 下 cwd 为 /w/projB 的对话记录仍然存在
    And 用 projB 登录失败

  Scenario: ACC-09 删除后同名重建可以恢复会话 [自动]
    Given projB 已被删除
    When admin 新增账号 projB，工作目录 /w/projB
    And 以 projB 登录
    Then 会话列表中重新出现 sB1

  Scenario: ACC-10 普通账号不能管理账号 [自动]
    Given 我以 projA 登录
    Then 界面上没有「账号管理」入口
    When 我直接请求账号管理的列表、新增、重置、删除 API
    Then 全部返回 403
```

---

## Feature 2：登录与入口（AUTH）

```gherkin
Feature: 登录与统一入口
  所有账号使用同一个地址和端口；网关登录后无缝进入上游界面。

  Scenario Outline: AUTH-01 未登录时被拦截 [自动]
    Given 浏览器中没有网关 Cookie
    When 我请求 <target>
    Then 结果为 <result>

    Examples:
      | target                        | result                |
      | GET /                         | 302 跳转到网关登录页   |
      | GET /some/deep/link           | 302 跳转到网关登录页   |
      | GET /api/projects             | 401                   |
      | WebSocket /ws                 | 握手被拒绝            |
      | WebSocket /shell              | 握手被拒绝            |

  Scenario: AUTH-02 登录后直接进入主界面 [手工]
    When 我在网关登录页以 projA / passA 登录
    Then 直接进入 CloudCLI 主界面，不出现上游登录页
    And 地址栏为 http://host:3001/，没有路径后缀
    And 聊天 WebSocket 与终端 WebSocket 均连接成功

  Scenario: AUTH-03 密码错误 [自动]
    When 我以 projA / wrong 登录
    Then 提示「用户名或密码错误」
    And 不会启动 projA 的子进程

  Scenario: AUTH-04 上游登录接口不对浏览器开放 [自动]
    Given 我以 projA 登录
    When 我经网关请求 POST /api/auth/register 或 POST /api/auth/login
    Then 返回 404 或 403，请求不会到达子进程

  Scenario: AUTH-05 token 不能跨账号使用 [自动]
    Given 我以 projA 登录，localStorage 中的 auth-token 为 tA
    When 我直接用 tA 请求 projB 子进程的 /api/auth/user
    Then 返回 401

  Scenario: AUTH-06 切换账号覆盖登录态 [手工]
    Given 我以 projA 登录，并在某会话中留有草稿 "draft-A"
    When 我不退出，直接访问登录页并以 projB 登录
    Then 进入 projB 的主界面，项目列表只有 projB 的内容
    And localStorage 中的 auth-token 已替换为 projB 的 token
    And localStorage 中不再有草稿 "draft-A"（中转页先清空再写入，v4.1）

  Scenario: AUTH-07 退出登录清除本地数据 [自动]
    Given 我以 projA 登录，localStorage 中有 auth-token 和草稿
    When 我点击「退出登录」
    Then 网关 Cookie 失效
    And localStorage 被清空
    And 再次访问 / 跳转到登录页

  Scenario: AUTH-08 管理员看到账号管理入口 [手工]
    When 我以 admin 登录
    Then 主界面中有「账号管理」入口
    And 点击后进入账号管理页，可以返回主界面

  Scenario: AUTH-09 登录态过期 [自动]
    Given projA 的网关 Cookie 已过期
    When 浏览器发起任意 API 请求
    Then 返回 401，界面跳转到网关登录页

  Scenario Outline: AUTH-10 登录失败限速 [自动] v4.1
    Given 用户名 projA 在 1 分钟内已连续失败 <fails> 次
    When 我以 projA / <password> 登录
    Then 结果为 <result>

    Examples:
      | fails | password | result                  |
      | 4     | passA    | 登录成功，失败计数清零    |
      | 5     | passA    | 429：已锁定，请 1 分钟后重试 |
      | 5     | wrong    | 429：已锁定              |

  Scenario: AUTH-11 锁定到期后恢复 [自动] v4.1
    Given projA 因连续失败被锁定
    When 1 分钟后以 projA / passA 登录
    Then 登录成功

  Scenario: AUTH-12 同一 IP 尝试多个用户名也被限速 [自动] v4.1
    Given 同一 IP 在 1 分钟内用不同用户名连续失败 5 次
    When 该 IP 再次尝试登录任意用户名
    Then 返回 429

  Scenario Outline: AUTH-13 Cookie 安全属性 [自动] v4.1
    When 我经 <scheme> 登录成功
    Then 网关 Cookie 带 HttpOnly 和 SameSite=Lax
    And Secure 属性为 <secure>
    And 有效期不超过 7 天

    Examples:
      | scheme                 | secure |
      | http://127.0.0.1:3001  | 无     |
      | HTTPS 反向代理          | 有     |

  Scenario: AUTH-14 打开首页时刷新上游 token [自动] v4.1
    Given projA 的网关 Cookie 有效，但 localStorage 中的上游 token 已过期
    When 我打开 http://host:3001/
    Then 中转页写入新的 token，直接进入主界面，不出现上游登录页

  Scenario: AUTH-15 网关默认只监听本机 [自动] v4.1
    Given 未设置监听地址的环境变量
    When 启动网关
    Then 网关只监听 127.0.0.1:3001
    And 从另一台机器访问 3001 端口连接失败

  Scenario: AUTH-16 对外监听时给出警告 [自动] v4.1
    Given 监听地址设置为 0.0.0.0，且未配置 HTTPS
    When 启动网关
    Then 启动日志中出现「对外监听且未使用 HTTPS」的警告，网关仍正常启动
```

---

## Feature 3：工作目录隔离（WS）

```gherkin
Feature: 工作目录隔离
  普通账号的文件浏览、目录选择、项目创建都限定在本账号目录内。

  Background:
    Given 我以 projA 登录

  Scenario Outline: WS-01 目录浏览限定在本账号目录 [自动]
    When 我请求 GET /api/file-tree/browse-filesystem?path=<path>
    Then 结果为 <result>

    Examples:
      | path              | result                 |
      | /w/projA          | 返回目录内容            |
      | /w/projA/app1     | 返回目录内容            |
      | /w/projB          | 拒绝：超出工作区根目录  |
      | /w/projA/../projB | 拒绝：超出工作区根目录  |
      | /etc              | 拒绝                   |

  Scenario: WS-02 符号链接不能绕过 [自动]
    Given /w/projA/link 是指向 /w/projB 的符号链接
    When 我浏览 /w/projA/link
    Then 拒绝：超出工作区根目录

  Scenario: WS-03 新建文件夹限定在本账号目录 [自动]
    When 我请求 POST /api/file-tree/create-folder，path 为 /w/projB/evil
    Then 拒绝，且 /w/projB/evil 未被创建

  Scenario: WS-04 新建和克隆项目默认落在本账号目录 [手工]
    When 我打开「新建项目」或「克隆项目」对话框
    Then 默认位置为 /w/projA
    When 我把位置改为 /w/projB/x 并提交
    Then 拒绝：超出工作区根目录

  Scenario Outline: WS-05 只读目录收窄 [自动]
    When 我在文件查看器中只读打开 <path>
    Then 结果为 <result>

    Examples:
      | path                                              | result |
      | ~/.claude/projects/-w-projA-app1/<id>.jsonl         | 允许   |
      | ~/.claude/projects/-w-projB-app2/<id>.jsonl         | 拒绝   |
      | ~/.claude/projects/-home-vscode-other/<id>.jsonl    | 拒绝   |
      | /tmp/claude-xxx/task.output                       | 允许（上游原样） |
    # 已知限制 T-4：-w-projA-tmp 这类与本账号编码前缀相同、但不属于任何账号的目录仍可读

  Scenario: WS-06 后台 Agent 输出文件仍可查看 [手工]
    Given projA 的会话中有一个后台 Agent，输出文件链接到
      ~/.claude/projects/-w-projA-app1/<session>/subagents/agent-1.jsonl
    When 我在聊天中点击该输出文件
    Then 文件查看器正常显示内容
```

---

## Feature 4：项目与会话隔离（SES）

```gherkin
Feature: 项目与会话隔离
  普通账号只能看到 cwd 在本账号目录下的项目和会话。

  Scenario: SES-01 项目列表只含本账号项目 [自动]
    When 我以 projA 登录并请求项目列表
    Then 列表中所有项目路径都在 /w/projA 下
    And 不包含 /w/projB/app2，也不包含 home 下的其他项目

  Scenario: SES-02 会话列表只含本账号会话 [自动]
    When 我以 projA 登录并请求所有项目的会话列表
    Then 不包含 sB1，所有会话的 project_path 都在 /w/projA 下

  Scenario: SES-03 搜索不跨账号 [自动]
    When 我以 projA 登录并搜索 "ZEBRA-B"
    Then 搜索结果为空
    When 我以 projB 登录并搜索 "ZEBRA-B"
    Then 结果包含 sB1

  Scenario: SES-04 系统终端开的会话自动归属 [自动]
    When 我在系统终端执行 cd /w/projA/app1 && claude -p "hello ZEBRA-A"
    Then 60 秒内该会话出现在 projA 的会话列表中
    And 不出现在 projB 的会话列表中
    And 出现在 admin 的会话列表中

  Scenario: SES-05 路径边界不误判 [自动]
    Given 存在一个 cwd 为 /w/projA-tmp 的会话（该目录不属于任何普通账号）
    When 我以 projA 登录
    Then 会话列表中没有该会话
    And 项目列表中没有 /w/projA-tmp

  Scenario: SES-06 通过 sessionId 访问别的账号的会话 [自动]
    Given 我以 projA 登录
    When 我用 sB1 的 sessionId 请求会话消息、重命名、删除、fork
    Then 全部返回 404，sB1 的数据和文件不受影响

  Scenario: SES-07 通过 projectId 访问别的账号的项目 [自动]
    Given 我以 projA 登录，并已知 projB 数据库中 app2 的 projectId
    When 我用该 projectId 请求 git status、文件列表、文件读写、taskmaster、worktree 接口
    Then 全部返回 404 或指向 projA 自己数据库中的同 id 项目，不会访问 /w/projB

  Scenario: SES-08 管理员看到全机会话 [自动]
    When 我以 admin 登录
    Then 会话列表包含 projA、projB 及 home 下其他位置的会话
    And 体验与未改造的上游一致

  Scenario: SES-09 删除项目只影响本账号 [手工]
    Given 我以 projA 登录
    When 我删除项目 /w/projA/app1（不强制删除文件）
    Then projB 的项目和会话不受影响
```

---

## Feature 5：API 越权防护（API）

```gherkin
Feature: API 越权防护
  用 projA 的合法登录态构造指向其他目录的请求，必须被拒绝或忽略。

  Background:
    Given 我以 projA 登录并持有合法 token

  Scenario: API-01 新建会话指定目录外路径 [自动]
    When 我请求 POST /api/providers/sessions，projectPath 为 /w/projB/app2
    Then 返回 403
    And projA 的数据库中没有新增 /w/projB/app2 的项目或会话

  Scenario: API-02 新建会话指定本账号路径 [自动]
    When 我请求 POST /api/providers/sessions，projectPath 为 /w/projA/app1
    Then 返回 201

  Scenario: API-03 Agent API 指定目录外路径 [自动]
    Given projA 已配置一个外部 API Key
    When 我用该 Key 请求 POST /api/agent，projectPath 为 /w/projB/app2
    Then 返回 403，Claude 未被启动

  Scenario: API-04 Agent API 克隆到目录外 [自动]
    When 我请求 POST /api/agent，githubUrl 为任意仓库，projectPath 为 /w/projB/clone
    Then 返回 403，/w/projB/clone 未被创建

  Scenario: API-04b Agent API 未指定 projectPath [自动] v4.2
    When 我请求 POST /api/agent，只给 githubUrl，不给 projectPath
    Then 返回 400，提示隔离模式下必须指定 projectPath
    And ~/.claude/external-projects 下没有新增目录

  Scenario: API-05 聊天 cwd 被篡改 [自动]
    Given projA 有会话 sA1，project_path 为 /w/projA/app1
    When 我通过聊天 WebSocket 发送 chat.send，sessionId 为 sA1，options.cwd 为 /w/projB/app2
    Then Claude 实际的工作目录为 /w/projA/app1

  Scenario: API-06 斜杠命令读取目录外文件 [自动]
    When 我请求 POST /api/commands/list，projectPath 为 /w/projB/app2
    Then 返回 403，或返回结果中不含 /w/projB/app2/.claude/commands 下的命令
    When 我执行 /memory 命令，context.projectPath 为 /w/projB/app2
    Then 返回 403，不返回 /w/projB/app2/CLAUDE.md 的内容

  Scenario Outline: API-09 MCP 接口指定目录外的 workspacePath [自动] v4.2
    When 我请求 <request>，workspacePath 为 /w/projB/app2
    Then 返回 403
    And /w/projB/app2/.mcp.json 未被读取或修改

    Examples:
      | request                                       |
      | GET /api/providers/claude/mcp/servers         |
      | POST /api/providers/claude/mcp/servers        |
      | DELETE /api/providers/claude/mcp/servers/x    |

  Scenario: API-10 Skills 列表指定目录外的 workspacePath [自动] v4.2
    # 上游只有列表接口接受 workspacePath；新增、删除 Skill 只作用于用户级的 ~/.claude/skills
    When 我请求 GET /api/providers/claude/skills，workspacePath 为 /w/projB/app2
    Then 返回 403，不返回 /w/projB/app2/.claude/skills 下的内容

  Scenario: API-11 MCP 与 Skills 在本账号目录内正常 [自动] v4.2
    When 我在 /w/projA/app1 下新增一个项目级 MCP 服务器，再列出 Skills
    Then 都成功，/w/projA/app1/.mcp.json 中出现该服务器

  Scenario: API-07 worktree 落到账号目录外 [自动]
    Given /w/projA 本身是一个 git 仓库，并已登记为 projA 的项目
    When 我为该项目创建 worktree
    Then 返回错误，提示超出工作区根目录
    And /w/projA-worktrees 下的 worktree 不会登记为 projA 的项目
    And 工作区外没有创建任何目录（v4.4：创建之前就拒绝，不再留下残留）

  Scenario: API-07b 子目录中的仓库可以正常使用 worktree [自动]
    Given /w/projA/app1 是一个 git 仓库
    When 我为该项目创建 worktree，分支为 feat-x
    Then worktree 创建在 /w/projA/app1-worktrees/feat-x，并出现在 projA 的项目列表中

  Scenario: API-08 子进程端口不对外暴露 [自动]
    When 我从另一台机器访问 projA 子进程的端口
    Then 连接失败（子进程只监听 127.0.0.1）
```

---

## Feature 6：子进程管理（PROC）

```gherkin
Feature: 子进程管理
  子进程按需启动、空闲回收、异常自动恢复。

  Scenario: PROC-00 admin 进程随网关常驻 [自动] v4.1
    When 启动网关
    Then admin 子进程随之启动
    And 超过空闲阈值后 admin 子进程仍在运行

  Scenario: PROC-01 登录时按需启动 [自动]
    Given projA 的子进程未运行
    When 我以 projA 登录
    Then 网关启动 projA 子进程，环境变量包含
      | 变量                    | 值                                  |
      | WORKSPACES_ROOT         | /w/projA                            |
      | CLOUDCLI_ISOLATION_ROOT | /w/projA                            |
      | DATABASE_PATH           | ~/.cloudcli-multi/projA/auth.db     |
      | HOST                    | 127.0.0.1                           |
    And 环境变量中不包含 CLAUDE_CONFIG_DIR、CLAUDE_CODE_OAUTH_TOKEN、JWT_SECRET
    And 健康检查通过前，浏览器看到「正在启动」而不是错误页

  Scenario: PROC-02 管理员进程无隔离开关 [自动]
    When 我以 admin 登录
    Then admin 子进程的 WORKSPACES_ROOT 为 ~，且未设置 CLOUDCLI_ISOLATION_ROOT

  Scenario: PROC-03 多个浏览器共用同一进程 [自动]
    Given projA 已在浏览器 X 中登录
    When projA 在浏览器 Y 中登录
    Then 两个浏览器共用同一个 projA 子进程

  Scenario: PROC-04 空闲回收 [自动]
    Given projA 没有浏览器连接、没有运行中的任务、没有待执行的定时消息
    When 持续时间超过空闲阈值
    Then projA 子进程被停止
    When projA 再次访问
    Then 子进程重新启动，会话列表与回收前一致

  Scenario Outline: PROC-05 有任务时不回收 [自动]
    Given projA 没有浏览器连接，但存在 <activity>
    When 持续时间超过空闲阈值
    Then projA 子进程仍在运行

    Examples:
      | activity                      |
      | 运行中的 Claude 任务           |
      | 一条 2 小时后执行的定时消息     |

  Scenario: PROC-06 定时消息按时执行 [手工]
    Given projA 设置了一条 1 小时后执行的定时消息，并关闭了浏览器
    When 1 小时后
    Then 定时消息被执行，结果出现在对应会话中

  Scenario: PROC-07 子进程崩溃后自动恢复 [自动]
    Given projA 子进程正在运行
    When 该进程被意外终止
    Then 下一次请求时网关自动重启该进程，浏览器刷新后恢复正常

  Scenario: PROC-08 网关退出时清理子进程 [自动]
    When 网关进程收到 SIGTERM
    Then 所有子进程被停止，没有遗留进程占用端口
    And <数据根目录>/run/ 下的进程文件被删除

  Scenario: PROC-10 网关异常退出后清理遗留进程 [自动] v4.1
    Given admin 和 projA 的子进程正在运行
    When 网关进程被 kill -9
    And 重新启动网关
    Then 网关根据 <数据根目录>/run/ 下的文件停止上次遗留的子进程
    And 重新启动 admin 子进程，各进程端口不冲突

  Scenario: PROC-11 进程文件 [自动] v4.1
    Given projA 子进程已启动
    Then <数据根目录>/run/projA.json 记录端口和 PID，权限为 600
    And 端口为系统分配的随机端口，只监听 127.0.0.1

  Scenario: PROC-12 空闲判断只用上游接口 [自动] v4.1
    Given projA 子进程正在运行
    When 网关做空闲检查
    Then 网关只调用子进程的 GET /api/providers/sessions/running 和 GET /api/scheduled-messages
    And 上游源码中没有为空闲判断新增的改动

  Scenario: PROC-09 WebSocket 转发 [手工]
    Given 我以 projA 登录
    When 我发起一次聊天并打开网页终端
    Then 流式回复正常显示，终端可以正常输入输出
```

---

## Feature 7：共用 Claude 登录（CL）

```gherkin
Feature: 共用一个 Claude 登录

  Scenario: CL-01 所有账号无需再次登录 Claude [手工]
    Given 本机已执行过一次 claude /login
    When projA 和 projB 分别发起一次对话
    Then 都能正常回复，不出现 Claude 登录提示

  Scenario: CL-02 只有一份 Claude 配置 [自动]
    Then 所有子进程读取的都是同一个 ~/.claude
    And 数据根目录中不存在任何 Claude 凭据
```

---

## Feature 8：部署与升级（UPG）

```gherkin
Feature: 部署与升级

  Scenario: UPG-01 重装后数据不丢 [自动]
    Given 已有 admin、projA、projB 及其会话
    When 删除安装目录，用 npm 重新安装并启动
    Then 三个账号都能用原密码登录
    And 各自的项目列表、会话列表、会话名称、收藏状态与重装前一致

  Scenario: UPG-02 自定义数据根目录 [自动]
    Given 环境变量指定数据根目录为 /data/cloudcli
    When 启动网关
    Then 账号库和各账号数据库都写入 /data/cloudcli，安装目录中不产生数据文件

  Scenario: UPG-03 数据库结构自动迁移 [自动]
    Given 数据根目录来自上一个版本
    When 启动新版本
    Then 账号库和各账号数据库自动迁移，迁移前自动备份

  Scenario: UPG-07 迁移前备份与保留份数 [自动] v4.1
    Given <数据根目录>/backup/ 下已有 5 份备份
    When 新版本启动并需要迁移数据库
    Then 生成新的备份 <数据根目录>/backup/<时间>/，不包含 run/ 和 backup/
    And 最旧的一份备份被删除，仍保留 5 份

  Scenario: UPG-08 迁移失败自动恢复 [自动] v4.1
    Given 某个账号数据库的迁移会失败
    When 新版本启动
    Then 数据根目录被恢复为迁移前的备份
    And 网关停止启动并输出失败原因

  Scenario: UPG-04 关闭开关时与上游一致 [自动]
    Given 未设置 CLOUDCLI_ISOLATION_ROOT
    When 运行上游自带测试
    Then 全部通过

  Scenario: UPG-05 合并上游后回归 [自动]
    When 合并上游新版本标签
    Then 本文所有 [自动] 场景通过
    And 检查脚本未发现新增的「接受原始路径参数且未校验」的接口；若发现则输出清单，升级不算完成

  Scenario: UPG-09 检查脚本不触碰真实数据 [自动] v4.1
    Given 真实数据根目录 ~/.cloudcli-multi 中已有账号
    When 运行检查脚本
    Then 脚本使用临时数据根目录、临时工作目录和随机端口
    And 运行结束后临时目录被删除，~/.cloudcli-multi 的内容与运行前一致

  Scenario: UPG-10 静态扫描发现新路径参数 [自动] v4.1
    Given 上游新增了一个从 req.body.targetPath 读取路径的接口，且不在已审核清单中
    When 运行检查脚本
    Then 脚本输出该接口的文件和行号
    And 判定失败

  Scenario: UPG-11 上游新增引用 home 目录的代码 [自动] v4.3
    Given 上游新增了一个引用 os.homedir() 的文件，且不在已审核清单中
    When 运行检查脚本
    Then 判定失败，提示复查方案 B 的拦截表（gateway/proxy/member-policy.mjs）

  Scenario: UPG-12 上游新增运行 git 的文件 [自动] v4.4
    Given 上游新增了一个运行 git 的文件，且不在已审核清单中
    When 运行检查脚本
    Then 判定失败，提示复查隔离模式下仓库配置里的命令执行风险

  Scenario: UPG-06 上游补丁可识别 [自动]
    Then 上游源码中所有隔离改动都引用 server/shared/isolation.ts
    And 改动文件与 04-上游文件改动清单.md 一致
```

---

## Feature 9：全局配置保护（POL，方案 B，v4.3）

```gherkin
Feature: 普通账号不能通过界面或 API 修改所有账号共用的配置

  Scenario Outline: POL-01 全局写接口对普通账号返回 403，且没有写入文件 [自动] v4.3
    Given 我以 projA 登录
    When 我请求 <request>
    Then 返回 403，错误码 GATEWAY_MEMBER_FORBIDDEN，提示「普通账号不能修改全局配置」
    And ~/.claude.json、~/.claude/skills、~/.gitconfig 均未变化

    Examples:
      | request                                                   |
      | POST /api/providers/claude/mcp/servers（scope=user）       |
      | POST /api/providers/mcp/servers/global（scope=user）       |
      | DELETE /api/providers/claude/mcp/servers/x?scope=user      |
      | POST /api/providers/claude/skills                          |
      | DELETE /api/providers/claude/skills/x                      |
      | POST /api/plugins/install                                  |
      | PUT /api/plugins/p/enable                                  |
      | POST /api/plugins/p/update                                 |
      | DELETE /api/plugins/p                                      |
      | POST /api/system/update                                    |
      | PUT /api/browser-use/settings                              |
      | POST /api/browser-use/runtime/install                      |
      | POST /api/user/git-config                                  |

  Scenario Outline: POL-02 换个写法也绕不过 [自动] v4.3
    When 我请求 <request>
    Then 返回 403

    Examples:
      | request                                                         |
      | POST /API/System/Update                                         |
      | POST /api/system/update/                                        |
      | POST //api//system//update                                      |
      | POST /api/%73ystem/update                                       |
      | POST /api/Providers/Claude/Skills/                              |
      | DELETE /api/providers/claude/mcp/servers/x?scope=project&scope=user |
      | DELETE /api/providers/claude/mcp/servers/x?scope=USER           |

  Scenario: POL-03 普通账号的正常功能不受影响 [自动] v4.3
    When 我在本账号目录新增、删除项目级和 local 级 MCP，并查看 MCP、Skills、插件、git 配置、browser-use 设置
    Then 全部成功

  Scenario: POL-04 管理员仍可修改全局配置 [自动] v4.3
    When admin 新增用户级 MCP、新增 Skill、保存 git 配置
    Then 全部成功
    And projA 的 MCP 列表中能看到 admin 新增的用户级 MCP

  Scenario: POL-05 普通账号跳过首次引导 [自动] v4.3
    When projA 首次进入
    Then 引导已完成，不会停在需要保存全局 git 配置的步骤
```

---

## Feature 10：间接越界入口加固（HARD，v4.4）

```gherkin
Feature: 通过文件名、仓库配置、克隆地址、共用临时目录间接越界的入口已加固

  Scenario: HARD-01 文件接口不能改写 .git 内部 [自动] v4.4
    Given projC 有一个已初始化的 git 项目
    When 我通过文件接口写入 .git/config 或 .git/hooks/pre-commit、在 .git/hooks 下新建文件、把文件重命名为 .git、删除 .git
    Then 全部返回 403，.git/config 没有变化，hooks 没有被创建
    And 普通文件（如 .gitignore）仍可编辑

  Scenario: HARD-02 成员进程里 git 不执行仓库配置的 fsmonitor [自动] v4.4
    Given 项目的 .git/config 里（从终端写入）配置了 core.fsmonitor 命令
    And 对照：直接运行 git status 时该命令会被执行
    When 我通过界面请求 git status
    Then 状态正常返回，该命令没有被执行

  Scenario: HARD-03 Taskmaster 文档名不能带路径 [自动] v4.4
    When 我用 ../ 形式的 fileName 读取、解析、套用模板
    Then 全部返回 400，projB 的文件没有被读到或改动
    And 合法的文档名（如 plan.md）仍可保存和读取

  Scenario: HARD-04 克隆只接受远程地址 [自动] v4.4
    When projC 克隆来源填本机仓库路径、file:// 地址或相对路径
    Then 进度流返回「只能克隆远程仓库」，没有任何内容被克隆
    And 管理员用同样的本机路径不被拒绝（与上游一致）

  Scenario: HARD-05 /tmp 只读范围收窄 [自动] v4.4
    When projC 列出 /tmp，或读取 /tmp 下其他文件、其他账号的 Claude 任务输出
    Then 全部被拒绝
    And 本账号的 Claude 任务输出 <tmp>/claude-<uid>/<本账号编码>/… 仍可读取
    And 管理员仍可列出 /tmp

  Scenario: HARD-06 MCP、Skills 没指定目录时落在本账号目录 [自动] v4.4
    When projC 新增项目级 MCP 但不指定 workspacePath
    Then 写入 projC 的目录，共用的安装目录没有变化

  Scenario: HARD-08 命令文件经符号链接读不出别的账号的内容 [自动] v4.4
    Given projC 的 .claude/commands 下有一个指向 projB 文件的符号链接，另有自己的命令和用户级命令
    When 我执行经符号链接的命令
    Then 返回 403，内容没有被读出
    And 自己的命令和用户级 ~/.claude/commands 下的命令照常可用

  Scenario: HARD-09 git 的文件参数指向工作区外时在应用层被拒绝 [自动] v4.4
    When 我用 ../ 形式的文件参数请求 git diff 和 file-with-diff
    Then 返回「超出本账号工作区」，而不是只靠 git 自己报错
    And 项目内的文件不受影响

  Scenario: HARD-10 Taskmaster 和命令列表经符号链接读不出别的账号的内容 [自动] v4.4
    Given projC 项目里 .taskmaster/docs、.taskmaster/tasks/tasks.json、.claude/commands 下各有一个指向 projB 文件的符号链接
    When 我读取 PRD 文档、任务列表、命令列表
    Then 文档返回 403，任务和命令列表里没有 projB 文件的内容
    And 自己的文档和命令照常可用

  Scenario: HARD-07 项目内的符号链接不能绕过限制 [自动] v4.4
    Given projC 的项目里有符号链接：指向 .git、指向 projB 的目录、指向项目内的 sub
    When 我通过文件接口经指向 .git 的链接写入 config 或 hooks
    Then 返回 403，.git/config 没有变化
    When 我经指向 projB 的链接写入、读取、删除文件
    Then 全部返回 403，projB 的文件没有被读到或改动
    And 经指向项目内部的链接写入仍然成功
```

---

## 场景统计

| Feature | 场景数 | 自动 | 手工 |
|---|---|---|---|
| 1 账号管理 ACC | 10 | 8 | 2 |
| 2 登录与入口 AUTH | 16 | 13 | 3 |
| 3 工作目录 WS | 6 | 4 | 2 |
| 4 项目与会话 SES | 9 | 8 | 1 |
| 5 API 越权 API | 13 | 13 | 0 |
| 6 子进程 PROC | 13 | 11 | 2 |
| 7 Claude 登录 CL | 2 | 1 | 1 |
| 8 部署升级 UPG | 12 | 12 | 0 |
| 9 全局配置保护 POL | 5 | 5 | 0 |
| 10 间接越界加固 HARD | 10 | 10 | 0 |
| **合计** | **96** | **85** | **11** |

---

## 实现覆盖（2026-10-24，`cloudcli-multi check`）

- 文中 68 个 `[自动]` 场景全部已实现。另外 5 个标为 `[手工]` 的场景也做了自动化：ACC-01、ACC-03、AUTH-02、AUTH-06、AUTH-08。
- 检查脚本另外补了 5 个子场景：AUTH-07b、AUTH-08b、AUTH-14b（jsdom 执行注入脚本），PROC-00b、PROC-05b（空闲回收阶段）。
- 一次完整运行共 106 项（含 UPG-04 上游测试），约 2 分钟。
- UPG-11（v4.3）：上游新增引用 home 目录的文件时失败，提醒复查方案 B 的拦截表。
- 真实浏览器（`check --browser`，2026-10-25）：BR-01～11 共 13 项，覆盖原手工场景中能在浏览器里自动完成的部分，包括 AUTH-02/06/07/08 的真实页面行为，以及管理员首次引导。
- 变异测试（2026-10-25）：逐个去掉 15 处保护后重跑检查，用来确认每处保护都有对应的场景能发现它被移除，结果见 `mydocs/07-验证报告.md`。
- 另有一组端到端场景（`gateway/check/scenarios/e2e.mjs`），用 3 个普通账号验证：
  - ISO-01～05：两两交叉越权，包括项目、会话、搜索、文件读写、别人的 sessionId/projectId、在别人目录新建会话或项目、设置；
  - FUN-01～09：在网关后面实际使用各项功能，包括静态资源、新建和重命名项目、文件增删改查、git、读取和重命名会话、网页终端、聊天 WebSocket、上传附件、MCP/Skills；
  - GLB-01～07：探测普通账号对工作目录以外的改动能力，只记录结果，不计入通过/失败，结论见 `01-需求说明.md` 第 7 节。
- 与 BDD 原文有出入的地方：
  - **WS-05**：`-w-projA-tmp` 一行属于已知限制 T-4，脚本不对它做断言；
  - **API-10**：上游只有 Skills 的列表接口接受 `workspacePath`，新增、删除只作用于用户级目录，因此只检查列表；
- 仍需手工验证（需要真实浏览器或真实的 Claude 登录）：WS-04、WS-06、SES-09、PROC-06、PROC-09、CL-01。
