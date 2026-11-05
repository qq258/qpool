const base = "http://127.0.0.1:7817";
const h = await (await fetch(base + "/health")).json();
console.log("health pid:", h.pid, "uptime", h.uptimeMs);
try { process.kill(h.pid); console.log("kill sent"); } catch (e) { console.log("kill failed:", e.code, e.message); }
await new Promise(r => setTimeout(r, 800));
try { const h2 = await (await fetch(base + "/health", { signal: AbortSignal.timeout(500) })).json(); console.log("still up, pid", h2.pid); } catch { console.log("probe failed -> stopped"); }
