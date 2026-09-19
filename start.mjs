#!/usr/bin/env node
// One command: scan this machine for AI agents, serve the office, open the browser.
import { fork } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
  console.log(`
  virtual-agents-office — a live isometric office for your AI agents

    npx virtual-agents-office            start it and open the browser
    --port <n>      port to serve on (default 4747)
    --demo          show the demo office instead of reading this machine
    --no-open       don't open a browser
    --host <h>      bind address (default 127.0.0.1)
`);
  process.exit(0);
}

const found = [
  ['Claude Code', path.join(os.homedir(), '.claude/projects')],
  ['Claude Code scheduled tasks', path.join(os.homedir(), '.claude/scheduled-tasks')],
  ['Codex', path.join(os.homedir(), '.codex/sessions')],
  ['Codex automations', path.join(os.homedir(), '.codex/automations')],
  ['Claude Cowork', path.join(os.homedir(), 'Library/Application Support/Claude/local-agent-mode-sessions')],
].filter(([, p]) => fs.existsSync(p)).map(([label]) => label);

console.log('\n  \x1b[1mvirtual-agents-office\x1b[0m');
if (has('--demo')) console.log('  demo office (--demo)');
else if (found.length) console.log('  found: ' + found.join(', '));
else console.log('  no agent history found yet — showing the demo office');

const env = { ...process.env };
if (val('--port')) env.PORT = val('--port');
if (val('--host')) env.HOST = val('--host');
if (has('--demo')) env.OFFICE_DEMO = '1';

const child = fork(path.join(HERE, 'server.mjs'), [], { env, stdio: 'inherit' });
child.on('message', (m) => {
  if (!m?.ready || has('--no-open')) return;
  const cmd = process.platform === 'darwin' ? ['open', [m.url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', m.url]] : ['xdg-open', [m.url]];
  execFile(cmd[0], cmd[1], () => {});
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0); });
