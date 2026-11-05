// Single entry point that runs every suite in one process.
// `node --test test/` spawns a child per file, which is blocked in restricted
// sandboxes (EPERM on piped stdio), so the suites are imported directly.
import './domain.test.ts';
import './http.test.ts';
import './mcp-tools.test.ts';
import './web.test.ts';
