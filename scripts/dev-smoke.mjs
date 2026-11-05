// M0 smoke check: start the service, register the qpool project itself, list it.
// Reads the write token from config.json so the token never lands in chat.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const base = `http://${config.host}:${config.port}`;

async function call(method, path, body, write = false) {
  const headers = { 'content-type': 'application/json' };
  if (write) headers['x-qpool-token'] = config.writeToken;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

const health = await call('GET', '/health');
console.log('health', health.status, JSON.stringify(health.payload));

const registered = await call('POST', '/api/projects', { path: root, code: 'QPOOL', name: 'qpool issue pool' }, true);
console.log('register', registered.status, JSON.stringify(registered.payload, null, 2));

const list = await call('GET', '/api/projects');
console.log('list', list.status, JSON.stringify(list.payload));

const unauth = await call('POST', '/api/projects', { path: root }, false);
console.log('unauth write blocked', unauth.status, JSON.stringify(unauth.payload));

const resolved = await call('GET', '/api/resolve?root=' + encodeURIComponent(join(root, 'src')));
console.log('resolve from subdir', resolved.status, JSON.stringify(resolved.payload));
