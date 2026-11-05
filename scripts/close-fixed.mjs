import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync("config.json","utf8"));
const base = `http://${config.host}:${config.port}`;
const headers = { "content-type":"application/json", "x-qpool-token": config.writeToken };
const call = async (m,p,b) => { const r = await fetch(base+p,{method:m,headers,body:b?JSON.stringify(b):undefined}); const t = await r.text(); if(!r.ok) throw new Error(`${m} ${p} ${r.status} ${t}`); return t?JSON.parse(t):null; };

// de-duplicate the smoke item created by the protocol fixture
await call("POST", "/api/items/QPOOL-18/links", { type: "duplicate_of", to: "QPOOL-4" });
await call("POST", "/api/items/QPOOL-18/close", {
  close_kind: "duplicate",
  reason: "协议回归脚本重跑产生的重复记录，合并到 QPOOL-4；fixture 已加 client_op_id 幂等键",
  evidence: [{ kind: "test", ref: "test/mcp-session.jsonl" }],
});

const closes = [
  ["QPOOL-13", "fixed", "addLink 对 blocks 边做可达性检查（DFS），成环直接拒绝。", "test", "node test/run.ts", "新增用例 rejects blocks cycles"],
  ["QPOOL-14", "fixed", "新增 test/run.ts 单入口，同进程导入所有套件；package.json test 改为 node test/run.ts。", "test", "node test/run.ts", "25 个用例一次跑完，无子进程"],
  ["QPOOL-15", "fixed", "brief 直接返回 created_at，MCP 渲染不再用 age 反推时间；nowMinus 已删除。", "file", "src/core/brief.ts", "BriefItem 增加 created_at"],
  ["QPOOL-17", "fixed", "新增 test/http.test.ts：随机端口 + 临时库，覆盖鉴权、幂等、分页、错误码、静态资源。", "test", "node test/run.ts", "http surface 8 个用例"],
];

for (const [code, kind, reason, evKind, evRef, evNote] of closes) {
  await call("POST", `/api/items/${code}/evidence`, { kind: evKind, ref: evRef, note: evNote });
  const result = await call("POST", `/api/items/${code}/close`, { close_kind: kind, reason });
  console.log(code, "->", result.item.status);
}

const brief = await call("GET", "/api/projects/QPOOL/brief");
console.log("counts:", JSON.stringify(brief.counts));
console.log("gate:", brief.gate.pass ? "PASS" : "FAIL", "|", brief.gate.reasons.join("; "));
const open = await call("GET", "/api/projects/QPOOL/items?limit=50");
for (const item of open.items) console.log(" open:", item.code, item.severity, item.title);
