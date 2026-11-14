// Supabase store: every game action is one Postgres function (see supabase/schema.sql), so it runs as a single
// transaction. 100 students acting at once can't overwrite each other, however many Vercel copies are running.
'use strict';

// rpc(fn, args) -> the function's JSON result. Throws on network or database errors.
function supabaseRpc(url, key) {
  const base = url.replace(/\/+$/, '') + '/rest/v1/rpc/';
  // New-style secret keys (sb_secret_…) go in "apikey" only; legacy service_role keys are JWTs and also go in Authorization.
  const headers = { 'Content-Type': 'application/json', apikey: key, ...(key.startsWith('eyJ') && { Authorization: 'Bearer ' + key }) };
  return async (fn, args) => {
    const r = await fetch(base + fn, { method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
}

function rpcStore(rpc) {
  return {
    state: id => rpc('lb_state', { p_id: id }),
    roster: () => rpc('lb_roster', {}),
    join: (id, name, team) => rpc('lb_join', { p_id: id, p_name: name, p_team: team }),
    rank: (id, list) => rpc('lb_rank', { p_id: id, p_list: list ?? null }),
    order: (id, list) => rpc('lb_order', { p_id: id, p_list: list ?? null }),
    approve: (id, v, on) => rpc('lb_approve', { p_id: id, p_v: v, p_on: on }),
    hostGet: () => rpc('lb_host_get', {}),
    host: (action, a) => rpc('lb_host', { p_action: action, p_roster: a.roster ?? null, p_team: a.team ?? null, p_name: a.name ?? null }),
  };
}

const supabaseStore = (url, key) => rpcStore(supabaseRpc(url, key));
module.exports = { supabaseStore, rpcStore };
