// A synthetic office, shown when this machine has no agent history yet (or with --demo).
// Nothing here is read from disk: it exists so the first run still looks like something.
const DAY = 86400e3;
const pick = (a, i) => a[i % a.length];

const PEOPLE = [
  ['daily-blog-draft', 'Content Studio', 'Marketing', 'claude', 'Content Writer', 'Weekdays 10:30', 'Drafts tomorrow’s post and stages it for review.'],
  ['weekly-seo-audit', 'SEO Squad', 'Marketing', 'claude', 'SEO Auditor', 'Mon 09:00', 'Crawls the site, scores pages, files the findings.'],
  ['backlink-prospecting', 'SEO Squad', 'Marketing', 'codex', 'Link Builder', 'Sun 15:00', 'Finds and vets link opportunities, drafts the outreach.'],
  ['social-scheduler', 'Content Studio', 'Marketing', 'cowork', 'Social Media Manager', 'Daily 08:00', 'Queues the day’s posts across channels.'],
  ['newsletter-digest', 'Content Studio', 'Marketing', 'claude', 'Newsletter Editor', 'Fri 16:00', 'Summarises the week into a draft issue.'],
  ['github-release-sync', 'Ops & Release', 'Engineering', 'claude', 'Release Manager', 'Daily 13:30', 'Commits, pushes and watches the deploy.'],
  ['nightly-backup', 'Ops & Release', 'Engineering', 'codex', 'Backup Operator', 'Daily 02:00', 'Snapshots the database and verifies the restore.'],
  ['flaky-test-triage', 'Ops & Release', 'Engineering', 'claude', 'QA Engineer', 'Weekdays 07:30', 'Re-runs failures and files the real ones.'],
  ['inbox-triage', 'Support Desk', 'Operations', 'claude', 'Support Agent', 'Every 2h', 'Reads new mail, drafts replies, escalates the rest.'],
  ['uptime-watch', 'Support Desk', 'Operations', 'codex', 'Monitoring Agent', 'Every 15m', 'Checks endpoints and pings you when something is down.'],
  ['competitor-radar', 'Research Pod', 'Research', 'claude', 'Researcher', 'Tue 11:00', 'Tracks competitor launches and pricing changes.'],
  ['invoice-chaser', 'Finance Desk', 'Finance', 'cowork', 'Finance Assistant', 'Mon 10:00', 'Reconciles payments and chases what’s overdue.'],
  ['lead-enrichment', 'Sales Pod', 'Sales', 'codex', 'Sales Development Rep', 'Daily 09:30', 'Enriches new signups and files them in the CRM.'],
];
const NAMES = ['Maya', 'Arjun', 'Zoe', 'Kabir', 'Lena', 'Rohan', 'Isla', 'Dev', 'Aria', 'Neil', 'Tara', 'Omar', 'Leo'];
const TEAM_COLORS = { 'Content Studio': '#FF6B5E', 'SEO Squad': '#FF9F43', 'Ops & Release': '#4DA3FF', 'Support Desk': '#3CCB7F', 'Research Pod': '#A77BFF', 'Finance Desk': '#F368E0', 'Sales Pod': '#F7C548', 'Hot Desks': '#9AA7D0' };
const OUTCOMES = [
  'Drafted and staged the post, 1,180 words, waiting for your review before it goes live.',
  'Audit passed: 148 pages crawled, 3 title tags rewritten, no broken links left.',
  'Filed 6 prospects and drafted the outreach. Nothing was sent.',
  'Pushed 4 commits and the deploy went green in 2m 14s.',
  'Backup verified: 1.2 GB snapshot, restore test passed.',
  'Triaged 18 messages, drafted 5 replies, escalated 1 to you.',
];

function stats(seed, runs, costPerRun, days = 30) {
  const daily = [];
  let cost = 0, tok = 0, failed = 0;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const active = (seed + i) % Math.max(2, Math.round(30 / Math.max(1, runs / 3))) === 0;
    const r = active ? 1 + ((seed + i) % 2) : 0;
    const c = r * costPerRun * (0.7 + ((seed + i) % 7) / 10);
    const f = active && (seed + i) % 23 === 0 ? 1 : 0;
    failed += f; cost += c; tok += r * 1.4e6;
    daily.push({ d: key, runs: r, cost: +c.toFixed(3), tok: r * 1.4e6, failed: f });
  }
  const total = daily.reduce((a, b) => a + b.runs, 0) || 1;
  return {
    runs: total, ok: total - failed, failed, successRate: (total - failed) / total,
    cost: +cost.toFixed(2), tokens: tok, tok: { in: tok * 0.02, out: tok * 0.03, cr: tok * 0.93, cw: tok * 0.02 },
    cacheHit: 0.93 + (seed % 6) / 100, avgMs: (3 + (seed % 9)) * 60e3,
    work: { files: (seed * 3) % 40, edits: (seed * 5) % 90, cmds: (seed * 17) % 400, git: (seed * 2) % 20, web: (seed * 11) % 120, notion: (seed * 7) % 30, email: seed % 9, helpers: seed % 5, tools: (seed * 23) % 900 },
    daily,
    recent: Array.from({ length: 5 }, (_, i) => ({
      sid: 'demo-' + seed + '-' + i, start: Date.now() - (i + 1) * DAY - seed * 3600e3, ms: (4 + ((seed + i) % 20)) * 60e3,
      cost: +(costPerRun * (0.8 + ((seed + i) % 5) / 10)).toFixed(2), tokens: 1.3e6 + i * 2e5,
      outcome: pick(OUTCOMES, seed + i), failed: i === 3 && seed % 4 === 0 ? 'API Error: rate limit reached' : null,
      files: (seed + i) % 5, topFiles: ['index.html', 'notes.md'].slice(0, (seed + i) % 3), git: (seed + i) % 3, notion: (seed + i) % 4, email: 0,
    })),
  };
}

export function demoState(CFG = {}) {
  const now = Date.now();
  const staff = PEOPLE.map(([key, team, dept, tool, role, schedule, desc], i) => {
    const seed = i * 7 + 3;
    const status = i === 0 ? 'working' : i === 5 ? 'working' : i === 8 ? 'waiting' : i === 2 ? 'idle' : i === 11 ? 'paused' : 'sleeping';
    const feed = [
      { t: now - 240e3, k: 'prompt', x: `Scheduled run: ${key.replace(/-/g, ' ')}` },
      { t: now - 180e3, k: 'think', x: 'thinking…' },
      { t: now - 120e3, k: 'tool', x: 'Reading site/pages.json' },
      { t: now - 60e3, k: 'tool', x: 'Editing index.html' },
      { t: now - 20e3, k: 'say', x: pick(OUTCOMES, seed) },
    ];
    return {
      id: 'demo:' + key, key, kind: 'staff', tool, dept, team, role, task: key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), desc,
      schedule, enabled: status !== 'paused', lastRun: now - (status === 'working' ? 30e3 : status === 'idle' ? 4 * 60e3 : (i + 1) * 5 * 3600e3),
      nextRun: status === 'paused' ? null : now + (i + 1) * 3.4 * 3600e3, runs: 3 + (i % 5), status,
      activity: status === 'working' ? (i === 0 ? 'Briefing helpers: competitor research' : 'Editing index.html') : status === 'waiting' ? 'Needs approval: Running: git push origin main' : status === 'paused' ? 'On leave (paused)' : status === 'idle' ? 'Done - task complete' : 'Asleep until next shift',
      session: { title: key, project: 'demo-project', cwd: '~/demo-project', model: tool === 'codex' ? 'gpt-5' : 'opus-5', sid: 'demo-' + key, lastActive: now },
      feed: status === 'sleeping' || status === 'paused' ? feed.slice(0, 3) : feed,
      helpers: i === 0 ? [{ id: 'h1', task: 'Pull the top 10 results for the topic' }, { id: 'h2', task: 'Summarise last week’s analytics' }] : [],
      reach: i === 5 ? 'codex' : null, online: null, failed: i === 7 ? 'API Error: rate limit reached' : null,
      stats: stats(seed, 4 + (i % 6), 0.8 + (i % 5) * 0.6), look: (seed * 2654435761) >>> 0, name: pick(NAMES, i),
    };
  });
  const teams = Object.fromEntries(Object.entries(TEAM_COLORS).map(([name, color], i) => [name, { color, order: i }]));
  const totals = { cost: staff.reduce((a, e) => a + e.stats.cost, 0), tokens: staff.reduce((a, e) => a + e.stats.tokens, 0), sessions: staff.reduce((a, e) => a + e.stats.runs, 0), calls: 4200 };
  return {
    company: CFG.company || 'Agents office', tagline: CFG.tagline || 'agents that never clock out',
    departments: CFG.departments || {}, tools: CFG.tools || {}, teams, analyticsDays: CFG.analyticsDays || 30,
    totals, hermesNote: '', staff,
  };
}
