// Lifeboat game server. No dependencies: run `node server.js`, then open the address it prints.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
// The host key is random on every start unless you set HOST_KEY yourself. It is printed in this terminal only.
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString('hex').toUpperCase();
const TEAM_SIZE = 10, MAX_TEAMS = 20, MAX_MARKS = 90;
const CHARS = ['Doctor', 'Cook', 'Priest', 'Engineer', 'Teacher', 'Soldier', 'Farmer', 'Journalist', 'Child', 'Elderly Scientist'];
// phase: [next phase, seconds]. Timed phases advance on their own; the host can also skip ahead.
const FLOW = { lobby: ['story', 0], story: ['r1', 14], r1: ['discuss', 180], discuss: ['results', 900], results: [null, 0] };

/* ===== Game state (null-prototype objects: ids like "__proto__" can't reach Object.prototype) ===== */
let S;
const reset = () => { S = { phase: 'lobby', endsAt: 0, startedAt: 0, players: Object.create(null), teams: Object.create(null) }; };
reset();
// Class roster (optional): team number -> names. Survives a game reset so one roster serves several games.
let ROSTER = null;
// Accepts CSV/pasted text in either shape:  "team,name" rows (header optional, any column order)
// or a "Team 3" line followed by one name per line. Returns { roster } or { errors }.
function parseRoster(text) {
  const split = line => { const out = []; let cur = '', q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (!q && /[,;\t]/.test(ch)) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out.map(x => x.trim()).filter(x => x !== ''); };
  // "3", "Team 3", "Group 3", "T3", "G-3" -> 3
  const teamNo = x => { const m = /^(?:team|group|grp|t|g)?\s*[#-]?\s*(\d{1,2})$/i.exec(String(x).trim()); return m ? +m[1] : null; };
  const rows = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map(split).filter(r => r.length);
  const R = Object.create(null), errors = []; let cur = null, tCol = -1, nCol = -1;
  rows.forEach((r, i) => {
    const line = i + 1;
    if (i === 0 && r.some(x => /^(team|group)/i.test(x)) && r.some(x => /name/i.test(x))) { tCol = r.findIndex(x => /^(team|group)/i.test(x)); nCol = r.findIndex(x => /name/i.test(x)); return; }
    let team, name;
    if (tCol >= 0) { team = teamNo(r[tCol] ?? ''); name = r[nCol]; }
    else if (r.length === 1) {   // a "Team 3" heading, or a name under the last heading
      const n = teamNo(r[0]);
      if (n != null) { cur = n; if (n < 1 || n > MAX_TEAMS) errors.push(`Line ${line}: team must be 1 to ${MAX_TEAMS}.`); return; }
      team = cur; name = r[0];
    }
    else { const a = teamNo(r[0]), b = teamNo(r[1]); if (a != null) { team = a; name = r[1]; } else if (b != null) { team = b; name = r[0]; } else { errors.push(`Line ${line}: no team number found.`); return; } }
    name = cleanName(name);
    if (!team) return errors.push(`Line ${line}: put a "Team N" line or a team number before this name.`);
    if (team < 1 || team > MAX_TEAMS) return errors.push(`Line ${line}: team must be 1 to ${MAX_TEAMS}.`);
    if (!name) return errors.push(`Line ${line}: missing name.`);
    const list = R[team] || (R[team] = []);
    if (list.some(x => x.toLowerCase() === name.toLowerCase())) return errors.push(`Line ${line}: ${name} is listed twice in Team ${team}.`);
    list.push(name);
  });
  for (const t in R) if (R[t].length > TEAM_SIZE) errors.push(`Team ${t} has ${R[t].length} names; the most is ${TEAM_SIZE}.`);
  if (!errors.length && !Object.keys(R).length) errors.push('No names found.');
  return errors.length ? { errors: errors.slice(0, 8) } : { roster: R };
}
const taken = (team, name) => { const t = S.teams[team]; return !!t && t.members.some(pid => S.players[pid].name.toLowerCase() === name.toLowerCase()); };

// Discussion starts from the team's average Round 1 order, so nobody's list is favoured.
function startingOrder(t) {
  const lists = t.members.map(pid => S.players[pid].list).filter(Boolean);
  if (!lists.length) return CHARS.slice();
  const mean = c => lists.reduce((s, l) => s + l.indexOf(c), 0) / lists.length;
  return CHARS.slice().sort((a, b) => mean(a) - mean(b) || CHARS.indexOf(a) - CHARS.indexOf(b));
}
function setPhase(p) {
  if (!p) return;
  const teams = Object.values(S.teams);
  if (p === 'discuss') teams.forEach(t => { t.order = startingOrder(t); t.v = 1; t.approved = new Set(); t.group = null; t.lastBy = null; });
  if (p === 'results') teams.forEach(t => { if (!t.group) t.group = (t.order || startingOrder(t)).slice(); });   // time up: the shared order stands
  S.phase = p; S.startedAt = Date.now();
  const d = FLOW[p][1]; S.endsAt = d ? S.startedAt + d * 1000 : 0;
}
function tick() { while (S.endsAt && Date.now() >= S.endsAt) setPhase(FLOW[S.phase][0]); }

// A list is valid only if it is exactly the 10 passengers, each once.
const valid = l => Array.isArray(l) && l.length === CHARS.length && l.every(x => typeof x === 'string') && new Set(l).size === CHARS.length && CHARS.every(c => l.includes(c));
// Difference = sum over passengers of |your seat - team seat| (each at most 9, so at most 90). Marks = 90 - difference.
const diffs = (mine, group) => CHARS.map(c => Math.abs(mine.indexOf(c) - group.indexOf(c)));
const difference = (p, t) => p.list && t.group ? diffs(p.list, t.group).reduce((a, b) => a + b, 0) : null;
const marks = (p, t) => { const d = difference(p, t); return d == null ? null : MAX_MARKS - d; };

function teamOut(n, forHost) {   // only the host gets everyone's marks and order-change flags
  const t = S.teams[n], scores = forHost && S.phase === 'results';
  const members = t.members.map(pid => { const p = S.players[pid];
    return { name: p.name, done: !!p.list, approved: !!(t.approved && t.approved.has(pid)), marks: scores ? marks(p, t) : undefined, difference: scores ? difference(p, t) : undefined, ...(forHost && { changes: p.changes, undid: p.undid }) }; });
  const scored = members.filter(m => m.marks != null);
  return { team: +n, members, order: t.order || null, v: t.v || 0, approvals: t.approved ? t.approved.size : 0, group: t.group || null, lastBy: t.lastBy || null,
    avg: scores && scored.length ? Math.round(scored.reduce((a, m) => a + m.marks, 0) / scored.length * 10) / 10 : null };
}
function stateFor(id) {
  const p = player(id);
  if (!p) return { error: 'unknown', phase: S.phase, chars: CHARS };
  const t = S.teams[p.team];
  const result = S.phase === 'results' && p.list && t.group ? { diffs: diffs(p.list, t.group), difference: difference(p, t), marks: marks(p, t), max: MAX_MARKS } : null;
  return { phase: S.phase, endsAt: S.endsAt, startedAt: S.startedAt, now: Date.now(), chars: CHARS,
    me: { name: p.name, team: p.team, list: p.list, approved: !!(t.approved && t.approved.has(id)) }, team: teamOut(p.team), result };
}

/* ===== Input hygiene ===== */
const ID_RE = /^[0-9a-f]{32}$/;
const player = id => typeof id === 'string' && ID_RE.test(id) ? S.players[id] : undefined;
// Names: no control, zero-width or bidi-override characters (they can spoof other names); 1–20 visible characters.
const cleanName = s => String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁩﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const hashKey = s => crypto.createHash('sha256').update(String(s)).digest();
const HOST_HASH = hashKey(HOST_KEY.toUpperCase());

/* ===== Rate limits. Normal polling uses about 40 requests a minute per student.
   Limits are per player, because a whole class can share one IP (college NAT or a hosting proxy). ===== */
const PER_PLAYER = 240, PER_IP = 15000, JOINS_PER_IP = 200;
const hits = new Map();
function bucket(ip) {
  const now = Date.now(); let b = hits.get(ip);
  if (!b || now - b.t > 60000) { b = { t: now, n: 0, fails: b ? b.fails : 0, failT: b ? b.failT : 0 }; hits.set(ip, b); }
  if (now - b.failT > 10 * 60000) b.fails = 0;
  return b;
}
setInterval(() => { const now = Date.now(); for (const [ip, b] of hits) if (now - b.t > 10 * 60000) hits.delete(ip); }, 60000).unref();
// Host key: compared in constant time; 8 wrong tries locks that device out of the host page for 10 minutes.
function hostOK(req, ip) {
  const b = bucket(ip);
  if (b.fails >= 8) return 'locked';
  const k = req.headers['x-host-key'];
  const ok = typeof k === 'string' && k.length <= 64 && crypto.timingSafeEqual(hashKey(k.trim().toUpperCase()), HOST_HASH);
  if (!ok) { b.fails++; b.failT = Date.now(); }
  return ok;
}
const hostDenied = r => ({ error: r === 'locked' ? 'Too many wrong keys. Try again in 10 minutes.' : 'Wrong host key.' });

const routes = {
  'GET /api/state': ({ q }) => stateFor(q.get('id')),
  // Join screen: the class list with names already taken, or null when students type their own name.
  'GET /api/roster': () => ({ teams: ROSTER ? Object.keys(ROSTER).sort((a, b) => a - b).map(n => ({ team: +n, names: ROSTER[n].map(name => ({ name, taken: taken(n, name) })) })) : null }),
  'POST /api/join': ({ b, ip }) => {
    if (++bucket('j:' + ip).n > JOINS_PER_IP) return { error: 'Too many attempts. Wait a minute and try again.' };
    const name = cleanName(b.name), team = Number(b.team);
    if (!name) return { error: 'Enter your name.' };
    if (!Number.isInteger(team) || team < 1 || team > MAX_TEAMS) return { error: `Pick a team from 1 to ${MAX_TEAMS}.` };
    if (ROSTER && !ROSTER[team]) return { error: `Team ${team} isn't on the class list.` };
    const t = S.teams[team] || (S.teams[team] = { members: [], order: null, v: 0, approved: null, group: null, lastBy: null });
    if (ROSTER) {
      const listed = (ROSTER[team] || []).find(x => x.toLowerCase() === name.toLowerCase());
      if (!listed) return { error: `Pick your name from the Team ${team} list.` };
    }
    if (t.members.length >= TEAM_SIZE) return { error: `Team ${team} is full.` };
    if (t.members.some(pid => S.players[pid].name.toLowerCase() === name.toLowerCase())) return { error: ROSTER ? `${name} has already joined. If that is not you, ask the host to free your name.` : `Someone in Team ${team} already uses that name. Add an initial.` };
    const id = crypto.randomBytes(16).toString('hex');
    S.players[id] = { name: ROSTER ? ROSTER[team].find(x => x.toLowerCase() === name.toLowerCase()) : name, team, list: null, changes: 0, undid: 0 };
    t.members.push(id);
    if (S.phase === 'discuss' && !t.order) { t.order = startingOrder(t); t.v = 1; t.approved = new Set(); }
    if (t.approved) t.approved.clear();   // a new member hasn't approved yet
    return { id };
  },
  'POST /api/rank': ({ b }) => {
    const p = player(b.id);
    if (!p || S.phase !== 'r1' || p.list) return { error: 'Not accepted now.' };
    if (!valid(b.list)) return { error: 'Seat all 10 passengers.' };
    p.list = b.list.slice(); return { ok: true };
  },
  // Discussion: anyone on the team can rearrange the shared order. Any change clears every approval.
  'POST /api/order': ({ b }) => {
    const p = player(b.id), t = p && S.teams[p.team];
    if (!p || S.phase !== 'discuss' || !t.order || t.group) return { error: 'The team order is locked.' };
    if (!valid(b.list)) return { error: 'Keep all 10 passengers in the lifeboat.' };
    if (b.list.join('|') !== t.order.join('|')) {
      p.changes++; if ([...t.approved].some(pid => pid !== b.id)) p.undid++;   // flagged for the host
      t.order = b.list.slice(); t.v++; t.approved.clear(); t.lastBy = p.name;
    }
    return { ok: true, v: t.v };
  },
  // Approve the exact version you are looking at. When every member approves, the order locks.
  'POST /api/approve': ({ b }) => {
    const p = player(b.id), t = p && S.teams[p.team];
    if (!p || S.phase !== 'discuss' || !t.order || t.group) return { error: 'The team order is locked.' };
    if (b.v !== t.v) return { error: 'The order just changed. Check it again before approving.' };
    if (b.on === false) t.approved.delete(b.id); else t.approved.add(b.id);
    if (t.members.every(pid => t.approved.has(pid))) t.group = t.order.slice();
    return { ok: true };
  },
  'GET /api/host': ({ req, ip }) => {
    const ok = hostOK(req, ip); if (ok !== true) return hostDenied(ok);
    return { phase: S.phase, endsAt: S.endsAt, startedAt: S.startedAt, now: Date.now(), players: Object.keys(S.players).length, maxMarks: MAX_MARKS, roster: ROSTER,
      teams: Object.keys(S.teams).sort((a, b) => a - b).map(n => teamOut(n, true)) };
  },
  'POST /api/host': ({ b, req, ip }) => {
    const ok = hostOK(req, ip); if (ok !== true) return hostDenied(ok);
    if (b.action === 'next') setPhase(FLOW[S.phase][0]);
    else if (b.action === 'more' && S.endsAt) S.endsAt += 60000;
    else if (b.action === 'reset') reset();
    else if (b.action === 'roster') {
      if (S.phase !== 'lobby') return { error: 'Change the class list in the lobby, before the game starts.' };
      if (!String(b.text || '').trim()) { ROSTER = null; return { ok: true }; }
      const r = parseRoster(b.text); if (r.errors) return { error: r.errors.join('\n') };
      ROSTER = r.roster;
    }
    else if (b.action === 'kick') {   // frees a seat and a name, e.g. when a student's phone dies and they rejoin on another
      const t = S.teams[b.team], pid = t && t.members.find(x => S.players[x].name === b.name);
      if (!pid) return { error: 'Player not found.' };
      t.members = t.members.filter(x => x !== pid); delete S.players[pid];
      if (t.approved) t.approved.delete(pid);
      if (!t.members.length) delete S.teams[b.team];
      else if (S.phase === 'discuss' && t.order && !t.group && t.members.every(x => t.approved.has(x))) t.group = t.order.slice();
    }
    else return { error: 'Unknown action.' };
    return { ok: true };
  },
};

/* ===== HTTP ===== */
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()' };
const send = (res, code, obj) => { res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req, max = 8192) => new Promise(resolve => {
  let d = '', done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
  req.setEncoding('utf8');
  req.on('data', c => { d += c; if (d.length > max) { finish(null); req.destroy(); } });
  req.on('end', () => { try { const o = JSON.parse(d || '{}'); finish(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); } catch { finish({}); } });
  req.on('error', () => finish(null)); req.on('close', () => finish(null));
});
const PAGE = path.join(__dirname, 'public', 'index.html');

http.createServer(async (req, res) => {
  const fwd = process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket.remoteAddress || '?';
  let u; try { u = new URL(req.url, 'http://local'); } catch { res.writeHead(400, BASE_HEADERS); return res.end(); }
  const route = routes[req.method + ' ' + u.pathname];
  if (route) {
    if (++bucket(ip).n > PER_IP) return send(res, 429, { error: 'Too many requests. Slow down.' });
    let body = {};
    if (req.method === 'POST') {
      // Cross-site protection: JSON only, and only from this same site
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only.' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return send(res, 403, { error: 'Cross-site request blocked.' });
      body = await readBody(req, u.pathname === '/api/host' ? 65536 : 8192);
      if (body === null) return send(res, 413, { error: 'Request too large.' });
    }
    const pid = u.searchParams.get('id') || body.id;
    if (typeof pid === 'string' && ID_RE.test(pid) && ++bucket('p:' + pid).n > PER_PLAYER) return send(res, 429, { error: 'Too many requests. Slow down.' });
    tick();
    return send(res, 200, route({ q: u.searchParams, b: body, req, ip }));
  }
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/host' || u.pathname === '/demo')) {
    let html; try { html = fs.readFileSync(PAGE, 'utf8'); } catch { res.writeHead(500, BASE_HEADERS); return res.end('Page missing'); }
    // Only this page's own script may run (per-request nonce); no framing, no outside connections.
    const nonce = crypto.randomBytes(16).toString('base64');
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
    return res.end(html.replace('<script>', `<script nonce="${nonce}">`));
  }
  res.writeHead(req.method === 'GET' ? 404 : 405, { ...BASE_HEADERS, 'Content-Type': 'text/plain' }); res.end('Not found');
}).listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Lifeboat running.\n  Students: ${ips.map(ip => `http://${ip}:${PORT}`).join('  ') || `http://localhost:${PORT}`}\n  Host:     http://localhost:${PORT}/host\n  Host key: ${HOST_KEY}   (keep it private; it changes on every restart unless you set HOST_KEY)`);
});
