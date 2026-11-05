import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync("config.json","utf8"));
const base = `http://${config.host}:${config.port}`;
const headers = { "content-type":"application/json", "x-qpool-token": config.writeToken };
const call = async (m,p,b) => { const r = await fetch(base+p,{method:m,headers,body:b?JSON.stringify(b):undefined}); const t = await r.text(); if(!r.ok) throw new Error(`${m} ${p} ${r.status} ${t.slice(0,200)}`); return t?JSON.parse(t):null; };

// 1. close the leftover open smoke duplicate, then purge every synthetic record
await call("POST", "/api/items/QPOOL-19/links", { type: "duplicate_of", to: "QPOOL-4" });
await call("POST", "/api/items/QPOOL-19/close", {
  close_kind: "duplicate",
  reason: "协议回归产生的重复记录，已合并到 QPOOL-4",
  evidence: [{ kind: "test", ref: "test/mcp-session.jsonl" }],
});

const purge = ["QPOOL-5", "QPOOL-12", "QPOOL-18", "QPOOL-19", "QPOOL-20", "QPOOL-21", "QPOOL-22"];
for (const code of purge) {
  const result = await call("POST", "/api/maintenance/purge", {
    item: code,
    reason: code < "QPOOL-13" ? "同一次 MCP 冒烟产生的重复记录，合并到 QPOOL-4 后清理" : "旧版端到端脚本误写入正式池的测试数据",
  });
  console.log("purged", result.code, result.purged);
}

for (const project of ["E2EWYC6", "E2EX5WP"]) {
  const result = await call("POST", "/api/maintenance/forget-project", {
    project,
    reason: "端到端回归的临时项目，目录已删除",
  });
  console.log("forgot", result.code, result.forgotten);
}

const brief = await call("GET", "/api/projects/QPOOL/brief");
console.log("counts:", JSON.stringify(brief.counts));
console.log("gate:", brief.gate.pass ? "PASS" : "FAIL", "|", brief.gate.reasons.join("; "));
const open = await call("GET", "/api/projects/QPOOL/items?limit=50");
for (const item of open.items) console.log(" open:", item.code, item.severity, item.title);
const projects = await call("GET", "/api/projects");
console.log("projects:", projects.projects.map((p) => p.code).join(", "));
