// Per-run analytics for the office: what each run produced (files, commits, Notion writes, drafts…)
// plus cost/tokens from codeburn (https://github.com/getagentseal/codeburn) when it's installed.
// Full transcripts are parsed once and cached in .analytics-cache.json (keyed by mtime+size).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFile } from 'node:child_process';

const HOME = os.homedir();
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const tsMs = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t) || 0);
const FAIL_RE = /API Error|Failed to authenticate|access token has expired|usage limit|rate limit/i;

function blank(tool, sid) {
  return { tool, sid, title: '', firstPrompt: '', originator: '', start: 0, end: 0, tools: 0, edits: 0, files: new Set(), cmds: 0, git: 0, web: 0, notion: 0, email: 0, helpers: 0,
    outcome: '', failed: null, tok: { in: 0, out: 0, cr: 0, cw: 0 }, model: '' };
}
// Sort one tool call into the "work delivered" buckets.
function classify(s, name, input) {
  let inp = input;
  if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch { inp = { raw: inp }; } }
  inp = inp || {};
  const n = String(name || ''), cmd = String(Array.isArray(inp.command) ? inp.command.join(' ') : inp.command || inp.cmd || '');
  s.tools++;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(n)) { s.edits++; if (inp.file_path) s.files.add(inp.file_path); }
  else if (n === 'apply_patch') { s.edits++; for (const m of String(inp.input || inp.raw || inp.patch || '').matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)) s.files.add(m[1].trim()); }
  else if (/^(Bash|exec_command|shell|local_shell|container\.exec)$/.test(n)) { s.cmds++; if (/\bgit (commit|push)\b/.test(cmd)) s.git++; }
  else if (/^(Agent|Task)$/.test(n)) s.helpers++;
  if (/^(WebFetch|WebSearch|web_search)$/.test(n) || /(browser|chrome|navigate|scrape|firecrawl|fetch_url|get_page)/i.test(n)) s.web++;
  if (/notion/i.test(n) && /(create|update|move|duplicate|append)/i.test(n)) s.notion++;
  if (/(gmail|resend|smartlead|mail|inbox)/i.test(n) && /(draft|send|reply|create_email|create-email)/i.test(n)) s.email++;
}
function finish(s) {
  const out = { ...s, files: s.files.size, topFiles: [...s.files].slice(-5).map((f) => path.basename(f)) };
  out.failed = s.outcome && FAIL_RE.test(s.outcome) ? clip(s.outcome, 140) : null;
  out.outcome = clip(s.outcome, 280);
  out.firstPrompt = s.firstPrompt.slice(0, 200);
  return out;
}

async function parseClaude(f, sid) {
  const s = blank('claude', sid);
  const seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const line of rl) {
    const a = line.includes('"type":"assistant"'), t = line.includes('-title"') || line.includes('"type":"summary"');
    const u = !s.firstPrompt && line.includes('"type":"user"');
    if (!a && !t && !u) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'custom-title' || r.type === 'ai-title') s.title = r.customTitle || r.aiTitle || s.title;
    if (r.type === 'summary' && !s.title) s.title = r.summary;
    if (r.isSidechain) continue;
    const ts = tsMs(r.timestamp);
    if (ts) { s.start ||= ts; s.end = ts; }
    if (r.type === 'user' && !r.isMeta) {
      const c = r.message?.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
      if (txt && !txt.startsWith('<')) s.firstPrompt = txt;
    }
    if (r.type === 'assistant' && r.message) {
      const m = r.message;
      s.model = m.model || s.model;
      if (m.id && m.usage && !seen.has(m.id)) {
        seen.add(m.id);
        s.tok.in += m.usage.input_tokens || 0; s.tok.out += m.usage.output_tokens || 0;
        s.tok.cr += m.usage.cache_read_input_tokens || 0; s.tok.cw += m.usage.cache_creation_input_tokens || 0;
      }
      for (const it of m.content || []) {
        if (it.type === 'tool_use') classify(s, it.name, it.input);
        if (it.type === 'text' && it.text.trim()) s.outcome = it.text;
      }
    }
  }
  return finish(s);
}

async function parseCodex(f) {
  const s = blank('codex', path.basename(f));
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const line of rl) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    const p = r.payload || {};
    const ts = tsMs(r.timestamp);
    if (ts) { s.start ||= ts; s.end = ts; }
    if (r.type === 'session_meta') { s.sid = p.session_id || p.id || s.sid; s.originator = p.originator || ''; if (p.originator === 'openclaw') s.tool = 'openclaw'; }
    if (r.type === 'turn_context' && p.model) s.model = p.model;
    if (r.type === 'event_msg') {
      if (p.type === 'user_message' && p.message && !s.firstPrompt) s.firstPrompt = p.message;
      if (p.type === 'token_count' && p.info?.total_token_usage) { const u = p.info.total_token_usage; s.tok = { in: (u.input_tokens || 0) - (u.cached_input_tokens || 0), out: u.output_tokens || 0, cr: u.cached_input_tokens || 0, cw: 0 }; }
    }
    if (r.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') classify(s, p.name || p.type, p.arguments || p.input || p.action);
      if (p.type === 'message' && p.role === 'assistant') { const txt = (p.content || []).map((c) => c.text || '').join(' ').trim(); if (txt) s.outcome = txt; }
    }
  }
  return finish(s);
}

export function createAnalytics({ dir, days = 30, log = () => {} }) {
  const cachePath = path.join(dir, '.analytics-cache.json');
  let cache = { files: {}, cb: {}, cbAt: 0 };
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(cachePath, 'utf8')) }; } catch {}
  const WIN = days * 86400e3;
  let busy = false, version = 1;

  async function listFiles() {
    const out = [];
    const root = path.join(HOME, '.claude/projects');
    for (const d of await fsp.readdir(root).catch(() => [])) {
      for (const e of await fsp.readdir(path.join(root, d)).catch(() => [])) {
        if (e.endsWith('.jsonl')) out.push({ f: path.join(root, d, e), kind: 'claude', sid: e.slice(0, -6) });
      }
    }
    for (let back = 0; back <= days; back++) {
      const dt = new Date(Date.now() - back * 86400e3);
      const cdir = path.join(HOME, '.codex/sessions', String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, '0'), String(dt.getDate()).padStart(2, '0'));
      for (const e of await fsp.readdir(cdir).catch(() => [])) if (e.endsWith('.jsonl')) out.push({ f: path.join(cdir, e), kind: 'codex' });
    }
    return out;
  }

  function codeburnPath() {
    for (const p of ['/opt/homebrew/bin/codeburn', '/usr/local/bin/codeburn', path.join(HOME, '.npm-global/bin/codeburn')]) if (fs.existsSync(p)) return p;
    return 'codeburn';
  }
  function runCodeburn() {
    return new Promise((resolve) => {
      execFile(codeburnPath(), ['sessions', '--format', 'json', '--period', '30days'], { timeout: 120000, maxBuffer: 64 << 20, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } }, (err, stdout) => {
        if (err) { log('codeburn: ' + err.message); return resolve(false); }
        try {
          const list = JSON.parse(stdout), cb = {};
          for (const x of list) cb[x.sessionId] = { provider: x.provider, cost: x.cost || 0, calls: x.calls || 0, in: x.inputTokens || 0, out: x.outputTokens || 0, cr: x.cacheReadTokens || 0, cw: x.cacheWriteTokens || 0, models: x.models || [], start: tsMs(x.startedAt), end: tsMs(x.endedAt), project: x.project };
          cache.cb = cb; cache.cbAt = Date.now(); resolve(true);
        } catch (e) { log('codeburn parse: ' + e.message); resolve(false); }
      });
    });
  }

  async function scan() {
    if (busy) return; busy = true;
    try {
      let changed = 0;
      const live = new Set();
      for (const { f, kind, sid } of await listFiles()) {
        let st; try { st = await fsp.stat(f); } catch { continue; }
        if (Date.now() - st.mtimeMs > WIN) continue;
        live.add(f);
        const key = `${st.mtimeMs}:${st.size}`;
        if (cache.files[f]?.key === key) continue;
        // don't re-parse a file that is being written right now more than once a minute
        if (cache.files[f] && Date.now() - (cache.files[f].at || 0) < 60e3) continue;
        try { cache.files[f] = { key, at: Date.now(), s: kind === 'claude' ? await parseClaude(f, sid) : await parseCodex(f) }; changed++; } catch (e) { log('parse ' + f + ': ' + e.message); }
      }
      for (const f of Object.keys(cache.files)) if (!live.has(f)) { delete cache.files[f]; changed++; }
      if (Date.now() - cache.cbAt > 10 * 60e3 && await runCodeburn()) changed++;
      if (changed) { version++; await fsp.writeFile(cachePath, JSON.stringify(cache)).catch(() => {}); }
    } finally { busy = false; }
  }

  return {
    scan,
    version: () => version,
    sessions: () => Object.values(cache.files).map((x) => x.s).filter((s) => s && s.start),
    codeburn: () => cache.cb,
  };
}

// Roll a set of runs up into one employee's scorecard.
export function aggregate(runs, cb, days = 30) {
  const now = Date.now(), W = days * 86400e3;
  runs = runs.filter((r) => now - (r.end || r.start) < W).sort((a, b) => b.start - a.start);
  const tot = { runs: runs.length, failed: 0, cost: 0, costKnown: false, tok: { in: 0, out: 0, cr: 0, cw: 0 }, durs: [],
    work: { files: 0, edits: 0, cmds: 0, git: 0, web: 0, notion: 0, email: 0, helpers: 0, tools: 0 } };
  const byDay = new Map();
  for (const r of runs) {
    const c = cb[r.sid];
    if (c) { tot.cost += c.cost; tot.costKnown = true; }
    const t = c ? { in: c.in, out: c.out, cr: c.cr, cw: c.cw } : r.tok || { in: 0, out: 0, cr: 0, cw: 0 };
    for (const k of ['in', 'out', 'cr', 'cw']) tot.tok[k] += t[k] || 0;
    if (r.failed) tot.failed++;
    const ms = (r.end || 0) - (r.start || 0);
    if (ms > 0 && ms < 6 * 3600e3) tot.durs.push(ms);
    for (const k of Object.keys(tot.work)) tot.work[k] += r[k] || 0;
    const d = new Date(r.start); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const b = byDay.get(key) || { runs: 0, cost: 0, tok: 0, failed: 0 };
    b.runs++; b.cost += c?.cost || 0; b.tok += (t.in || 0) + (t.out || 0) + (t.cr || 0) + (t.cw || 0); if (r.failed) b.failed++;
    byDay.set(key, b);
  }
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400e3); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    daily.push({ d: key, ...(byDay.get(key) || { runs: 0, cost: 0, tok: 0, failed: 0 }) });
  }
  const allTok = tot.tok.in + tot.tok.out + tot.tok.cr + tot.tok.cw;
  return {
    runs: tot.runs, ok: tot.runs - tot.failed, failed: tot.failed, successRate: tot.runs ? (tot.runs - tot.failed) / tot.runs : null,
    cost: tot.costKnown ? tot.cost : null, tokens: allTok, tok: tot.tok, cacheHit: allTok ? tot.tok.cr / (tot.tok.in + tot.tok.cr + tot.tok.cw || 1) : null,
    avgMs: tot.durs.length ? tot.durs.sort((a, b) => a - b)[Math.floor(tot.durs.length / 2)] : null, work: tot.work, daily,
    recent: runs.slice(0, 8).map((r) => ({ sid: r.sid, start: r.start, ms: (r.end || 0) - (r.start || 0), cost: cb[r.sid]?.cost ?? null,
      tokens: cb[r.sid] ? cb[r.sid].in + cb[r.sid].out + cb[r.sid].cr + cb[r.sid].cw : (r.tok ? r.tok.in + r.tok.out + r.tok.cr + r.tok.cw : null),
      outcome: r.outcome || '', failed: r.failed || null, files: r.files || 0, topFiles: r.topFiles || [], git: r.git || 0, notion: r.notion || 0, email: r.email || 0 })),
  };
}
