import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync("config.json","utf8"));
const r = await fetch(`http://${config.host}:${config.port}/api/projects/QPOOL/items?includeClosed=1&limit=50`);
const j = await r.json();
for (const item of j.items.slice().sort((a,b)=>a.code.localeCompare(b.code, undefined, {numeric:true}))) {
  console.log(item.code.padEnd(9), item.status.padEnd(13), (item.severity+"/"+item.kind).padEnd(16), (item.parent_id ?? "-").toString().padEnd(3), item.title);
}
