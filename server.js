// Lifeboat on your own computer: `node server.js`, then open the address it prints.
// Keeps the game in memory (LAN play, no internet needed). Set SUPABASE_URL + SUPABASE_SECRET_KEY to use the Supabase database instead.
'use strict';
const http = require('http'), os = require('os'), crypto = require('crypto');
const { createHandler } = require('./lib/handler');
const { memoryStore } = require('./lib/game');
const { supabaseStore } = require('./lib/supabase');

const PORT = Number(process.env.PORT) || 3000;
// The host key is random on every start unless you set HOST_KEY yourself. It is printed in this terminal only.
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString('hex').toUpperCase();
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
const store = SUPABASE_URL && SUPABASE_SECRET_KEY ? supabaseStore(SUPABASE_URL, SUPABASE_SECRET_KEY) : memoryStore();

http.createServer(createHandler(store, { hostKey: HOST_KEY, trustProxy: !!process.env.TRUST_PROXY })).listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Lifeboat running (${SUPABASE_URL && SUPABASE_SECRET_KEY ? 'Supabase database' : 'in memory'}).\n  Students: ${ips.map(ip => `http://${ip}:${PORT}`).join('  ') || `http://localhost:${PORT}`}\n  Host:     http://localhost:${PORT}/host\n  Host key: ${HOST_KEY}   (keep it private; it changes on every restart unless you set HOST_KEY)`);
});
