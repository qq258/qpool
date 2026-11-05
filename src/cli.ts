import { spawn } from 'node:child_process';
import { baseUrl, loadConfig } from './core/config.ts';
import { restoreDatabase, inspectBackup } from './core/restore.ts';
import { SCHEMA_VERSION } from './core/schema.ts';
import { ensureService, LOG_FILE, probe, readPid, stopService } from './core/service-control.ts';
import { displayWidth, padCell } from './core/util.ts';

const USAGE = `qpool - local issue pool for DSH sessions

  node src/cli.ts start [--foreground]   start the service (detached by default)
  node src/cli.ts stop                   stop the service
  node src/cli.ts open [--print]         open the read-only console in the default browser
  node src/cli.ts status                 show health + pid + data path
  node src/cli.ts projects               table: code / issues / open / locks / state
  node src/cli.ts export <PROJECT|--all> write .qpool snapshots
  node src/cli.ts backup [--keep N]      consistent SQLite backup into data/backups (default keep 10)
  node src/cli.ts restore <backup.db>    replace the live database with a backup (keeps the old file)
  node src/cli.ts doctor                 integrity, counts, marker and snapshot checks
  node src/cli.ts help                   this text
`;

async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  const config = loadConfig();

  switch (command) {
    case 'start': {
      if (rest.includes('--foreground')) {
        await import('./http/serve.ts');
        return new Promise<number>(() => 0);
      }
      if (await probe(config)) {
        process.stdout.write(`already running on ${baseUrl(config)} (pid ${readPid() ?? '?'})\n`);
        return 0;
      }
      const result = await ensureService(config);
      process.stdout.write(
        `qpool ${result.started ? 'started' : 'already running'} on ${result.url} (pid ${result.pid ?? '?'})\n` +
          `log: ${LOG_FILE}\ndb:  ${config.dbPath}\n`,
      );
      return 0;
    }

    case 'stop': {
      const stopped = await stopService(config);
      process.stdout.write(stopped ? 'qpool stopped\n' : 'qpool is still running\n');
      return stopped ? 0 : 1;
    }

    case 'status': {
      const up = await probe(config);
      const pid = readPid();
      let health: unknown = null;
      if (up) {
        try {
          health = await (await fetch(`${baseUrl(config)}/health`)).json();
        } catch {
          health = null;
        }
      }
      process.stdout.write(
        `${JSON.stringify(
          { running: up, pid, url: baseUrl(config), db: config.dbPath, log: LOG_FILE, health },
          null,
          2,
        )}\n`,
      );
      return up ? 0 : 1;
    }

    case 'export': {
      const target = rest[0];
      if (!target) {
        process.stderr.write('usage: node src/cli.ts export <PROJECT|--all>\n');
        return 2;
      }
      await ensureService(config);

      const exportOne = async (code: string): Promise<boolean> => {
        const response = await fetch(`${baseUrl(config)}/api/projects/${encodeURIComponent(code)}/export`, {
          method: 'POST',
          headers: { 'x-qpool-token': config.writeToken, 'content-type': 'application/json' },
          body: '{}',
        });
        process.stdout.write(`${await response.text()}\n`);
        return response.ok;
      };

      if (target === '--all' || target === 'all') {
        const projects = (await (await fetch(`${baseUrl(config)}/api/projects`)).json()) as {
          projects: Array<{ code: string }>;
        };
        let ok = true;
        for (const project of projects.projects) ok = (await exportOne(project.code)) && ok;
        return ok ? 0 : 1;
      }
      return (await exportOne(target)) ? 0 : 1;
    }

    case 'restore': {
      const file = rest[0];
      if (!file) {
        process.stderr.write('usage: node src/cli.ts restore <backup.db>\n');
        return 2;
      }

      // Inspect first: never stop a healthy service for an unusable backup.
      const info = inspectBackup(file);
      process.stdout.write(
        `backup: ${info.file} (${(info.bytes / 1024).toFixed(1)} KB, integrity=${info.integrity}, schema=v${info.schema_version}, ${info.projects} projects, ${info.items} items)\n`,
      );
      if (!info.ok) {
        process.stderr.write('refusing to restore: backup failed integrity_check\n');
        return 1;
      }
      if (info.schema_version > SCHEMA_VERSION) {
        process.stderr.write(`refusing to restore: backup schema v${info.schema_version} is newer than v${SCHEMA_VERSION}\n`);
        return 1;
      }

      const wasRunning = await probe(config);
      if (wasRunning) {
        await stopService(config);
        process.stdout.write('service stopped\n');
      }

      const result = restoreDatabase(file, config.dbPath, { currentSchema: SCHEMA_VERSION });
      process.stdout.write(`restored -> ${result.target}\n`);
      if (result.previous) process.stdout.write(`previous database kept at ${result.previous}\n`);

      const started = await ensureService(config);
      process.stdout.write(`service running at ${started.url} (pid ${started.pid ?? '?'})\n`);
      return 0;
    }

    case 'backup': {
      await ensureService(config);
      const keepIndex = rest.indexOf('--keep');
      const keep = keepIndex >= 0 ? Number(rest[keepIndex + 1] ?? 10) : 10;
      const response = await fetch(`${baseUrl(config)}/api/maintenance/backup`, {
        method: 'POST',
        headers: { 'x-qpool-token': config.writeToken, 'content-type': 'application/json' },
        body: JSON.stringify({ keep }),
      });
      const payload = (await response.json()) as { path?: string; bytes?: number; removed?: string[]; error?: { message?: string } };
      if (!response.ok || !payload.path) {
        process.stderr.write(`backup failed: ${payload.error?.message ?? response.status}\n`);
        return 1;
      }
      process.stdout.write(`backup: ${payload.path} (${((payload.bytes ?? 0) / 1024).toFixed(1)} KB)\n`);
      if (payload.removed?.length) process.stdout.write(`removed ${payload.removed.length} older backup(s)\n`);
      return 0;
    }

    case 'doctor': {
      if (!(await probe(config))) {
        process.stderr.write(`service is not running at ${baseUrl(config)}; run "node src/cli.ts start"\n`);
        return 1;
      }
      const report = (await (await fetch(`${baseUrl(config)}/api/maintenance/doctor`)).json()) as {
        ok: boolean;
        db: { path: string; integrity: string; size_bytes: number; journal_mode: string };
        counts: Record<string, number>;
        projects: Array<{
          code: string;
          status: string;
          root_exists: boolean;
          marker_code: string | null;
          snapshot_age_ms: number | null;
          problems: string[];
        }>;
        problems: string[];
      };

      const mb = (report.db.size_bytes / 1024 / 1024).toFixed(2);
      process.stdout.write(`qpool doctor\n`);
      process.stdout.write(`  db       ${report.db.path} (${mb} MB, integrity=${report.db.integrity}, journal=${report.db.journal_mode})\n`);
      process.stdout.write(
        `  counts   projects ${report.counts.projects} · items ${report.counts.items} · open ${report.counts.open} · events ${report.counts.events} · evidence ${report.counts.evidence} · backups ${report.counts.backups}\n`,
      );
      for (const project of report.projects) {
        const age = project.snapshot_age_ms === null ? 'none' : `${Math.round(project.snapshot_age_ms / 1000)}s`;
        process.stdout.write(
          `  project  ${project.code} [${project.status}] root=${project.root_exists ? 'ok' : 'MISSING'} marker=${project.marker_code ?? 'none'} snapshot=${age}\n`,
        );
      }
      if (report.problems.length === 0) {
        process.stdout.write('  result   OK\n');
      } else {
        for (const problem of report.problems) process.stdout.write(`  problem  ${problem}\n`);
        process.stdout.write('  result   NEEDS ATTENTION\n');
      }
      return report.ok ? 0 : 1;
    }

    case 'open': {
      await ensureService(config);
      const url = baseUrl(config);
      if (rest.includes('--print')) {
        process.stdout.write(`${url}\n`);
        return 0;
      }
      const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      try {
        spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        process.stdout.write(`opened ${url}\n`);
        return 0;
      } catch (err) {
        process.stdout.write(`could not launch a browser (${(err as Error).message}); open this URL manually:\n${url}\n`);
        return 1;
      }
    }

    case 'projects': {
      await ensureService(config);
      const payload = (await (await fetch(`${baseUrl(config)}/api/projects`)).json()) as {
        projects: Array<{
          code: string;
          name: string;
          status: string;
          item_count: number;
          open_count: number;
          claimed_other: number;
          claimed_sessions: number;
          claimed_other_codes: string[];
        }>;
      };
      if (payload.projects.length === 0) {
        process.stdout.write('还没有注册任何项目。\n');
        return 0;
      }

      const rows = payload.projects.map((project) => [
        project.code,
        project.name,
        String(project.item_count),
        String(project.open_count),
        project.claimed_other > 0 ? `${project.claimed_other} 项（${project.claimed_sessions} 对话）` : '—',
        project.status === 'archived' ? '已冻结' : '进行中',
      ]);
      const titles = ['代码', '项目', '问题', '未闭环', '被对话锁定', '状态'];
      const widths = titles.map((title, index) =>
        Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[index] ?? ''))) + 2,
      );
      const line = (cells: string[]) => cells.map((cell, index) => padCell(cell, widths[index] ?? 0)).join('').trimEnd();

      process.stdout.write(`qpool 项目（${payload.projects.length} 个）\n\n`);
      process.stdout.write(`${line(titles)}\n`);
      process.stdout.write(`${line(widths.map((width) => '-'.repeat(Math.max(2, width - 2))))}\n`);
      for (const row of rows) process.stdout.write(`${line(row)}\n`);
      for (const project of payload.projects) {
        if (project.claimed_other > 0) {
          process.stdout.write(`\n${project.code} 被锁定：${project.claimed_other_codes.join(', ')}\n`);
        }
      }
      return 0;
    }

    case 'help':
    default:
      process.stdout.write(USAGE);
      return command === 'help' ? 0 : 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
