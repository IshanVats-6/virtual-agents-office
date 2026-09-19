// virtual-agents-office - a live isometric office for your AI coding agents.
// Staff = standing agents (scheduled tasks and automations). Contractors = ad-hoc interactive sessions.
// Everything is read locally, read-only. No dependencies: `npx virtual-agents-office`.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createAnalytics, aggregate } from './analytics.mjs';
import { demoState } from './demo.mjs';

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// Defaults live in code; config.json / config.local.json only override what you want to change.
const DEFAULTS = readJSON(path.join(HERE, 'defaults.json')) || {};
const CFG = { ...DEFAULTS, ...(readJSON(path.join(HERE, 'config.json')) || {}), ...(readJSON(path.join(HERE, 'config.local.json')) || {}) };
CFG.hermes = { enabled: false, ...(DEFAULTS.hermes || {}), ...(CFG.hermes || {}) };
const PORT = +process.env.PORT || CFG.port || 4747;
const HOST = process.env.HOST || '127.0.0.1';
// OFFICE_MODE=relay: no local collection; serves the UI and accepts pushes from the Mac collector (used on the VPS).
const RELAY = process.env.OFFICE_MODE === 'relay';
const DEMO_MODE = process.env.OFFICE_DEMO === '1' || process.argv.includes('--demo');
const OFFICE_USER = process.env.OFFICE_USER || 'me';
const OFFICE_PASSWORD = process.env.OFFICE_PASSWORD || '';
const PUSH_URL = process.env.PUSH_URL || '';
const PUSH_TOKEN = (process.env.PUSH_TOKEN || (process.env.PUSH_TOKEN_FILE ? (() => { try { return fs.readFileSync(process.env.PUSH_TOKEN_FILE.replace(/^~/, os.homedir()), 'utf8').trim(); } catch { return ''; } })() : '')).trim();
const SCAN_MS = 8 * 86400e3; // how far back to look for runs of scheduled staff
const CONTRACT_MS = (CFG.contractorWindowHours || 24) * 3600e3;

// ---------- helpers ----------
const clip = (s, n = 160) => {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const base = (p) => (p ? path.basename(String(p)) : '');
const tsMs = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t) || 0);
const cleanTitle = (t) => String(t || '').replace(/^[^A-Za-z0-9]*[A-Za-z &]+\s*\|\s*/, '');
const slug = (s) => cleanTitle(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const exists = (p) => fs.existsSync(p);

async function readTail(file, bytes = 262144) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const l of lines) { if (l.trim()) try { out.push(JSON.parse(l)); } catch {} }
    return out;
  } finally { await fh.close(); }
}
async function readHeadText(file, bytes = 65536) {
  const fh = await fsp.open(file, 'r');
  try { const buf = Buffer.alloc(bytes); const { bytesRead } = await fh.read(buf, 0, bytes, 0); return buf.subarray(0, bytesRead).toString('utf8'); }
  finally { await fh.close(); }
}
const skillMeta = (file) => {
  try {
    const t = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const f = (k) => (t.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
    // office_role / office_team / office_dept / office_name in the task's own frontmatter win over any guess
    return { name: f('name'), description: f('description'), role: f('office_role'), team: f('office_team'), dept: f('office_dept'), person: f('office_name') };
  } catch { return {}; }
};

// ---------- schedules ----------
function cronField(f, lo, hi) {
  if (f === '*') return null;
  const set = new Set();
  for (const part of f.split(',')) {
    const [r, step] = part.split('/');
    let [a, b] = r === '*' ? [lo, hi] : r.split('-').map(Number);
    if (b == null) b = step ? hi : a;
    for (let v = a; v <= b; v += +(step || 1)) set.add(v);
  }
  return set;
}
function cronNext(expr, from = Date.now()) {
  const [mi, ho, dom, mon, dow] = expr.trim().split(/\s+/);
  const M = cronField(mi, 0, 59), H = cronField(ho, 0, 23), D = cronField(dom, 1, 31), MO = cronField(mon, 1, 12), W = cronField(dow, 0, 6);
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 400; ) {
    const dayOk = (!MO || MO.has(d.getMonth() + 1)) && (!D || D.has(d.getDate())) && (!W || W.has(d.getDay()));
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0); i += 1440; continue; }
    if (H && !H.has(d.getHours())) { d.setHours(d.getHours() + 1, 0); i += 60; continue; }
    if (M && !M.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); i++; continue; }
    return d.getTime();
  }
  return null;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
function cronHuman(expr) {
  const [mi, ho, dom, , dow] = expr.split(/\s+/);
  const t = /^\d+$/.test(mi) && /^\d+$/.test(ho) ? hhmm(+ho, +mi) : '';
  if (dom !== '*') return `Monthly (day ${dom}) ${t}`;
  if (dow === '*') return `Daily ${t}`;
  if (dow === '1-5') return `Weekdays ${t}`;
  return `${[...cronField(dow, 0, 6)].map((d) => DOW[d % 7]).join(', ')} ${t}`;
}
function rruleInfo(r) {
  const o = Object.fromEntries(r.replace(/^RRULE:/, '').split(';').map((kv) => kv.split('=')));
  const hours = (o.BYHOUR || '').split(',').filter(Boolean).map(Number), min = +(o.BYMINUTE || 0);
  const t = hours.map((h) => hhmm(h, min)).join(' & ');
  const days = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
  if (o.FREQ === 'HOURLY') return { human: `Every ${o.INTERVAL || 1}h`, cron: null };
  if (o.FREQ === 'DAILY') return { human: `Daily ${t}`, cron: `${min} ${hours.join(',') || 0} * * *` };
  if (o.FREQ === 'WEEKLY') { const bd = (o.BYDAY || 'MO').split(','); return { human: `${bd.map((d) => DOW[days[d]]).join(', ')} ${t}`, cron: `${min} ${hours.join(',') || 0} * * ${bd.map((d) => days[d]).join(',')}` }; }
  return { human: r, cron: null };
}

// ---------- tool-call labels ----------
function toolLabel(name, input) {
  let inp = input;
  if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch { inp = { raw: inp }; } }
  inp = inp || {};
  const cmd = inp.command || inp.cmd || '';
  const file = inp.file_path || inp.path || inp.notebook_path || '';
  switch (name) {
    case 'Bash': case 'exec_command': case 'shell': case 'local_shell': case 'container.exec':
      return `Running: ${clip(Array.isArray(cmd) ? cmd.join(' ') : cmd, 60)}`;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': case 'apply_patch': return file ? `Editing ${base(file)}` : 'Editing code';
    case 'Read': return `Reading ${base(file)}`;
    case 'Grep': case 'Glob': return `Searching ${clip(inp.pattern || '', 30)}`;
    case 'WebFetch': case 'WebSearch': case 'web_search': return 'Browsing the web';
    case 'Agent': case 'Task': return `Briefing a helper: ${clip(inp.description || '', 40)}`;
    case 'TodoWrite': return 'Planning';
    case 'Skill': return `Using skill ${inp.skill || ''}`;
    case 'AskUserQuestion': return 'Has a question for you';
    case 'heartbeat_respond': return `Heartbeat: ${String(inp.outcome || 'checked').replace(/_/g, ' ')}`;
  }
  if (name?.startsWith('mcp__')) {
    const parts = name.split('__');
    let srv = parts[1] || 'MCP';
    if (/^[0-9a-f-]{20,}$/.test(srv)) srv = 'connector';
    return `Using ${srv.replace(/_/g, ' ')} · ${clip(parts.slice(2).join(' ').replace(/_/g, ' '), 30)}`;
  }
  return `Using ${name}`;
}
const toolDetail = (name, input) => {
  let inp = input;
  if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch { return clip(inp, 140); } }
  inp = inp || {};
  const v = inp.command || inp.cmd || inp.file_path || inp.path || inp.pattern || inp.url || inp.query || inp.description || inp.skill || inp.prompt;
  return clip(Array.isArray(v) ? v.join(' ') : v || JSON.stringify(inp), 140);
};
// Is this tool call reaching out to another of your agents?
function reachesOut(name, input) {
  const s = (name + ' ' + JSON.stringify(input || '')).toLowerCase();
  if (name === 'Skill' && /"codex"/.test(s)) return 'codex';
  if (/\bcodex (exec|review|--)/.test(s)) return 'codex';
  if (/hermes/.test(s) && /(docker exec|hermes (chat|gateway|config))/.test(s)) return 'hermes';
  if (/openclaw (agent|message|send)/.test(s)) return 'openclaw';
  return null;
}

function statusFrom({ mtime, finished, waiting }) {
  const age = Date.now() - mtime;
  if (waiting && age < 30 * 60e3) return 'waiting';
  if (!finished && age < 120e3) return 'working';
  if (age < 30 * 60e3) return 'idle';
  return 'sleeping';
}

// ---------- Claude Code sessions ----------
const claudeCache = new Map();
async function collectClaude() {
  const root = path.join(HOME, '.claude/projects');
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(root); } catch { return out; }
  for (const d of dirs) {
    let ents = [];
    try { ents = await fsp.readdir(path.join(root, d)); } catch { continue; }
    for (const e of ents) {
      if (!e.endsWith('.jsonl')) continue;
      const f = path.join(root, d, e);
      let st; try { st = await fsp.stat(f); } catch { continue; }
      if (Date.now() - st.mtimeMs > SCAN_MS) continue;
      const key = `${st.mtimeMs}:${st.size}`;
      let hit = claudeCache.get(f);
      if (!hit || hit.key !== key) {
        try { hit = { key, val: await parseClaude(f, st, e.slice(0, -6), d) }; claudeCache.set(f, hit); } catch { continue; }
      }
      if (!hit.val) continue;
      const v = { ...hit.val, status: statusFrom(hit.val._s) };
      if (v.status === 'working' || v.status === 'waiting') v.helpers = await activeHelpers(path.join(root, d, e.slice(0, -6), 'subagents'));
      out.push(v);
    }
  }
  return out;
}
async function activeHelpers(dir) {
  const out = [];
  let ents = [];
  try { ents = await fsp.readdir(dir); } catch { return out; }
  for (const e of ents) {
    if (!e.endsWith('.jsonl')) continue;
    const f = path.join(dir, e);
    try {
      const st = await fsp.stat(f);
      if (Date.now() - st.mtimeMs > 90e3) continue;
      const head = await readHeadText(f, 16384);
      let task = '';
      try { const j = JSON.parse(head.split('\n')[0]); const c = j.message?.content; task = typeof c === 'string' ? c : (c || []).map((x) => x.text || '').join(' '); } catch {}
      out.push({ id: e.slice(0, -6), task: clip(task, 90) });
    } catch {}
  }
  return out;
}
async function parseClaude(f, st, sid, dir) {
  const rows = await readTail(f);
  let title = '', cwd = '', model = '', firstPrompt = '', lastStop = '', lastTs = 0;
  const feed = [];
  const openTools = new Map();
  for (const r of rows) {
    if (r.type === 'custom-title' || r.type === 'ai-title') title = r.customTitle || r.aiTitle || r.title || title;
    if (r.type === 'summary' && !title) title = r.summary;
    if (r.cwd) cwd = r.cwd;
    if (r.isSidechain) continue;
    const t = tsMs(r.timestamp); if (t) lastTs = t;
    if (r.type === 'user' && r.message) {
      const c = r.message.content;
      const items = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
      for (const it of items) {
        if (it.type === 'text' && !it.text.startsWith('<') && !r.isMeta) { feed.push({ t, k: 'prompt', x: clip(it.text, 220) }); firstPrompt ||= it.text; lastStop = ''; }
        if (it.type === 'tool_result') {
          openTools.delete(it.tool_use_id);
          const txt = typeof it.content === 'string' ? it.content : Array.isArray(it.content) ? it.content.map((z) => z.text || '').join(' ') : '';
          if (txt) feed.push({ t, k: it.is_error ? 'error' : 'result', x: clip(txt, 140) });
        }
      }
    }
    if (r.type === 'assistant' && r.message) {
      model = r.message.model || model;
      lastStop = r.message.stop_reason || lastStop;
      for (const it of r.message.content || []) {
        if (it.type === 'text' && it.text.trim()) feed.push({ t, k: 'say', x: clip(it.text, 260) });
        if (it.type === 'thinking') feed.push({ t, k: 'think', x: 'thinking…' });
        if (it.type === 'tool_use') {
          openTools.set(it.id, { name: it.name, input: it.input, t });
          feed.push({ t, k: 'tool', x: toolLabel(it.name, it.input), d: toolDetail(it.name, it.input), to: reachesOut(it.name, it.input) });
        }
      }
    }
  }
  if (!feed.length) return null;
  const pending = [...openTools.values()].pop() || null;
  const finished = lastStop === 'end_turn' && !pending;
  const waiting = !!pending && (pending.name === 'AskUserQuestion' || Date.now() - st.mtimeMs > 90e3);
  const lastTool = [...feed].reverse().find((e) => e.k === 'tool');
  let activity = finished ? 'Done - task complete' : pending ? toolLabel(pending.name, pending.input) : lastTool?.x || 'Thinking…';
  if (waiting) activity = pending.name === 'AskUserQuestion' ? 'Has a question for you' : `Needs approval: ${toolLabel(pending.name, pending.input)}`;
  const project = base(cwd) || dir.replace(/^-Users-[^-]+-/, '');
  const lastSay = [...feed].reverse().find((e) => e.k === 'say');
  const failed = lastSay && feed.at(-1) === lastSay && Date.now() - st.mtimeMs > 120e3 && /API Error|Failed to authenticate|access token has expired|usage limit|rate limit/i.test(lastSay.x) ? clip(lastSay.x, 120) : null;
  return {
    tool: 'claude', sid, failed, title: clip(title || firstPrompt || project, 80), slug: slug(title), project, cwd, model: model.replace(/^claude-/, ''),
    activity, feed: feed.slice(-40), reach: !finished ? (pending ? reachesOut(pending.name, pending.input) : lastTool?.to) || null : null,
    lastActive: Math.max(lastTs, st.mtimeMs), _s: { mtime: st.mtimeMs, finished, waiting },
  };
}

// ---------- Codex sessions (+ OpenClaw runs, which run on Codex) ----------
const codexCache = new Map();
async function collectCodex() {
  const root = path.join(HOME, '.codex/sessions');
  const out = [];
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.now() - back * 86400e3);
    const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let ents = [];
    try { ents = await fsp.readdir(dir); } catch { continue; }
    for (const e of ents) {
      if (!e.endsWith('.jsonl')) continue;
      const f = path.join(dir, e);
      let st; try { st = await fsp.stat(f); } catch { continue; }
      const key = `${st.mtimeMs}:${st.size}`;
      let hit = codexCache.get(f);
      if (!hit || hit.key !== key) { try { hit = { key, val: await parseCodex(f, st) }; codexCache.set(f, hit); } catch { continue; } }
      if (hit.val) out.push({ ...hit.val, status: statusFrom(hit.val._s) });
    }
  }
  return out;
}
async function parseCodex(f, st) {
  const head = await readHeadText(f);
  const sid = (head.match(/"session_id":"([^"]+)"/) || [])[1] || base(f);
  const originator = (head.match(/"originator":"([^"]+)"/) || [])[1] || 'codex';
  const cwd = (head.match(/"cwd":"([^"]+)"/) || [])[1] || '';
  const rows = await readTail(f);
  const feed = [];
  let finished = false, model = '', lastTs = 0, firstPrompt = '';
  for (const r of rows) {
    const t = tsMs(r.timestamp); if (t) lastTs = t;
    const p = r.payload || {};
    if (r.type === 'turn_context' && p.model) model = p.model;
    if (r.type === 'event_msg') {
      if (p.type === 'task_started') finished = false;
      if (p.type === 'task_complete') finished = true;
      if (p.type === 'user_message' && p.message) { feed.push({ t, k: 'prompt', x: clip(p.message, 220) }); firstPrompt ||= p.message; finished = false; }
    }
    if (r.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') { const txt = (p.content || []).map((c) => c.text || '').join(' ').trim(); if (txt) feed.push({ t, k: 'say', x: clip(txt, 260) }); }
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const name = p.name || p.type, args = p.arguments || p.input || p.action;
        feed.push({ t, k: 'tool', x: toolLabel(name, args), d: toolDetail(name, args) });
      }
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') feed.push({ t, k: 'result', x: clip(typeof p.output === 'string' ? p.output : JSON.stringify(p.output || ''), 140) });
      if (p.type === 'reasoning') feed.push({ t, k: 'think', x: 'thinking…' });
    }
  }
  if (!feed.length) return null;
  const lastTool = [...feed].reverse().find((e) => e.k === 'tool');
  return {
    tool: originator === 'openclaw' ? 'openclaw' : 'codex', sid, originator, title: clip(firstPrompt || base(cwd), 80), firstPrompt: firstPrompt.slice(0, 200),
    project: base(cwd), cwd, model, activity: finished ? 'Done - task complete' : lastTool?.x || 'Thinking…',
    feed: feed.slice(-40), lastActive: Math.max(lastTs, st.mtimeMs), _s: { mtime: st.mtimeMs, finished, waiting: false },
  };
}

// ---------- Cowork (Claude desktop) sessions ----------
const coworkRoot = path.join(HOME, 'Library/Application Support/Claude/local-agent-mode-sessions');
const coworkCache = new Map();
async function coworkDirs() {
  const out = [];
  try {
    for (const a of await fsp.readdir(coworkRoot)) {
      const pa = path.join(coworkRoot, a);
      if (!(await fsp.stat(pa)).isDirectory()) continue;
      for (const b of await fsp.readdir(pa)) { const pb = path.join(pa, b); if ((await fsp.stat(pb)).isDirectory()) out.push(pb); }
    }
  } catch {}
  return out;
}
async function collectCowork() {
  const sessions = [], tasks = [];
  for (const dir of await coworkDirs()) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, 'scheduled-tasks.json'), 'utf8'));
      const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.id && (v.cronExpression || v.filePath)) tasks.push(v); else Object.values(v).forEach(walk); } };
      walk(j);
    } catch {}
    let ents = [];
    try { ents = await fsp.readdir(dir); } catch { continue; }
    for (const e of ents) {
      if (!/^local_.*\.json$/.test(e)) continue;
      const f = path.join(dir, e);
      let st; try { st = await fsp.stat(f); } catch { continue; }
      if (Date.now() - st.mtimeMs > 60 * 86400e3) continue;
      const key = `${st.mtimeMs}:${st.size}`;
      let hit = coworkCache.get(f);
      if (!hit || hit.key !== key) {
        try {
          const j = JSON.parse(await fsp.readFile(f, 'utf8'));
          const last = j.lastActivityAt || st.mtimeMs;
          hit = { key, val: {
            tool: 'cowork', sid: j.sessionId, taskId: j.scheduledTaskId || null, title: clip(j.title || j.initialMessage || 'Cowork task', 80), slug: slug(j.title),
            project: 'Cowork', cwd: (j.userSelectedFolders || [])[0] || '', model: (j.model || '').replace(/^claude-/, ''), archived: j.isArchived,
            activity: 'Working in Cowork', createdAt: j.createdAt, feed: j.initialMessage ? [{ t: j.createdAt, k: 'prompt', x: clip(j.initialMessage, 220) }] : [],
            lastActive: last, _s: { mtime: last, finished: false, waiting: false },
          } };
          coworkCache.set(f, hit);
        } catch { continue; }
      }
      const v = { ...hit.val, status: statusFrom(hit.val._s) };
      if (v.status !== 'working') v.activity = 'Done - task complete';
      sessions.push(v);
    }
  }
  return { sessions, tasks };
}

// ---------- Hermes (VPS) ----------
let hermes = { sessions: [], online: null, error: null, at: 0 };
const HERMES_PY = `
import sqlite3,json,time
d=sqlite3.connect("file:/opt/data/state.db?mode=ro",uri=True)
out=[]
for s in d.execute("select id,source,title,model,started_at,ended_at,last_activity_at from sessions where hidden=0 order by coalesce(last_activity_at,started_at) desc limit 3").fetchall():
  msgs=d.execute("select role,substr(content,1,400),tool_name,substr(tool_calls,1,400),timestamp,finish_reason from messages where session_id=? order by timestamp desc limit 30",(s[0],)).fetchall()
  out.append({"s":s,"m":msgs[::-1]})
print(json.dumps(out))`;
function pollHermes() {
  const h = CFG.hermes;
  if (!h?.enabled) return;
  const remote = `c=$(docker ps --format '{{.Names}}' | grep -i ${h.containerMatch} | head -1); [ -z "$c" ] && echo OFFLINE && exit 0; docker exec -i $c python3 -`;
  const child = execFile('ssh', ['-i', h.sshKey.replace('~', HOME), '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', h.sshTarget, remote],
    { timeout: 20000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) { hermes = { ...hermes, error: clip(err.message, 120), online: false, at: Date.now() }; return; }
      if (stdout.trim() === 'OFFLINE') { hermes = { sessions: [], online: false, error: 'container not running', at: Date.now() }; return; }
      try { hermes = { online: true, error: null, at: Date.now(), sessions: JSON.parse(stdout).map(parseHermes) }; }
      catch (e) { hermes = { ...hermes, error: 'parse: ' + e.message, at: Date.now() }; }
    });
  child.stdin.end(HERMES_PY);
}
function parseHermes({ s, m }) {
  const [id, source, title, model, started, , lastAct] = s;
  const feed = [];
  let finished = true, lastT = 0;
  for (const [role, content, toolName, toolCalls, ts, finish] of m) {
    const t = tsMs(ts); lastT = t;
    if (role === 'user' && content) { feed.push({ t, k: 'prompt', x: clip(content, 220) }); finished = false; }
    else if (role === 'assistant') {
      if (toolCalls) {
        try { for (const c of JSON.parse(toolCalls)) { const fn = c.function || c; feed.push({ t, k: 'tool', x: toolLabel(fn.name, fn.arguments), d: toolDetail(fn.name, fn.arguments) }); } }
        catch { feed.push({ t, k: 'tool', x: 'Using tools' }); }
        finished = false;
      }
      if (content) { feed.push({ t, k: 'say', x: clip(content, 260) }); if (finish === 'stop' || !toolCalls) finished = true; }
    } else if (role === 'tool') feed.push({ t, k: 'result', x: clip(`${toolName || 'tool'}: ${content || ''}`, 140) });
  }
  const mtime = Math.max(tsMs(lastAct || started), lastT);
  const lastTool = [...feed].reverse().find((e) => e.k === 'tool');
  return {
    tool: 'hermes', sid: id, title: clip(title || 'Slack thread', 80), project: 'Slack · ' + source, cwd: 'VPS', model,
    activity: finished ? 'Done - task complete' : lastTool?.x || 'Thinking…', feed: feed.slice(-40), lastActive: mtime,
    _s: { mtime, finished, waiting: false },
  };
}

// ---------- OpenClaw gateway ping ----------
let openclawOnline = null;
function pingOpenclaw() {
  const s = net.connect({ host: '127.0.0.1', port: CFG.openclawPort || 18789, timeout: 1500 });
  s.on('connect', () => { openclawOnline = true; s.destroy(); });
  s.on('error', () => { openclawOnline = false; });
  s.on('timeout', () => { openclawOnline = false; s.destroy(); });
}

// ---------- roster ----------
const titleCase = (k) => String(k).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
// The id is the strong signal; the description is the fallback, so "run-weekly-thing" whose
// description says "weekly SEO audit" still gets a sensible job title.
const roleFor = (key, fallback, desc = '') => {
  const roles = CFG.roles || [], d = String(desc).toLowerCase();
  return (roles.find(([k]) => key.includes(k)) || roles.find(([k]) => d.includes(k)) || [])[1] || fallback;
};
function deptFor(title, key, desc = '') {
  const m = String(title || '').match(/^[^A-Za-z0-9]*([A-Za-z &]+?)\s*\|/);
  if (m) { const d = m[1].trim(); return CFG.deptAliases[d] || d; }
  for (const [re, d] of CFG.deptKeywords || []) if (new RegExp(re).test(key)) return d;
  const low = String(desc).toLowerCase();
  for (const [re, d] of CFG.deptKeywords || []) if (new RegExp(re).test(low)) return d;
  return CFG.defaultDepartment || 'Agents';
}
const BRIDGE_COLORS = ['#7C9CFF', '#F0A6CA', '#6FD3C7', '#FFB86B', '#B9A6FF', '#8FD98F', '#FF8FA3', '#79C0FF'];
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

const officeLabels = () => (readJSON(path.join(HERE, 'office.json')) || {}).tasks || {};
let openclawSeen = false;
function buildStaffDefs(coworkTasks) {
  const defs = [];
  // Claude Code scheduled tasks: folder scan (names/descriptions) + snapshot (schedule/enabled)
  // Optional: cron times for Claude Code scheduled tasks (see README → "Show next run times").
  const snap = (readJSON(path.join(HERE, 'schedules.json')) || {}).tasks || [];
  const dir = path.join(HOME, '.claude/scheduled-tasks');
  const ids = new Set(snap.map((t) => t.id));
  try { for (const d of fs.readdirSync(dir)) if (exists(path.join(dir, d, 'SKILL.md'))) ids.add(d); } catch {}
  for (const id of ids) {
    const s = snap.find((t) => t.id === id) || {};
    const meta = skillMeta(path.join(dir, id, 'SKILL.md'));
    const title = s.title || meta.name || id;
    const tslug = slug(title);
    defs.push({ id: 'claude-task:' + id, key: id, tool: 'claude', title: cleanTitle(title), dept: deptFor(title, id, meta.description), desc: meta.description || '',
      role: meta.role, team: meta.team, person: meta.person, ...(meta.dept ? { dept: meta.dept } : {}),
      schedule: s.cron ? cronHuman(s.cron) : 'Scheduled', cron: s.cron, enabled: s.enabled !== false, match: (x) => x.tool === 'claude' && (x.slug === id || x.slug === tslug) });
  }
  // Cowork scheduled tasks (live registry)
  for (const t of coworkTasks) {
    const meta = t.filePath ? skillMeta(t.filePath) : {};
    const title = t.displayName || meta.name || t.id;
    defs.push({ id: 'cowork-task:' + t.id, key: t.id, tool: 'cowork', title: cleanTitle(title), dept: meta.dept || deptFor(title, t.id, meta.description), desc: meta.description || '',
      role: meta.role, team: meta.team, person: meta.person,
      schedule: t.cronExpression ? cronHuman(t.cronExpression) : 'Scheduled', cron: t.cronExpression, enabled: t.enabled !== false, lastRunReg: tsMs(t.lastRunAt),
      match: (x) => x.tool === 'cowork' && x.taskId === t.id });
  }
  // Codex automations (live)
  try {
    const adir = path.join(HOME, '.codex/automations');
    for (const d of fs.readdirSync(adir)) {
      let toml = '';
      try { toml = fs.readFileSync(path.join(adir, d, 'automation.toml'), 'utf8'); } catch { continue; }
      const get = (k) => { const m = toml.match(new RegExp(`^${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm')); try { return m ? JSON.parse(`"${m[1]}"`) : ''; } catch { return m[1]; } };
      const name = get('name') || d, prompt = get('prompt'), rr = get('rrule');
      const info = rr ? rruleInfo(rr) : { human: 'Scheduled', cron: null };
      const head = prompt.slice(0, 60);
      defs.push({ id: 'codex-auto:' + d, key: d, tool: 'codex', title: cleanTitle(name), dept: deptFor(name, d, prompt), desc: clip(prompt, 200),
        schedule: info.human, cron: info.cron, enabled: get('status') !== 'PAUSED', match: (x) => x.tool === 'codex' && !!head && !!x.firstPrompt?.startsWith(head) });
    }
  } catch {}
  if (CFG.hermes?.enabled) defs.push({ id: 'hermes', key: 'hermes', tool: 'hermes', title: CFG.hermes.title || 'Always-on chat agent', dept: CFG.hermes.dept || 'Operations', role: CFG.hermes.role || 'Chief of Staff',
    desc: 'Hermes agent, read over SSH.', schedule: 'On call', enabled: true, match: (x) => x.tool === 'hermes' });
  if (openclawSeen) defs.push({ id: 'openclaw', key: 'openclaw', tool: 'openclaw', title: 'Heartbeat monitor', dept: 'Operations', role: 'Inbox Operator',
    desc: 'Always-on gateway agent (runs on Codex). Wakes on heartbeats to check channels.', schedule: 'Heartbeats · always on', enabled: true, match: (x) => x.tool === 'openclaw' });
  return defs;
}

let STATE = { staff: [], at: 0 };
const nameMap = new Map();
function assignNames(list, pool, prefix) {
  const used = new Set([...nameMap.values()]);
  for (const e of [...list].sort((a, b) => a.id.localeCompare(b.id))) {
    if (e.person) { e.name = e.person; continue; }
    if (CFG.nameOverrides[e.key]) { e.name = CFG.nameOverrides[e.key]; continue; }
    if (nameMap.has(prefix + e.id)) { e.name = nameMap.get(prefix + e.id); continue; }
    if (!pool.length) { e.name = titleCase(e.key).split(' ')[0] || 'Agent'; continue; }
    let i = hash(e.id) % pool.length, n = 0;
    while (used.has(pool[i]) && n < pool.length) { i = (i + 1) % pool.length; n++; }
    e.name = n >= pool.length ? `${pool[i]} ${used.size}` : pool[i];
    used.add(e.name); nameMap.set(prefix + e.id, e.name);
  }
}
const teamFor = (key) => (CFG.teams || []).find((t) => new RegExp(t.match).test(key)) || null;

// Desktop app keeps a title for every Claude Code session it started (scheduled runs included).
const deskTitles = new Map();
let deskTitlesAt = 0;
async function loadDeskTitles() {
  if (Date.now() - deskTitlesAt < 60e3) return;
  deskTitlesAt = Date.now();
  const root = path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions');
  for (const a of await fsp.readdir(root).catch(() => [])) for (const b of await fsp.readdir(path.join(root, a)).catch(() => [])) {
    for (const f of await fsp.readdir(path.join(root, a, b)).catch(() => [])) {
      if (!/^local_.*\.json$/.test(f)) continue;
      try { const j = JSON.parse(await fsp.readFile(path.join(root, a, b, f), 'utf8')); if (j.cliSessionId && j.title) deskTitles.set(j.cliSessionId, j.title); } catch {}
    }
  }
}

// Analytics (collector only): all runs in the window, normalised so staff `match()` works on them.
const analytics = RELAY ? null : createAnalytics({ dir: HERE, days: CFG.analyticsDays || 30, log: (m) => console.log('[analytics]', m) });
function analyticsRuns(cwSessions) {
  if (!analytics) return [];
  const runs = analytics.sessions().map((s) => {
    const title = s.title || deskTitles.get(s.sid) || '';
    return { ...s, title, slug: slug(title) };
  });
  for (const c of cwSessions) runs.push({ tool: 'cowork', sid: c.sid, taskId: c.taskId, start: c.createdAt || c.lastActive, end: c.lastActive, outcome: '', title: c.title });
  for (const [sid, c] of Object.entries(analytics.codeburn())) if (c.provider === 'hermes') runs.push({ tool: 'hermes', sid, start: c.start, end: c.end, outcome: '' });
  return runs;
}

const NATIVE = new Set(['claude', 'codex', 'hermes', 'openclaw', 'cowork']);
const projName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop()?.replace(/^-+/, '') || 'workspace';
// codeburn reports usage for ~36 coding agents. Anything we don't parse natively still gets a desk,
// with cost/tokens/runs but no live activity feed.
function bridgedStaff(cb) {
  if (!CFG.bridgeOtherTools) return [];
  const byKey = new Map();
  for (const [sid, c] of Object.entries(cb)) {
    const tool = String(c.provider || '').toLowerCase();
    if (!tool || NATIVE.has(tool)) continue;
    const key = tool + ':' + projName(c.project);
    if (!byKey.has(key)) byKey.set(key, { tool, project: projName(c.project), runs: [] });
    byKey.get(key).runs.push({ sid, start: c.start, end: c.end, tok: { in: c.in, out: c.out, cr: c.cr, cw: c.cw }, outcome: '', files: 0 });
  }
  return [...byKey.entries()]
    .map(([key, g]) => ({ key, ...g, cost: g.runs.reduce((a, r) => a + (cb[r.sid]?.cost || 0), 0), last: Math.max(...g.runs.map((r) => r.end || r.start)) }))
    .sort((a, b) => b.cost - a.cost).slice(0, CFG.maxBridged || 18)
    .map((g) => {
      const label = CFG.tools[g.tool]?.label || titleCase(g.tool);
      const age = Date.now() - g.last;
      const status = age < 10 * 60e3 ? 'working' : age < 45 * 60e3 ? 'idle' : 'sleeping';
      return {
        id: 'tool:' + g.key, key: g.key, kind: 'staff', tool: g.tool, dept: CFG.defaultDepartment || 'Agents', team: label,
        role: `${label} agent`, task: g.project, desc: `Sessions in ${g.project}, read through codeburn.`, source: 'codeburn',
        schedule: 'Ad-hoc sessions', enabled: true, lastRun: g.last, nextRun: null, runs: g.runs.length, status,
        activity: status === 'working' ? `Working in ${g.project}` : status === 'idle' ? 'Just finished a session' : 'No session running',
        session: { title: g.project, project: g.project, cwd: '', model: (cb[g.runs[0].sid]?.models || [])[0] || '', sid: g.runs[0].sid, lastActive: g.last },
        feed: [], helpers: [], reach: null, online: null, failed: null,
        stats: aggregate(g.runs, cb, CFG.analyticsDays || 30),
      };
    });
}

async function refresh() {
  const [claude, codexAll, cw] = await Promise.all([collectClaude().catch(() => []), collectCodex().catch(() => []), collectCowork().catch(() => ({ sessions: [], tasks: [] })), loadDeskTitles().catch(() => {})]);
  openclawSeen = codexAll.some((x) => x.tool === 'openclaw');
  const sessions = [...claude, ...codexAll, ...cw.sessions, ...hermes.sessions.map((s) => ({ ...s, status: statusFrom(s._s) }))];
  const LABELS = officeLabels();
  const defs = buildStaffDefs(cw.tasks);
  const aRuns = analyticsRuns(cw.sessions);
  const cb = analytics ? analytics.codeburn() : {};
  const claimed = new Set();
  const staff = defs.map((d) => {
    const runs = sessions.filter((x) => d.match(x)).sort((a, b) => b.lastActive - a.lastActive);
    runs.forEach((r) => claimed.add(r));
    const cur = runs[0];
    let status = cur ? cur.status : 'sleeping';
    if (status === 'idle' && cur.tool === 'openclaw') status = 'sleeping';
    if (!d.enabled && status === 'sleeping') status = 'paused';
    const lastRun = Math.max(cur?.lastActive || 0, d.lastRunReg || 0) || null;
    const nextRun = d.enabled && d.cron ? cronNext(d.cron) : null;
    const lab = LABELS[d.key] || LABELS[d.id] || {};
    const dept = lab.dept || d.dept;
    const team = lab.team ? { name: lab.team } : d.team ? { name: d.team } : teamFor(d.key);
    const hist = aRuns.filter((x) => d.match(x));
    return {
      id: d.id, key: d.key, kind: 'staff', tool: d.tool, dept, team: team?.name || dept,
      role: lab.role || d.role || roleFor(d.key, titleCase(d.key).slice(0, 34), d.desc), person: lab.name || d.person, task: d.title, desc: d.desc,
      schedule: d.schedule, enabled: d.enabled, lastRun, nextRun, runs: runs.length, status,
      activity: status === 'sleeping' ? (nextRun ? 'Asleep until next shift' : 'On standby') : status === 'paused' ? 'On leave (paused)' : cur?.activity,
      session: cur ? { title: cur.title, project: cur.project, cwd: cur.cwd, model: cur.model, sid: cur.sid, lastActive: cur.lastActive } : null,
      feed: (cur ? (d.tool === 'openclaw' ? runs.slice(0, 4).reverse().flatMap((r) => r.feed) : cur.feed) : []).slice(-20),
      helpers: status === 'working' || status === 'waiting' ? cur?.helpers || [] : [], reach: status === 'working' ? cur?.reach || null : null,
      online: d.tool === 'openclaw' ? openclawOnline : d.tool === 'hermes' ? hermes.online : null,
      failed: cur?.failed || null,
      stats: aggregate(hist, cb, CFG.analyticsDays || 30),
    };
  });
  const contractors = sessions
    .filter((x) => !claimed.has(x) && x.tool !== 'openclaw' && Date.now() - x.lastActive < CONTRACT_MS && !(x.tool === 'cowork' && (x.taskId || x.archived)))
    .sort((a, b) => b.lastActive - a.lastActive).slice(0, CFG.maxContractors || 12)
    .map((x) => ({
      id: 'contractor:' + x.tool + ':' + x.sid, key: x.sid, kind: 'contractor', tool: x.tool, dept: 'Contractors', team: CFG.contractorTeam?.name || 'Hot Desks',
      role: `Contractor · ${CFG.tools[x.tool]?.label || x.tool}`,
      task: x.title, desc: '', schedule: 'One-off session', enabled: true, lastRun: x.lastActive, nextRun: null, runs: 1, status: x.status,
      activity: x.status === 'sleeping' ? 'Wrapped up for the day' : x.activity,
      session: { title: x.title, project: x.project, cwd: x.cwd, model: x.model, sid: x.sid, lastActive: x.lastActive }, feed: x.feed.slice(-20),
      helpers: x.status === 'working' || x.status === 'waiting' ? x.helpers || [] : [], reach: x.status === 'working' ? x.reach || null : null,
      stats: aggregate(aRuns.filter((r) => r.sid === x.sid), cb, CFG.analyticsDays || 30),
    }));
  // privacy: config.privacy.hideFeed keeps the office working but drops prompt/response text
  if (CFG.privacy?.hideFeed) for (const e of [...staff, ...contractors]) {
    e.feed = e.feed.map((f) => ({ t: f.t, k: f.k, x: f.k === 'tool' ? String(f.x).split(':')[0] : f.k === 'prompt' ? 'prompt hidden' : f.k === 'say' ? 'reply hidden' : 'hidden' }));
    if (e.stats?.recent) e.stats.recent = e.stats.recent.map((r) => ({ ...r, outcome: '', topFiles: [] }));
    if (e.session) e.session = { ...e.session, title: e.task };
  }
  const bridged = bridgedStaff(cb);
  staff.push(...bridged);
  assignNames(staff, CFG.names, 's:');
  assignNames(contractors, CFG.contractorNames, 'c:');
  for (const e of [...staff, ...contractors]) e.look = hash(e.id + 'look');
  // company-wide totals straight from codeburn (every session on this Mac, not only staff)
  const cbl = Object.values(cb);
  const totals = cbl.length ? { cost: cbl.reduce((a, c) => a + c.cost, 0), tokens: cbl.reduce((a, c) => a + c.in + c.out + c.cr + c.cw, 0), sessions: cbl.length, calls: cbl.reduce((a, c) => a + c.calls, 0) } : null;
  const empty = !staff.length && !contractors.length;
  if (empty || DEMO_MODE) { STATE = { ...demoState(CFG), demo: true, at: Date.now(), syncedAt: Date.now() }; broadcast(); push(); return; }
  STATE = {
    company: CFG.company, departments: CFG.departments, at: Date.now(), syncedAt: Date.now(),
    tagline: CFG.tagline || 'agents that never clock out',
    tools: { ...CFG.tools, ...Object.fromEntries([...new Set(staff.map((e) => e.tool))].filter((t) => !CFG.tools[t]).map((t) => [t, { label: titleCase(t), color: BRIDGE_COLORS[hash(t) % BRIDGE_COLORS.length] }])) },
    teams: Object.fromEntries([...(CFG.teams || []), CFG.contractorTeam || { name: 'Hot Desks', color: '#9AA7D0' }].map((t, i) => [t.name, { color: t.color, order: i }])),
    hermesNote: hermes.error ? 'remote: ' + hermes.error : hermes.at ? 'remote synced ' + Math.round((Date.now() - hermes.at) / 1000) + 's ago' : '',
    totals, analyticsDays: CFG.analyticsDays || 30,
    staff: [...staff, ...contractors],
  };
  broadcast();
  push();
}

// ---------- sync: Mac collector → VPS relay ----------
let lastPushBody = '', lastPushAt = 0, pushFailing = false;
function push() {
  if (!PUSH_URL || !PUSH_TOKEN) return;
  const { at, syncedAt, ...rest } = STATE;
  const body = JSON.stringify(rest);
  if (body === lastPushBody && Date.now() - lastPushAt < 30e3) return;
  if (Date.now() - lastPushAt < 4e3) return;
  lastPushAt = Date.now();
  const gz = zlib.gzipSync(JSON.stringify(STATE));
  fetch(PUSH_URL, { method: 'POST', headers: { authorization: `Bearer ${PUSH_TOKEN}`, 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gz, signal: AbortSignal.timeout(15000) })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); lastPushBody = body; if (pushFailing) console.log('[push] ok again'); pushFailing = false; })
    .catch((e) => { if (!pushFailing) console.log('[push] failed:', e.message); pushFailing = true; });
}

// ---------- http ----------
const clients = new Set();
function broadcast() { const msg = `data: ${JSON.stringify(STATE)}\n\n`; for (const res of clients) res.write(msg); }
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function authorized(req) {
  if (!OFFICE_PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  return safeEq(u, OFFICE_USER) && safeEq(rest.join(':'), OFFICE_PASSWORD);
}
const STATE_FILE = process.env.STATE_FILE || '';
if (RELAY && STATE_FILE) { try { STATE = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {} }
let saveTimer = null;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/api/push' && req.method === 'POST') {
    if (!RELAY || !PUSH_TOKEN || !safeEq(req.headers.authorization || '', `Bearer ${PUSH_TOKEN}`)) { res.writeHead(401); return res.end(); }
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 20 << 20) { res.writeHead(413); return res.end(); } chunks.push(c); }
    try {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
      const next = JSON.parse(buf.toString('utf8'));
      if (!Array.isArray(next.staff)) throw new Error('bad payload');
      STATE = { ...next, syncedAt: Date.now() };
      broadcast();
      if (STATE_FILE) { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.promises.writeFile(STATE_FILE, JSON.stringify(STATE)).catch(() => {}), 5000); }
      res.writeHead(204); return res.end();
    } catch (e) { res.writeHead(400); return res.end(e.message); }
  }
  if (!authorized(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="virtual agents office"' }); return res.end('Login required'); }
  if (url.pathname === '/api/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(STATE)); }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`data: ${JSON.stringify(STATE)}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  const pub = path.join(HERE, 'public');
  const p = path.join(pub, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!p.startsWith(pub)) { res.writeHead(403); return res.end(); }
  try { const b = await fsp.readFile(p); res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(b); }
  catch { res.writeHead(404); res.end('not found'); }
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`\n  Already running → http://localhost:${PORT}\n`); if (process.send) process.send({ ready: true, url: `http://localhost:${PORT}` }); else process.exit(0); return; }
  throw e;
}).listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  ${CFG.company || 'Virtual agents office'} - ${RELAY ? 'relay' : DEMO_MODE ? 'demo office' : 'reading this machine'}`);
  console.log(`  ▸ ${url}${PUSH_URL ? `  (pushing to ${PUSH_URL})` : ''}\n`);
  if (process.send) process.send({ ready: true, url });
});

if (!RELAY) {
  pingOpenclaw(); pollHermes(); refresh();
  setInterval(refresh, 3000);
  setInterval(pingOpenclaw, 15000);
  setInterval(pollHermes, (CFG.hermes?.pollSeconds || 20) * 1000);
  const scanLoop = () => analytics.scan().catch((e) => console.log('[analytics]', e.message)).finally(() => setTimeout(scanLoop, 2 * 60e3));
  setTimeout(scanLoop, 1500);
}
