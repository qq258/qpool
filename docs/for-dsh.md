# 给 DSH 的工作说明（qpool）

> 这份文件和 MCP 服务器的 `instructions` 是同一条纪律。MCP 工具前缀：`mcp__qpool__`。

## 一句话

项目里的**问题**（缺陷、风险、待决、疑问、技术债、需求变更）记进 qpool，不写 markdown TODO；问题不闭环，项目就不算完成。

## 每轮怎么用

1. **会话开始**：`q_brief`（不带参数看所有项目，带 `project` 看细节）。若列表里有 `REVIEW`，先把它们复述给 owner 拿签字。
2. **干活时**：发现真问题就 `q_create`；大问题 `q_create_batch` 拆子项；同一处反复出问题先 `q_list q=关键词` 查有没有已记录，避免重复。
3. **动手前先锁**：`q_claim { item }` 把问题锁定到当前对话；别的对话持有会拒绝你（告诉持有者）。收尾 `q_release`，关闭问题会自动释放；锁 2 小时未续期会过期。
4. **改状态**：先 `q_show` 拿 `version`，再 `q_update`（带 version）。
5. **收尾**：非 blocker 用 `q_close`（结论 + 证据）自行闭环；需要 owner 拍板的走 `q_submit` 再要签字。
6. **报告完成前**：`q_gate`，PASS 才能说项目完成。
7. **项目完结**：owner 确认后 `q_projects action=archive project=<短码> reason=...` 冻结项目；此后所有写入会被拒绝，要补录先 `action=unarchive`。

## 记录的门槛

记：可复现的缺陷、有后果的风险、需要拍板的决策、解释不了的疑问、明确的债、范围变更。
不记：实施步骤、一次性的操作、纯口味偏好。标题写"什么不满足预期"，body 写现象/复现/影响/已排查。

## 闭环三要素

- **结论**：改了什么、如何验证、遗留什么。
- **证据**：至少一条，优先 `test`（命令与结果）或 `commit`，其次 `file:line`、`repro`。
- **关闭人**：agent 或 human，落库可查。

父问题要先关完子问题；父问题自己的验收结论不能省。

## 签字协议

blocker 与"接受风险"只能由 owner 签字：

1. `q_submit { item, conclusion, evidence }` → `waiting_review`。
2. 向 owner 复述：问题是什么、改了什么、证据是什么、打算以什么方式关闭。
3. owner 给出原话（例如"同意闭环，我确认了"）。
4. `q_signoff { item, decision: 'approve', quote: 'owner 的原话' }`。

**硬规则**：`quote` 必须是 owner 的真实原话，一个字都不要替他说。没有原话就继续 `in_progress`，不要自己造一个。`accepted_risk` 同理，且必须写清为什么要接受。

## 项目注册

新项目第一次使用时：`q_projects action=init path=<项目根绝对路径>`。这会写 `.qpool/project.json`，之后新会话自动认回。短码默认从目录名推导，可显式指定 2-12 位大写字母数字。

## 新会话如何认出项目

会话开始不需要交接：MCP 工具已经在工具列表里。不确定短码时两种做法：

1. `q_brief` 不带参数 → 列出所有项目与未闭环数；
2. 直接传路径：`q_brief { root: "D:\project\abc\qq-deepseek-bot" }`，服务靠 `.qpool/project.json` 认出项目。

`q_brief` / `q_list` / `q_gate` / `q_create` 都接受 `root` 代替 `project`；拿到短码后统一用短码即可。

## 反模式

- ❌ 用 `q_create` 记"第 3 步：改 config"（那是任务，不是问题）。
- ❌ 关闭时不写证据，或证据写"已修复"三个字。
- ❌ blocker 自己 `q_close`（服务端会拒绝）。
- ❌ 编造 owner 的签字原话。
- ❌ 拿 `q_list` 不分页地拉全池灌进上下文。
