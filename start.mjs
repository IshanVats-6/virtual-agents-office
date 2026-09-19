#!/usr/bin/env node
// One command: scan this machine for AI agents, serve the office, open the browser.
import { fork, execFile } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'IshanVats-6/virtual-agents-office';
const SITE = 'https://ivconsulting.in/?source=virtual-agents-office';
const PREFS = path.join(os.homedir(), '.config', 'virtual-agents-office', 'prefs.json');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const c = { dim: (t) => `\x1b[2m${t}\x1b[0m`, b: (t) => `\x1b[1m${t}\x1b[0m`, g: (t) => `\x1b[38;5;156m${t}\x1b[0m`, p: (t) => `\x1b[38;5;211m${t}\x1b[0m` };

if (has('--help') || has('-h')) {
  console.log(`
  ${c.b('virtual-agents-office')} - a live isometric office for your AI agents

    npx github:${REPO}          start it and open the browser

    --port <n>     port to serve on (default 4747)
    --host <h>     bind address (default 127.0.0.1)
    --demo         show the demo office instead of reading this machine
    --no-open      don't open a browser
    --no-prompt    never ask about starring the repo
    --label        let an AI CLI you already have name the roles, teams and departments
    --label --print  print the labelling prompt instead of running a CLI
`);
  process.exit(0);
}

if (has('--label')) {
  const { run } = await import('./label.mjs');
  await run(argv);
  process.exit(0);
}

const prefs = (() => { try { return JSON.parse(fs.readFileSync(PREFS, 'utf8')); } catch { return {}; } })();
const savePrefs = (p) => { try { fs.mkdirSync(path.dirname(PREFS), { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify({ ...prefs, ...p }, null, 2)); } catch {} };

const sources = [
  ['Claude Code', path.join(os.homedir(), '.claude/projects')],
  ['Claude Code tasks', path.join(os.homedir(), '.claude/scheduled-tasks')],
  ['Codex', path.join(os.homedir(), '.codex/sessions')],
  ['Codex automations', path.join(os.homedir(), '.codex/automations')],
  ['Cowork', path.join(os.homedir(), 'Library/Application Support/Claude/local-agent-mode-sessions')],
].filter(([, p]) => fs.existsSync(p)).map(([l]) => l);

console.log(`\n  ${c.b('virtual agents office')}  ${c.dim('your agents, as an office you can walk around')}`);
if (has('--demo')) console.log(`  ${c.dim('demo office (--demo)')}`);
else if (sources.length) console.log(`  ${c.dim('found: ' + sources.join(', '))}`);
else console.log(`  ${c.dim('no agent history here yet - showing the demo office')}`);

const env = { ...process.env };
if (val('--port')) env.PORT = val('--port');
if (val('--host')) env.HOST = val('--host');
if (has('--demo')) env.OFFICE_DEMO = '1';

const child = fork(path.join(HERE, 'server.mjs'), [], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0); });

child.on('message', (m) => {
  if (!m?.ready) return;
  if (!has('--no-open')) {
    const cmd = process.platform === 'darwin' ? ['open', [m.url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', m.url]] : ['xdg-open', [m.url]];
    execFile(cmd[0], cmd[1], () => {});
  }
  setTimeout(askToStar, 1200);
});

// Asked once, never automatic: starring is an action on your GitHub account, so it needs a yes.
function askToStar() {
  const footer = () => {
    console.log(`  ${c.dim('star:')}    https://github.com/${REPO}`);
    console.log(`  ${c.p('sponsor:')} https://github.com/sponsors/IshanVats-6`);
    console.log(`  ${c.dim('built by IV Consulting -')} ${c.dim(SITE)}\n`);
  };
  if (has('--no-prompt') || prefs.starPromptAnswered || !process.stdin.isTTY) return footer();
  execFile('gh', ['auth', 'status'], (err) => {
    if (err) return footer();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  ${c.g('★')} Enjoying it? Star the repo so other people find it? ${c.dim('[Y/n]')} `, (a) => {
      rl.close();
      savePrefs({ starPromptAnswered: true });
      if (/^n/i.test(a.trim())) { console.log(`  ${c.dim('no problem.')}`); return footer(); }
      execFile('gh', ['api', '-X', 'PUT', `/user/starred/${REPO}`], (e2) => {
        console.log(e2 ? `  ${c.dim('could not star automatically - https://github.com/' + REPO)}` : `  ${c.g('starred. thank you!')}`);
        footer();
      });
    });
  });
}
