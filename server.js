// Lifeboat game server. No dependencies: run `node server.js`, then open the address it prints.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
// The host key is random on every start unless you set HOST_KEY yourself. It is printed in this terminal only.
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString('hex').toUpperCase();
const TEAM_SIZE = 10, MAX_TEAMS = 20;
const CHARS = ['Doctor', 'Cook', 'Priest', 'Engineer', 'Teacher', 'Soldier', 'Farmer', 'Journalist', 'Child', 'Elderly Scientist'];
// phase: [next phase, seconds]. Timed phases advance on their own; the host can also skip ahead.
const FLOW = { lobby: ['captain', 0], captain: ['story', 60], story: ['r1', 14], r1: ['discuss', 180], discuss: ['group', 300], group: ['results', 180], results: [null, 0] };

/* ===== Game state (null-prototype objects: ids like "__proto__" can't reach Object.prototype) ===== */
let S;
const reset = () => { S = { phase: 'lobby', endsAt: 0, startedAt: 0, players: Object.create(null), teams: Object.create(null) }; };
reset();

// Captain = most votes; a tie goes to whoever joined first; no votes = first to join. Locked once voting ends.
function leader(t) {
  const tally = t.members.map(pid => t.members.filter(v => S.players[v].vote === pid).length);
  let best = 0; tally.forEach((n, i) => { if (n > tally[best]) best = i; });
  return t.members[best];
}
const capId = t => t.captain || (S.phase === 'lobby' ? null : leader(t));
function setPhase(p) {
  if (!p) return;
  if (p !== 'lobby' && p !== 'captain') Object.values(S.teams).forEach(t => { if (!t.captain) t.captain = leader(t); });
  S.phase = p; S.startedAt = Date.now();
  const d = FLOW[p][1]; S.endsAt = d ? S.startedAt + d * 1000 : 0;
}
function tick() { while (S.endsAt && Date.now() >= S.endsAt) setPhase(FLOW[S.phase][0]); }

// A list is valid only if it is exactly the 10 passengers, each once.
const valid = l => Array.isArray(l) && l.length === CHARS.length && l.every(x => typeof x === 'string') && new Set(l).size === CHARS.length && CHARS.every(c => l.includes(c));
// Absolute difference per character: |your seat - group seat|. Total 0 = identical, max 50.
const diffs = (mine, group) => CHARS.map(c => Math.abs(mine.indexOf(c) - group.indexOf(c)));
const total = (p, t) => p.list && t.group ? diffs(p.list, t.group).reduce((a, b) => a + b, 0) : null;

function teamOut(n) {
  const t = S.teams[n], showScores = S.phase === 'results', cap = capId(t);
  const members = t.members.map(pid => { const p = S.players[pid]; return { name: p.name, done: !!p.list, total: showScores ? total(p, t) : undefined, votes: t.members.filter(v => S.players[v].vote === pid).length }; });
  const scored = members.filter(m => m.total != null);
  return { team: +n, captain: cap ? S.players[cap].name : null, captainLocked: !!t.captain, members, group: t.group,
    avg: showScores && scored.length ? Math.round(scored.reduce((a, m) => a + m.total, 0) / scored.length * 10) / 10 : null };
}
function stateFor(id) {
  const p = player(id);
  if (!p) return { error: 'unknown', phase: S.phase, chars: CHARS };
  const t = S.teams[p.team];
  const result = S.phase === 'results' && p.list && t.group ? { diffs: diffs(p.list, t.group), total: total(p, t) } : null;
  return { phase: S.phase, endsAt: S.endsAt, startedAt: S.startedAt, now: Date.now(), chars: CHARS,
    me: { name: p.name, team: p.team, captain: capId(t) === id && !!t.captain, list: p.list, vote: p.vote ? t.members.indexOf(p.vote) : -1 },
    team: teamOut(p.team), result };
}

/* ===== Input hygiene ===== */
const ID_RE = /^[0-9a-f]{32}$/;
const player = id => typeof id === 'string' && ID_RE.test(id) ? S.players[id] : undefined;
// Names: no control, zero-width or bidi-override characters (they can spoof other names); 1–20 visible characters.
const cleanName = s => String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁩﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const hashKey = s => crypto.createHash('sha256').update(String(s)).digest();
const HOST_HASH = hashKey(HOST_KEY.toUpperCase());

/* ===== Rate limits per device (IP). Normal polling uses about 40 requests a minute. ===== */
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
  'POST /api/join': ({ b, ip }) => {
    if ((bucket(ip).n += 9) > 240) return { error: 'Too many attempts. Wait a minute and try again.' };
    const name = cleanName(b.name), team = Number(b.team);
    if (!name) return { error: 'Enter your name.' };
    if (!Number.isInteger(team) || team < 1 || team > MAX_TEAMS) return { error: `Pick a team from 1 to ${MAX_TEAMS}.` };
    const t = S.teams[team] || (S.teams[team] = { members: [], captain: null, group: null });
    if (t.members.length >= TEAM_SIZE) return { error: `Team ${team} is full.` };
    if (t.members.some(pid => S.players[pid].name.toLowerCase() === name.toLowerCase())) return { error: `Someone in Team ${team} already uses that name. Add an initial.` };
    const id = crypto.randomBytes(16).toString('hex');
    S.players[id] = { name, team, list: null, vote: null };
    t.members.push(id);
    if (!t.captain && S.phase !== 'lobby' && S.phase !== 'captain') t.captain = id;   // late joiner starts a team after voting
    return { id };
  },
  'POST /api/vote': ({ b }) => {
    const p = player(b.id), t = p && S.teams[p.team];
    if (!p || S.phase !== 'captain' || !Number.isInteger(b.pick) || !t.members[b.pick]) return { error: 'Voting is closed.' };
    p.vote = t.members[b.pick]; return { ok: true };
  },
  'POST /api/rank': ({ b }) => {
    const p = player(b.id);
    if (!p || S.phase !== 'r1' || p.list) return { error: 'Not accepted now.' };
    if (!valid(b.list)) return { error: 'Seat all 10 passengers.' };
    p.list = b.list.slice(); return { ok: true };
  },
  'POST /api/group': ({ b }) => {
    const p = player(b.id), t = p && S.teams[p.team];
    if (!p || S.phase !== 'group' || capId(t) !== b.id || t.group) return { error: 'Not accepted now.' };
    if (!valid(b.list)) return { error: 'Seat all 10 passengers.' };
    t.group = b.list.slice(); return { ok: true };
  },
  'GET /api/host': ({ req, ip }) => {
    const ok = hostOK(req, ip); if (ok !== true) return hostDenied(ok);
    return { phase: S.phase, endsAt: S.endsAt, startedAt: S.startedAt, now: Date.now(), players: Object.keys(S.players).length,
      teams: Object.keys(S.teams).sort((a, b) => a - b).map(teamOut) };
  },
  'POST /api/host': ({ b, req, ip }) => {
    const ok = hostOK(req, ip); if (ok !== true) return hostDenied(ok);
    if (b.action === 'next') setPhase(FLOW[S.phase][0]);
    else if (b.action === 'more' && S.endsAt) S.endsAt += 60000;
    else if (b.action === 'reset') reset();
    else return { error: 'Unknown action.' };
    return { ok: true };
  },
};

/* ===== HTTP ===== */
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()' };
const send = (res, code, obj) => { res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(resolve => {
  let d = '', done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
  req.setEncoding('utf8');
  req.on('data', c => { d += c; if (d.length > 8192) { finish(null); req.destroy(); } });
  req.on('end', () => { try { const o = JSON.parse(d || '{}'); finish(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); } catch { finish({}); } });
  req.on('error', () => finish(null)); req.on('close', () => finish(null));
});
const PAGE = path.join(__dirname, 'public', 'index.html');

http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  let u; try { u = new URL(req.url, 'http://local'); } catch { res.writeHead(400, BASE_HEADERS); return res.end(); }
  const route = routes[req.method + ' ' + u.pathname];
  if (route) {
    if (++bucket(ip).n > 240) return send(res, 429, { error: 'Too many requests. Slow down.' });
    let body = {};
    if (req.method === 'POST') {
      // Cross-site protection: JSON only, and only from this same site
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only.' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return send(res, 403, { error: 'Cross-site request blocked.' });
      body = await readBody(req);
      if (body === null) return send(res, 413, { error: 'Request too large.' });
    }
    tick();
    return send(res, 200, route({ q: u.searchParams, b: body, req, ip }));
  }
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/host')) {
    let html; try { html = fs.readFileSync(PAGE, 'utf8'); } catch { res.writeHead(500, BASE_HEADERS); return res.end('Page missing'); }
    // Only this page's own script may run (per-request nonce); no framing, no outside connections.
    const nonce = crypto.randomBytes(16).toString('base64');
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
    return res.end(html.replace('<script>', `<script nonce="${nonce}">`));
  }
  res.writeHead(req.method === 'GET' ? 404 : 405, { ...BASE_HEADERS, 'Content-Type': 'text/plain' }); res.end('Not found');
}).listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Lifeboat running.\n  Students: ${ips.map(ip => `http://${ip}:${PORT}`).join('  ') || `http://localhost:${PORT}`}\n  Host:     http://localhost:${PORT}/host\n  Host key: ${HOST_KEY}   (keep it private; it changes on every restart unless you set HOST_KEY)`);
});
