// One command to prove the system is healthy end to end.
//   node scripts/verify.mjs
// Uses inherited stdio (no piped child output), so it also works inside the DSH sandbox.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const base = `http://${config.host}:${config.port}`;

const steps = [
  {
    name: 'unit + http + mcp-tool + web-console tests',
    command: process.execPath,
    args: ['test/run.ts'],
  },
  {
    name: 'live end-to-end (isolated project)',
    command: process.execPath,
    args: ['scripts/dev-domain.mjs'],
  },
  {
    name: 'multi-session MCP concurrency (3 processes, one pool)',
    command: process.execPath,
    args: ['scripts/mcp-concurrency.mjs'],
  },
  {
    name: 'MCP stdio protocol batch',
    command: process.platform === 'win32' ? 'cmd' : 'sh',
    args:
      process.platform === 'win32'
        ? ['/c', 'node src\\mcp\\server.ts < test\\mcp-session.jsonl > test\\mcp-out.jsonl 2>NUL']
        : ['-c', 'node src/mcp/server.ts < test/mcp-session.jsonl > test/mcp-out.jsonl 2>/dev/null'],
  },
];

let failed = 0;
for (const step of steps) {
  process.stdout.write(`\n=== ${step.name} ===\n`);
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(`[FAIL] ${step.name} (exit ${result.status ?? 'signal'})\n`);
  }
}

process.stdout.write('\n=== service ===\n');
try {
  const health = await (await fetch(`${base}/health`)).json();
  process.stdout.write(`health: ${JSON.stringify(health)}\n`);

  const doctor = await (await fetch(`${base}/api/maintenance/doctor`)).json();
  process.stdout.write(
    `doctor: integrity=${doctor.db.integrity} · ${doctor.counts.items} items · ${doctor.counts.open} open · ${doctor.problems.length} problem(s)\n`,
  );
  if (doctor.db.integrity !== 'ok') failed += 1;

  const projects = (await (await fetch(`${base}/api/projects`)).json()).projects;
  for (const project of projects) {
    const gate = await (await fetch(`${base}/api/projects/${project.code}/gate`)).json();
    process.stdout.write(`${project.code}: ${gate.pass ? 'GATE PASS' : 'GATE FAIL'} · ${gate.closed}/${gate.total} closed · ${gate.open} open\n`);
  }
} catch (err) {
  failed += 1;
  process.stdout.write(`[FAIL] service unreachable at ${base}: ${err.message}\n`);
}

let mcpLines = 0;
try {
  mcpLines = readFileSync(join(root, 'test', 'mcp-out.jsonl'), 'utf8').trim().split('\n').length;
} catch {
  mcpLines = 0;
}
process.stdout.write(`\nMCP batch responses: ${mcpLines}\n`);
process.stdout.write(failed === 0 ? '\nALL CHECKS PASSED\n' : `\n${failed} STEP(S) FAILED\n`);
process.exitCode = failed === 0 ? 0 : 1;
