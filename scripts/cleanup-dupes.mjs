import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync("config.json","utf8"));
const base = `http://${config.host}:${config.port}`;
const headers = { "content-type":"application/json", "x-qpool-token": config.writeToken };
const call = async (m,p,b) => { const r = await fetch(base+p,{method:m,headers,body:b?JSON.stringify(b):undefined}); const t = await r.text(); return {s:r.status,j:t?JSON.parse(t):null}; };
// merge the duplicated smoke item into QPOOL-4
const link = await call("POST", "/api/items/QPOOL-5/links", { type: "duplicate_of", to: "QPOOL-4" });
console.log("link QPOOL-5 -> QPOOL-4:", link.s);
const closed5 = await call("POST", "/api/items/QPOOL-5/close", { close_kind: "duplicate", reason: "第一次批量会话被中断后重跑产生的重复记录，合并到 QPOOL-4", evidence: [{ kind: "test", ref: "test/mcp-out.jsonl" }] });
console.log("close QPOOL-5:", closed5.s, closed5.j?.item?.status ?? closed5.j?.error?.message);
const closed4 = await call("POST", "/api/items/QPOOL-4/close", { close_kind: "fixed", reason: "批量 JSON-RPC 会话验证通过：7 个请求全部返回，含一次真实写入与门禁查询。", evidence: [{ kind: "test", ref: "test/mcp-out.jsonl", note: "7 条响应，exit=0" }] });
console.log("close QPOOL-4:", closed4.s, closed4.j?.item?.status ?? closed4.j?.error?.message);
const gate = await call("GET","/api/projects/QPOOL/gate");
console.log("gate:", gate.j.pass, "| open", gate.j.open, "|", gate.j.reasons.join("; "));
const brief = await call("GET","/api/projects/QPOOL/brief");
console.log("counts:", JSON.stringify(brief.j.counts));
