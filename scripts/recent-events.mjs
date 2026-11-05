// Read-only peek at the newest audit events, including session attribution.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const db = new DatabaseSync(join(root, 'data', 'qpool.db'), { readOnly: true });
try {
  const rows = db
    .prepare(
      `SELECT i.code AS code, e.action, e.actor, e.session_id, e.at
       FROM events e LEFT JOIN items i ON i.id = e.item_id
       ORDER BY e.id DESC LIMIT 10`,
    )
    .all();
  for (const row of rows) {
    console.log(
      String(row.code ?? '-').padEnd(9),
      String(row.action).padEnd(12),
      String(row.actor).padEnd(12),
      row.session_id ?? '(none)',
      row.at,
    );
  }
} finally {
  db.close();
}
