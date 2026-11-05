// Minimal HTTP client for maintenance from the shell.
//   node scripts/api.mjs GET /api/projects
//   node scripts/api.mjs GET "/api/projects/QPOOL/brief"
//   node scripts/api.mjs POST /api/items '{"project":"QPOOL","title":"..."}'
//   node scripts/api.mjs PATCH /api/items/QPOOL-3 '{"version":2,"status":"blocked"}'
// The write token comes from config.json; it is never printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));

const [method = 'GET', path, body] = process.argv.slice(2);
if (!path) {
  console.error('usage: node scripts/api.mjs <GET|POST|PATCH|DELETE> <path> [json-body]');
  process.exit(2);
}

const headers = { 'content-type': 'application/json' };
if (method.toUpperCase() !== 'GET') headers['x-qpool-token'] = config.writeToken;

const response = await fetch(`http://${config.host}:${config.port}${path}`, {
  method: method.toUpperCase(),
  headers,
  body: body === undefined ? undefined : body,
});

const text = await response.text();
let output = text;
try {
  output = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  /* keep raw text */
}
console.log(`# ${response.status} ${method.toUpperCase()} ${path}`);
console.log(output);
process.exitCode = response.ok ? 0 : 1;
