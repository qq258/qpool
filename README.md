# qpool

本机的**项目问题池**：DSH 在同一个项目的多轮对话里共用一份问题清单，问题按树拆解、带状态与证据、必须闭环；只有全部门禁通过，项目才算完成。

- **给 DSH 用**：15 个 MCP 工具（`mcp__qpool__*`），跨会话共享，不需要账号。
- **给人看**：`http://127.0.0.1:7817` 的**只读**控制台（项目列表 / 门禁 / 待签字 / 问题树 / 看板 / 详情 / 搜索）。
- **写权限只有 DSH**：控制台没有写接口；你只能通过 DSH 的对话来增删改，签字也是你把原话告诉 DSH，由 DSH 记录。

## 快速开始

```powershell
cd D:\project\abc\qpool

node src/cli.ts start      # 启动常驻服务（默认 detached，写 data/qpool.pid）
node src/cli.ts status     # 查看运行状态、端口、数据库路径
node src/cli.ts doctor     # 体检：库完整性、计数、marker、快照新鲜度
node src/cli.ts backup     # 立刻做一次一致性备份（VACUUM INTO，保留最近 10 份）
node src/cli.ts restore <backup.db>   # 用备份替换现库（旧库自动保留在旁边）
node src/cli.ts stop       # 停止
node src/cli.ts export --all   # 手动导出所有项目的快照
```

服务每次启动时，如果最近 24 小时没有备份，会自动做一份到 `data/backups/`（保留最近 10 份）。浏览器打开 <http://127.0.0.1:7817>。数据在 `data/qpool.db`（SQLite，WAL）。

第一次由 DSH 调用 MCP 工具时，如果服务没在跑，MCP 进程会自动把它拉起来；你也可以用上面的命令手动管理。

## 在 DSH 里挂载（一次性）

在 profile 的 `cordis.patch.yml`（`C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml`）末尾加一条：

```yaml
- id: mcp-qpool
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: qpool
    transport: stdio
    command: '<node.exe 的绝对路径>'
    args:
      - 'D:\project\abc\qpool\src\mcp\server.ts'
    cwd: 'D:\project\abc'
    toolCallTimeoutMs: 60000
```

重启 DSH 后，工具会以 `mcp__qpool__q_brief` 这样的名字出现在工具列表里。MCP 服务器的 `instructions` 会作为系统提示注入工作纪律（何时记录、闭环三要素、签字规则）。

## 新会话怎么连上（不需要手动操作）

1. DSH 启动会话时读 profile 的 `insert` 段 → 每个会话起一个 `node src/mcp/server.ts` 子进程（stdio）。
2. 该进程启动即探活 `http://127.0.0.1:7817/health`；服务没在跑就自己把它拉起来（detached），最多等 20 秒。
3. 工具以 `mcp__qpool__*` 出现在工具列表，`instructions` 注入系统提示。
4. 会话不知道项目短码时：`q_brief` 不带参数列出所有项目；或直接传 `root: <项目根目录>`，服务靠 `.qpool/project.json` 认出项目（`q_brief` / `q_list` / `q_gate` / `q_create` 都支持）。

判断是否连上：`logs/mcp-clients.ndjson` 每开一个会话就多一行握手记录（含 MCP 进程 pid、协议版本、客户端名）。

连不上时按顺序查：

| 现象 | 查什么 |
|---|---|
| 工具列表没有 `mcp__qpool__*` | profile 的 `insert` 段是否还在；DSH 是否重启过；`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` |
| 工具报 `UNREACHABLE` | `node src/cli.ts start`；`logs/server.log` |
| 报 `no qpool project found` | 传 `project` 短码或 `root` 路径；`q_projects` 看已注册项目 |

## 给其他 agent 用（Codex / 任何 MCP 客户端）

qpool 不是 DSH 专属：核心是「MCP stdio 服务器 + 本机 HTTP API」，任何支持 MCP 的客户端接上就能用同一个池子。

Codex 示例（`~/.codex/config.toml`）：

```toml
[mcp_servers.qpool]
command = 'D:\nvm\v26.5.1\node.exe'
args = ['D:\project\abc\qpool\src\mcp\server.ts']
startup_timeout_sec = 30
```

不需要 env：每个会话的 MCP 进程会用自己的 pid 作为会话标识（`mcp-<pid>`），审计里 actor 记为 `agent:<clientInfo.name>`，所以能分清是 DSH 还是 Codex 改的。

Codex 不一定会读 MCP 的 `instructions`，建议在项目 `AGENTS.md` 里放一段：

```markdown
本项目的问题记在 qpool（MCP 服务器 qpool）。开始前先 q_brief（可用 root 传项目路径），
动手前 q_claim 锁住问题，收尾 q_close/q_submit；blocker 必须先 q_submit 再等 owner 签字（q_signoff）。
不要另写 markdown TODO。
```

两个 agent 同时用同一个池子时的冲突由 `q_claim` 处理：一条问题同一时刻只属于一个会话，锁 2 小时未续期自动过期。


## 概念模型

一个 `item` 用 `kind` 区分问题类型，不做问题/任务双实体。

| 字段 | 取值 |
|---|---|
| `kind` | `defect` 缺陷 · `risk` 风险 · `question` 疑问 · `decision` 待决策 · `debt` 技术债 · `requirement` 需求变更 |
| `severity` | `blocker`（不解决项目不能算完成）· `major` · `minor` |
| `status` | `open` · `triaged` · `in_progress` · `blocked` · `waiting_review` · `closed` |
| `close_kind` | `fixed` · `accepted_risk` · `duplicate` · `wontfix` · `not_reproducible` |

三种关系分开建模：`parent_id`（拆分/树）、`links.blocks`（阻塞）、`links.relates / duplicate_of / split_from / discovered_from`（关联）。

编号：项目短码 + 序号（`QPOOL-12`）。树用 `parent_id` 表达，编号本身不编码层级，重排父节点不会让编号失效。

## 闭环规则（服务端强制）

1. **关闭必须有三样**：结论（`reason`）+ 至少一条证据 + 关闭人。
2. **父问题**：所有子问题 `closed` 才能关；父问题自己还要有验收结论。
3. **blocker 与 `accepted_risk`**：只能由人签字关闭。DSH 先 `q_submit`（提交到 `waiting_review`），把问题复述给 owner，拿到原话后 `q_signoff`（`quote` 必须是原话）。
4. 非 blocker：DSH 可以凭结论 + 证据自行关闭，记为 `closed_by_type=agent`。
5. `duplicate` 关闭前必须先有一条 `duplicate_of` 链接。

`q_gate` 的判定：所有问题 `closed`，且所有 blocker 都有 `human` 签字 → PASS。`accepted_risk` 计入闭环但会单独列出，便于在"带风险放行"时仍然可见。

## 项目总览与"锁定"

`q_projects`（不带 action）输出一张表：项目代码、名称、问题数、未闭环数、**被其他对话锁定**、状态。

```powershell
node src/cli.ts projects          # 同内容，命令行直接看
```

"锁定"= 某个对话（一个 DSH 会话 = 一个 MCP 进程）正在处理那条问题：

- 动手前 `q_claim { item }`，服务端把 `claimed_by` 记为当前会话；别的对话再认领会被拒绝，并告诉你持有者。
- 收尾 `q_release`；关闭问题会自动释放。
- **认领 2 小时未续期自动过期**，可被下一个对话接管（事件里记为 `claim_takeover`），避免崩溃的会话永久占着问题。
- 表里 `本对话` 表示是你自己这轮锁的；`N 项（M 个对话）` 表示别的对话占着。

**审计与会话归属**：每条变更都记录 actor 与会话标识。DSH 每个会话起一个独立 MCP 进程；进程在 initialize 时把 clientInfo / _meta / pid 记到 logs/mcp-clients.ndjson（超 64 KB 自截断），并用 `mcp-<pid>` 作为 session_id 落到事件上，控制台时间线会显示这个短标识。
**项目完成即冻结**：`q_gate` 返回 PASS 后，用 `q_projects action=archive`（可带 `reason`）把项目封存为只读——之后任何写入（新建、改状态、加证据、签字）都会被拒绝并提示解冻。需要补录时 `q_projects action=unarchive`，会留下审计记录。未全部闭环的项目不允许冻结。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `q_projects` | 列项目 / 注册（写 `.qpool/project.json`）/ 按路径反查 |
| `q_brief` | 摘要：门禁、待签字、未闭环 blocker、被阻塞、进行中、最近动作 |
| `q_list` | 分页过滤列表（状态/类型/严重级/父项/全文） |
| `q_show` | 单个问题的完整详情（含 `version`） |
| `q_create` | 记录问题（支持幂等键 `client_op_id`） |
| `q_create_batch` | 拆解：一次创建一批子问题 |
| `q_update` | 改字段/状态（`version` 乐观锁） |
| `q_claim` | 把问题锁定到当前对话 |
| `q_release` | 释放锁定（关闭会自动释放） |
| `q_evidence` | 追加证据（commit / test / file:line / url / repro / doc） |
| `q_link` | 建立/删除关联 |
| `q_close` | DSH 自行关闭非 blocker 问题（结论 + 证据） |
| `q_submit` | 提交到 `waiting_review`（结论 + 证据） |
| `q_signoff` | 记录 owner 原话并闭环（approve / accept_risk / reject） |
| `q_gate` | 项目完成门禁 |

工具输出都是紧凑文本；列表强制分页（上限 50），任何调用都不会把整池问题塞进上下文。

## 项目识别

1. 根目录下的 `.qpool/project.json` 是项目的身份（可随仓库提交，数据库重建后仍能认回）；
2. 没传 `project`/`root` 时，从会话工作目录向上找这个文件；
3. 都找不到就用注册表里最长的父路径匹配；
4. 仍然找不到 → 报错并列出已注册短码。

**服务不会拿自己的 cwd 猜项目**：写入接口要求显式 `project` 或 `root`，避免误写到错误的池子。

## 快照与备份

每次写入后 1.5 秒内（合并突发写）会把该项目导出到：

```
<项目根>/.qpool/issues.jsonl    # 一行一个问题，含证据/关联/关闭信息
<项目根>/.qpool/PROBLEMS.md     # 人读版：未闭环明细 + 问题树 + 已闭环回顾 + 门禁阻塞项
```

它们可以随仓库提交、diff、review。数据库本身在 `qpool/data/`，不进 git。

## 运维（仅限本机 operator）

只保留已闭环记录的软关闭，是为了让"闭环"有据可查；但误录和测试数据不应该永久污染问题池，所以另有一个 token 保护的运维面，**不暴露为 MCP 工具**（DSH 的词表里只有"关闭"，没有"删除"）：

```powershell
# 硬删一条已闭环记录（会写 purge 事件，保留谁在何时以何原因清理）
node scripts/api.mjs POST /api/maintenance/purge '{"item":"QPOOL-20","reason":"端到端脚本误写入的测试数据"}'

# 移除一个已无未闭环问题、目录已删的临时项目
node scripts/api.mjs POST /api/maintenance/forget-project '{"project":"E2E1234","reason":"临时回归项目"}'

# 查看 forget 记录
node scripts/api.mjs GET /api/maintenance/log
```

未闭环的记录不能 purge —— 先修复再关闭，或者把它改成 `wontfix` / `accepted_risk`（需要 owner 签字）。

## 备份与体检

- **自动备份**：服务启动时若最近 24 小时没有备份，自动 `VACUUM INTO` 一份到 `data/backups/qpool-<时间戳>.db`，保留最近 10 份。
- **手动备份**：`node src/cli.ts backup --keep 20`（VACUUM INTO 是 SQLite 的在线一致性备份，服务运行中也能做）。
- **体检**：`node src/cli.ts doctor` 检查 `integrity_check`、项目计数、`.qpool/project.json` marker 是否与注册表一致、快照是否过期、根目录是否还在（目录没了的临时项目会提示 `forget-project`）。退出码非 0 表示需要处理。
- **恢复**：`node src/cli.ts restore data/backups/qpool-<时间戳>.db`。先校验备份（`integrity_check` + schema 版本），再停服务、把现库改名成 `qpool.db.pre-restore-<时间戳>` 保留、拷入备份、重启并探活。备份损坏或版本过新会直接拒绝，不会动现库。项目身份靠各项目里的 `.qpool/project.json`，重启后会自动认回。

## 架构

```
DSH 会话 ──stdio MCP──► src/mcp/server.ts ──HTTP──► src/http/server.ts ──► SQLite (唯一写者)
                                                          │
你的浏览器 ◄──────────── 只读控制台 ──────────────────────┘
```

MCP 进程是瘦客户端，不直接开库：每个会话一个 stdio 进程，如果各自开 SQLite 会互相锁死在 Windows 上。

## 开发

```powershell
node scripts/verify.mjs        # 一条命令跑完：44 个用例 + 端到端 + 多会话并发 + MCP 协议 + 服务健康
node test/run.ts               # 只跑用例（领域/HTTP/MCP 工具/控制台渲染）
node scripts/dev-domain.mjs    # HTTP 端到端（隔离项目，用完自动清理）
node scripts/mcp-concurrency.mjs  # 3 个 MCP 进程同时写同一个池子，验证跨会话共享
cmd /c "node src\mcp\server.ts < test\mcp-session.jsonl"   # MCP 协议批量回归（只读 fixture）
node scripts/list.mjs          # 打印 QPOOL 全部问题
node scripts/api.mjs GET /api/projects/QPOOL/brief         # 命令行查问题池
```

零运行依赖：只用 `node:sqlite`、`node:http`、`node:readline` 与浏览器原生 API。Node ≥ 24（开发机为 26.5.1），TS 由 Node 原生剥类型运行，不需要构建。

## 排障

- `node src/cli.ts status` 看是否在跑；日志在 `logs/server.log`。
- 端口被占：改 `config.json` 的 `port` 后重启。
- 写入 403：写接口需要 `config.json` 里的 `writeToken`，只有 MCP 进程持有。
- 浏览器打开是空白：确认服务在跑，`http://127.0.0.1:7817/health` 应返回 JSON。
