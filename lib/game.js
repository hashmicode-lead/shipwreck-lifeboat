// Game rules shared by both stores, and the in-memory store used by `node server.js` (one process, LAN play).
// The Supabase store (lib/supabase.js + supabase/schema.sql) implements the same calls inside Postgres.
'use strict';

const TEAM_SIZE = 10, MAX_TEAMS = 20, MAX_MARKS = 90;
const CHARS = ['Doctor', 'Cook', 'Priest', 'Engineer', 'Teacher', 'Soldier', 'Farmer', 'Journalist', 'Child', 'Elderly Scientist'];
// phase: [next phase, seconds]. Timed phases advance on their own; the host can also skip ahead.
const FLOW = { lobby: ['story', 0], story: ['r1', 14], r1: ['discuss', 180], discuss: ['results', 900], results: [null, 0] };

// Names: no control, zero-width or bidi-override characters (they can spoof other names); 1–20 visible characters.
const cleanName = s => String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁩﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

// Class list. Accepts CSV/pasted text in either shape: "team,name" rows (header optional, any column order)
// or a "Team 3" line followed by one name per line. Returns { roster: { "3": [names] } } or { errors }.
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
  return errors.length ? { errors: errors.slice(0, 8) } : { roster: { ...R } };
}

// A list is valid only if it is exactly the 10 passengers, each once.
const valid = l => Array.isArray(l) && l.length === CHARS.length && l.every(x => typeof x === 'string') && new Set(l).size === CHARS.length && CHARS.every(c => l.includes(c));
// Difference = sum over passengers of |your seat - team seat| (each at most 9, so at most 90). Marks = 90 - difference.
const diffs = (mine, group) => CHARS.map(c => Math.abs(mine.indexOf(c) - group.indexOf(c)));

/* ===== In-memory store (null-prototype objects: ids like "__proto__" can't reach Object.prototype) ===== */
function memoryStore() {
  let S, ROSTER = null;   // the class list survives a game reset, so one list serves several games
  const reset = () => { S = { phase: 'lobby', endsAt: 0, startedAt: 0, players: Object.create(null), teams: Object.create(null) }; };
  reset();
  const difference = (p, t) => p.list && t.group ? diffs(p.list, t.group).reduce((a, b) => a + b, 0) : null;
  const marks = (p, t) => { const d = difference(p, t); return d == null ? null : MAX_MARKS - d; };
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
  const taken = (team, name) => { const t = S.teams[team]; return !!t && t.members.some(pid => sameName(S.players[pid].name, name)); };

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
  const tick = () => { while (S.endsAt && Date.now() >= S.endsAt) setPhase(FLOW[S.phase][0]); };
  const allApproved = t => t.members.every(pid => t.approved.has(pid));

  function teamOut(n, forHost) {   // only the host gets everyone's marks and order-change flags
    const t = S.teams[n], scores = forHost && S.phase === 'results';
    const members = t.members.map(pid => { const p = S.players[pid];
      return { name: p.name, done: !!p.list, approved: !!(t.approved && t.approved.has(pid)),
        ...(forHost && { changes: p.changes, undid: p.undid }), ...(scores && { marks: marks(p, t), difference: difference(p, t) }) }; });
    const scored = members.filter(m => m.marks != null);
    return { team: +n, members, order: t.order || null, v: t.v || 0, approvals: t.approved ? t.approved.size : 0, group: t.group || null, lastBy: t.lastBy || null,
      avg: scores && scored.length ? Math.round(scored.reduce((a, m) => a + m.marks, 0) / scored.length * 10) / 10 : null };
  }
  const locked = { error: 'The team order is locked.' };
  const discussTeam = id => { const p = S.players[id], t = p && S.teams[p.team]; return p && S.phase === 'discuss' && t.order && !t.group ? [p, t] : []; };

  // Every call is synchronous here (one process), but async so it matches the Supabase store.
  const store = {
    async state(id) {
      tick();
      const p = S.players[id];
      if (!p) return { error: 'unknown', phase: S.phase, chars: CHARS };
      const t = S.teams[p.team];
      const result = S.phase === 'results' && p.list && t.group ? { diffs: diffs(p.list, t.group), difference: difference(p, t), marks: marks(p, t), max: MAX_MARKS } : null;
      return { phase: S.phase, endsAt: S.endsAt, startedAt: S.startedAt, now: Date.now(), chars: CHARS,
        me: { name: p.name, team: p.team, list: p.list, approved: !!(t.approved && t.approved.has(id)) }, team: teamOut(p.team), result };
    },
    async roster() {
      return { teams: ROSTER ? Object.keys(ROSTER).sort((a, b) => a - b).map(n => ({ team: +n, names: ROSTER[n].map(name => ({ name, taken: taken(n, name) })) })) : null };
    },
    async join(id, name, team) {
      tick();
      if (ROSTER && !ROSTER[team]) return { error: `Team ${team} isn't on the class list.` };
      if (ROSTER) { const listed = ROSTER[team].find(x => sameName(x, name)); if (!listed) return { error: `Pick your name from the Team ${team} list.` }; name = listed; }
      const t = S.teams[team] || (S.teams[team] = { members: [], order: null, v: 0, approved: null, group: null, lastBy: null });
      if (t.members.length >= TEAM_SIZE) return { error: `Team ${team} is full.` };
      if (taken(team, name)) return { error: ROSTER ? `${name} has already joined. If that is not you, ask the host to free your name.` : `Someone in Team ${team} already uses that name. Add an initial.` };
      S.players[id] = { name, team, list: null, changes: 0, undid: 0 };
      t.members.push(id);
      if (S.phase === 'discuss' && !t.order) { t.order = startingOrder(t); t.v = 1; t.approved = new Set(); }
      if (t.approved) t.approved.clear();   // a new member hasn't approved yet
      return { id };
    },
    async rank(id, list) {
      tick();
      const p = S.players[id];
      if (!p || S.phase !== 'r1' || p.list) return { error: 'Not accepted now.' };
      if (!valid(list)) return { error: 'Seat all 10 passengers.' };
      p.list = list.slice(); return { ok: true };
    },
    // Discussion: anyone on the team can rearrange the shared order. Any change clears every approval.
    async order(id, list) {
      tick();
      const [p, t] = discussTeam(id); if (!p) return locked;
      if (!valid(list)) return { error: 'Keep all 10 passengers in the lifeboat.' };
      if (list.join('|') !== t.order.join('|')) {
        p.changes++; if ([...t.approved].some(pid => pid !== id)) p.undid++;   // flagged for the host
        t.order = list.slice(); t.v++; t.approved.clear(); t.lastBy = p.name;
      }
      return { ok: true, v: t.v };
    },
    // Approve the exact version you are looking at. When every member approves, the order locks.
    async approve(id, v, on) {
      tick();
      const [p, t] = discussTeam(id); if (!p) return locked;
      if (v !== t.v) return { error: 'The order just changed. Check it again before approving.' };
      if (on) t.approved.add(id); else t.approved.delete(id);
      if (allApproved(t)) t.group = t.order.slice();
      return { ok: true };
    },
    async hostGet() {
      tick();
      return { phase: S.phase, endsAt: S.endsAt, startedAt: S.startedAt, now: Date.now(), players: Object.keys(S.players).length, maxMarks: MAX_MARKS, roster: ROSTER,
        teams: Object.keys(S.teams).sort((a, b) => a - b).map(n => teamOut(n, true)) };
    },
    async host(action, a) {
      tick();
      if (action === 'next') setPhase(FLOW[S.phase][0]);
      else if (action === 'more') { if (S.endsAt) S.endsAt += 60000; }
      else if (action === 'reset') reset();
      else if (action === 'roster') {
        if (S.phase !== 'lobby') return { error: 'Change the class list in the lobby, before the game starts.' };
        ROSTER = a.roster;
      }
      else if (action === 'kick') {   // frees a seat and a name, e.g. when a student's phone dies and they rejoin on another
        const t = S.teams[a.team], pid = t && t.members.find(x => S.players[x].name === a.name);
        if (!pid) return { error: 'Player not found.' };
        t.members = t.members.filter(x => x !== pid); delete S.players[pid];
        if (t.approved) t.approved.delete(pid);
        if (!t.members.length) delete S.teams[a.team];
        else if (S.phase === 'discuss' && t.order && !t.group && allApproved(t)) t.group = t.order.slice();
      }
      else return { error: 'Unknown action.' };
      return { ok: true };
    },
  };
  return store;
}

module.exports = { TEAM_SIZE, MAX_TEAMS, MAX_MARKS, CHARS, FLOW, cleanName, parseRoster, valid, memoryStore };
