// HTTP layer shared by `node server.js` and the Vercel function: page, API routes, input checks,
// rate limits, host key and security headers. The game itself lives in a store (memory or Supabase).
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { MAX_TEAMS, cleanName, parseRoster } = require('./game');

const ID_RE = /^[0-9a-f]{32}$/;
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()' };
const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const hashKey = s => crypto.createHash('sha256').update(String(s)).digest();

/* Rate limits. Normal polling uses about 40 requests a minute per student.
   Limits are per player, because a whole class can share one IP (college NAT or a hosting proxy).
   On Vercel each running copy keeps its own counters, so treat these as a brake, not a guarantee. */
const PER_PLAYER = 240, PER_IP = 15000, JOINS_PER_IP = 200;

function createHandler(store, { hostKey, trustProxy = false } = {}) {
  const HOST_HASH = hostKey ? hashKey(hostKey.toUpperCase()) : null;
  const hits = new Map();
  function bucket(k) {
    const now = Date.now(); let b = hits.get(k);
    if (!b || now - b.t > 60000) { b = { t: now, n: 0, fails: b ? b.fails : 0, failT: b ? b.failT : 0 }; hits.set(k, b); }
    if (now - b.failT > 10 * 60000) b.fails = 0;
    return b;
  }
  setInterval(() => { const now = Date.now(); for (const [k, b] of hits) if (now - b.t > 10 * 60000) hits.delete(k); }, 60000).unref();
  // Host key: compared in constant time; 8 wrong tries locks that device out of the host page for 10 minutes.
  function hostOK(req, ip) {
    if (!HOST_HASH) return 'unset';
    const b = bucket(ip);
    if (b.fails >= 8) return 'locked';
    const k = req.headers['x-host-key'];
    const ok = typeof k === 'string' && k.length <= 64 && crypto.timingSafeEqual(hashKey(k.trim().toUpperCase()), HOST_HASH);
    if (!ok) { b.fails++; b.failT = Date.now(); }
    return ok;
  }
  const hostDenied = r => ({ error: r === 'unset' ? 'No host key is set on the server (HOST_KEY).' : r === 'locked' ? 'Too many wrong keys. Try again in 10 minutes.' : 'Wrong host key.' });
  const idOf = x => typeof x === 'string' && ID_RE.test(x) ? x : '';

  const routes = {
    'GET state': ({ q }) => { const id = idOf(q.get('id')); return id ? store.state(id) : store.state(''); },
    // Join screen: the class list with names already taken, or null when students type their own name.
    'GET roster': () => store.roster(),
    'POST join': ({ b, ip }) => {
      if (++bucket('j:' + ip).n > JOINS_PER_IP) return { error: 'Too many attempts. Wait a minute and try again.' };
      const name = cleanName(b.name), team = Number(b.team);
      if (!name) return { error: 'Enter your name.' };
      if (!Number.isInteger(team) || team < 1 || team > MAX_TEAMS) return { error: `Pick a team from 1 to ${MAX_TEAMS}.` };
      return store.join(crypto.randomBytes(16).toString('hex'), name, team);
    },
    'POST rank': ({ b }) => idOf(b.id) ? store.rank(b.id, b.list) : { error: 'Not accepted now.' },
    'POST order': ({ b }) => idOf(b.id) ? store.order(b.id, b.list) : { error: 'The team order is locked.' },
    'POST approve': ({ b }) => idOf(b.id) ? store.approve(b.id, Number.isInteger(b.v) ? b.v : -1, b.on !== false) : { error: 'The team order is locked.' },
    'GET host': ({ req, ip }) => { const ok = hostOK(req, ip); return ok === true ? store.hostGet() : hostDenied(ok); },
    'POST host': ({ b, req, ip }) => {
      const ok = hostOK(req, ip); if (ok !== true) return hostDenied(ok);
      if (b.action === 'roster') {
        if (!String(b.text || '').trim()) return store.host('roster', { roster: null });
        const r = parseRoster(b.text); if (r.errors) return { error: r.errors.join('\n') };
        return store.host('roster', { roster: r.roster });
      }
      if (b.action === 'kick') return store.host('kick', { team: Number(b.team) || 0, name: String(b.name || '').slice(0, 40) });
      if (['next', 'more', 'reset'].includes(b.action)) return store.host(b.action, {});
      return { error: 'Unknown action.' };
    },
  };

  const send = (res, code, obj) => { res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const readBody = (req, max) => new Promise(resolve => {
    if (Number(req.headers['content-length']) > max) return resolve(null);
    // Vercel has already read and parsed the body; plain Node hands us the stream.
    if (req.body !== undefined) { const o = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : req.body;
      return resolve(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); }
    let d = '', done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
    req.setEncoding('utf8');
    req.on('data', c => { d += c; if (d.length > max) { finish(null); req.destroy(); } });
    req.on('end', () => { try { const o = JSON.parse(d || '{}'); finish(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); } catch { finish({}); } });
    req.on('error', () => finish(null)); req.on('close', () => finish(null));
  });

  return async function handle(req, res) {
    const fwd = trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || (req.socket && req.socket.remoteAddress) || '?';
    let u; try { u = new URL(req.url, 'http://local'); } catch { res.writeHead(400, BASE_HEADERS); return res.end(); }
    // Vercel rewrites /api/state to /api/game?r=state; plain Node sees the original path.
    const r = u.searchParams.get('r'), p = u.pathname;
    const name = r || (p.startsWith('/api/') ? p.slice(5) : (p === '/' || p === '/host' || p === '/demo') ? 'page' : '');

    if (name === 'page' && req.method === 'GET') {
      let html; try { html = fs.readFileSync(PAGE, 'utf8'); } catch { res.writeHead(500, BASE_HEADERS); return res.end('Page missing'); }
      // Only this page's own script may run (per-request nonce); no framing, no outside connections.
      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      return res.end(html.replace('<script>', `<script nonce="${nonce}">`));
    }
    const route = routes[req.method + ' ' + name];
    if (!route) { res.writeHead(req.method === 'GET' ? 404 : 405, { ...BASE_HEADERS, 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    if (++bucket(ip).n > PER_IP) return send(res, 429, { error: 'Too many requests. Slow down.' });
    let body = {};
    if (req.method === 'POST') {
      // Cross-site protection: JSON only, and only from this same site
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only.' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return send(res, 403, { error: 'Cross-site request blocked.' });
      body = await readBody(req, name === 'host' ? 65536 : 8192);
      if (body === null) return send(res, 413, { error: 'Request too large.' });
    }
    const pid = idOf(u.searchParams.get('id') || body.id);
    if (pid && ++bucket('p:' + pid).n > PER_PLAYER) return send(res, 429, { error: 'Too many requests. Slow down.' });
    try { return send(res, 200, await route({ q: u.searchParams, b: body, req, ip })); }
    catch (e) { console.error('store error:', e.message); return send(res, 503, { error: 'offline' }); }   // the page retries on its own
  };
}

module.exports = { createHandler };
