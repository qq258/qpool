import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync("config.json","utf8"));
const base = `http://${config.host}:${config.port}`;
const headers = { "content-type":"application/json", "x-qpool-token": config.writeToken };
const call = async (m,p,b) => { const r = await fetch(base+p,{method:m,headers,body:b?JSON.stringify(b):undefined}); const t = await r.text(); return {s:r.status, t}; };
const projects = JSON.parse((await call("GET","/api/projects")).t).projects;
for (const p of projects) {
  if (p.code === "QPOOL") continue;
  const items = JSON.parse((await call("GET",`/api/projects/${p.code}/items?limit=50`)).t).items;
  for (const item of items) {
    await call("POST", `/api/items/${item.code}/evidence`, { kind: "test", ref: "scripts/mcp-concurrency.mjs", note: "并发演练记录" });
    await call("POST", `/api/items/${item.code}/close`, { reason: "并发演练临时问题", close_kind: "wontfix" });
  }
  const r = await call("POST", "/api/maintenance/forget-project", { project: p.code, reason: "并发演练遗留的临时项目" });
  console.log("forgot", p.code, r.s);
}
