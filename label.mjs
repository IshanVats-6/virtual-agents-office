// `npx virtual-agents-office --label`
// Reads your scheduled agents, asks an AI CLI you already have installed (Claude Code, Codex,
// Gemini) to give each one a job title, department and team, and writes office.json.
// Nothing is sent anywhere by this file itself: it shells out to a CLI you chose to install.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const meta = (file) => {
  try {
    const t = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const f = (k) => (t.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
    return { name: f('name'), description: f('description') };
  } catch { return {}; }
};
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export async function collectTasks() {
  const out = [];
  // Claude Code scheduled tasks
  const cdir = path.join(HOME, '.claude/scheduled-tasks');
  for (const d of await fsp.readdir(cdir).catch(() => [])) {
    const m = meta(path.join(cdir, d, 'SKILL.md'));
    if (m.name || m.description) out.push({ id: d, tool: 'Claude Code', title: m.name || d, description: clip(m.description, 300) });
  }
  // Cowork scheduled tasks
  const root = path.join(HOME, 'Library/Application Support/Claude/local-agent-mode-sessions');
  for (const a of await fsp.readdir(root).catch(() => [])) {
    for (const b of await fsp.readdir(path.join(root, a)).catch(() => [])) {
      const reg = readJSON(path.join(root, a, b, 'scheduled-tasks.json'));
      const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.id && (v.cronExpression || v.filePath)) { const m = v.filePath ? meta(v.filePath) : {}; out.push({ id: v.id, tool: 'Cowork', title: v.displayName || m.name || v.id, description: clip(m.description, 300) }); } else Object.values(v).forEach(walk); } };
      walk(reg);
    }
  }
  // Codex automations
  const adir = path.join(HOME, '.codex/automations');
  for (const d of await fsp.readdir(adir).catch(() => [])) {
    let toml = '';
    try { toml = fs.readFileSync(path.join(adir, d, 'automation.toml'), 'utf8'); } catch { continue; }
    const get = (k) => { const m = toml.match(new RegExp(`^${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm')); try { return m ? JSON.parse(`"${m[1]}"`) : ''; } catch { return ''; } };
    out.push({ id: d, tool: 'Codex', title: get('name') || d, description: clip(get('prompt'), 300) });
  }
  return out;
}

const PROMPT = (tasks, depts) => `You are labelling background AI agents so they can be shown as staff in an office view.

For every task below, decide:
- "role": a realistic 2-4 word job title a person doing this work would have (e.g. "SEO Auditor", "Release Manager", "Support Agent").
- "dept": exactly one of: ${depts.join(', ')}.
- "team": a short pod name (2-3 words) shared by tasks that belong together, so related agents sit near each other (e.g. "Content Studio", "Ops & Release").

Tasks:
${tasks.map((t) => `- id: ${t.id}\n  tool: ${t.tool}\n  title: ${t.title}\n  description: ${t.description || '(none)'}`).join('\n')}

Reply with JSON only, no commentary, in exactly this shape:
{"tasks":{"<id>":{"role":"…","dept":"…","team":"…"}}}`;

// spawn, not execFile: stdin has to be closed or some CLIs wait for piped input forever
function runCLI(cmd, args, timeout = 240000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const done = (res) => { clearTimeout(timer); resolve(res); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ ok: false, why: 'timed out' }); }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done({ ok: false, why: e.message }));
    child.on('close', (code) => done(code === 0 && out.trim() ? { ok: true, out } : { ok: false, why: (err.trim() || out.trim() || 'exit ' + code).split('\n').filter(Boolean).pop() }));
  });
}
const which = (bin) => new Promise((r) => execFile('command', ['-v', bin], { shell: '/bin/sh' }, (e, o) => r(e ? null : o.trim())));

export async function run(argv = []) {
  const tasks = await collectTasks();
  if (!tasks.length) { console.log('\n  No scheduled agents found, so there is nothing to label yet.\n'); return; }
  const depts = Object.keys((readJSON(path.join(HERE, 'defaults.json')) || {}).departments || {}).filter((d) => d !== 'Contractors');
  const prompt = PROMPT(tasks, depts);
  console.log(`\n  Found ${tasks.length} scheduled agent${tasks.length === 1 ? '' : 's'}.`);

  if (argv.includes('--print')) { console.log('\n----- prompt -----\n' + prompt + '\n------------------\n  Paste that into any assistant and save the JSON as office.json.\n'); return; }

  const runners = [
    ['claude', (p) => ['-p', p]],
    ['codex', (p) => ['exec', '--skip-git-repo-check', p]],
    ['gemini', (p) => ['-p', p]],
  ];
  let raw = null, used = null, tried = 0;
  for (const [bin, args] of runners) {
    if (!(await which(bin))) continue;
    tried++;
    console.log(`  Asking ${bin} to label them, this takes up to a minute...`);
    const r = await runCLI(bin, args(prompt));
    if (r.ok) { raw = r.out; used = bin; break; }
    console.log(`  ${bin} could not answer: ${clip(r.why, 120)}`);
  }
  if (!raw) {
    console.log(tried ? '\n  None of your AI CLIs could answer (see the reason above).' : '\n  No AI CLI found (tried claude, codex, gemini).');
    console.log('  Run with --label --print to get the prompt, paste it into any assistant, and save the answer as office.json.\n');
    return;
  }

  const m = raw.match(/\{[\s\S]*\}/);
  let parsed = null;
  try { parsed = JSON.parse(m ? m[0] : raw); } catch {}
  if (!parsed?.tasks) { console.log(`\n  ${used} did not return usable JSON. Run with --label --print and do it by hand.\n`); return; }

  const file = path.join(HERE, 'office.json');
  const existing = readJSON(file) || { tasks: {} };
  const merged = { tasks: { ...existing.tasks, ...parsed.tasks } };
  await fsp.writeFile(file, JSON.stringify(merged, null, 2));
  const rows = Object.entries(parsed.tasks).slice(0, 8);
  console.log(`\n  Wrote ${Object.keys(parsed.tasks).length} labels to office.json:\n`);
  for (const [id, v] of rows) console.log(`    ${id.padEnd(34)} ${String(v.role).padEnd(26)} ${v.team || v.dept}`);
  if (Object.keys(parsed.tasks).length > rows.length) console.log(`    ...and ${Object.keys(parsed.tasks).length - rows.length} more`);
  console.log('\n  Edit that file any time. It wins over the built-in guesses.\n');
}
