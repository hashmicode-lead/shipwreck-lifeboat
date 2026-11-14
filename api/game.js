// Vercel function: serves the page and every /api route (vercel.json rewrites them here).
// The game lives in Supabase, so any number of copies of this function can run at once.
'use strict';
const { createHandler } = require('../lib/handler');
const { supabaseStore } = require('../lib/supabase');

const { SUPABASE_URL, SUPABASE_SECRET_KEY, HOST_KEY } = process.env;
const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'HOST_KEY'].filter(k => !process.env[k]);

module.exports = missing.length
  ? (req, res) => { res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Setup needed: add ${missing.join(', ')} in Vercel → Project → Settings → Environment Variables, then redeploy.`); }
  : createHandler(supabaseStore(SUPABASE_URL, SUPABASE_SECRET_KEY), { hostKey: HOST_KEY, trustProxy: true });   // Vercel sets X-Forwarded-For
