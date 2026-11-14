# Lifeboat: a shipwreck decision game

A classroom game for LEAD College (Autonomous). The MV Aurora Star sinks, and a lifeboat can rescue one person at a time. Students rank 10 passengers on their own, then each team rearranges one shared lifeboat together until every member approves the same order. Each student gets marks out of 90: 90 − the sum of |their seat − team seat| over all 10 passengers.

Built for about 100 students at once (up to 20 teams of 10) on a shared Wi‑Fi network.

## Run it

Needs Node.js 18 or newer. No packages to install.

```
node server.js
```

The terminal prints the student address, the host address and a host key.

- **Students** open the printed `http://<this-pc-ip>:3000` on the same Wi‑Fi, enter a name and pick a team.
- **Host** opens `http://localhost:3000/host` and enters the host key.

The host key is random on every start. To set your own: `HOST_KEY=yourkey node server.js`. To change the port: `PORT=8080 node server.js`. If you run it behind a reverse proxy, also set `TRUST_PROXY=1`.

## Host it online (Vercel + Supabase)

The page and API run on Vercel; the game is stored in Supabase, so it works however many copies of the API Vercel starts.

**1. Supabase (database), once**
1. Open your project at [supabase.com/dashboard](https://supabase.com/dashboard). Mumbai (`ap-south-1`) is the closest region for India.
2. **SQL Editor → New query**, paste all of `supabase/schema.sql`, click **Run**. It should say "Success. No rows returned".
3. **Project Settings → API Keys**: copy the **secret** key (`sb_secret_…`; on older projects, the `service_role` key). Keep it private: never put it in the page or in GitHub.

**2. Vercel (website)**
1. At [vercel.com/new](https://vercel.com/new), import this GitHub repo. Leave the framework as **Other** and the build settings empty.
2. Before clicking **Deploy**, add three **Environment Variables**:
   - `SUPABASE_URL`: `https://<project-ref>.supabase.co`
   - `SUPABASE_SECRET_KEY`: the secret key from step 1.3
   - `HOST_KEY`: your host password (use 8+ characters)
3. Deploy. Students open `https://<your-project>.vercel.app`; the host opens `/host`.

If the page says "Setup needed", a variable is missing: add it under **Settings → Environment Variables**, then **Deployments → Redeploy**.

Redeploying doesn't touch a game in progress, because the game lives in Supabase. Free plans: one class game (100 students, ~20 minutes) is about 85,000 requests, so Vercel's free 1 million requests a month covers roughly 10 games. A Supabase free project pauses after a week with no use; open the dashboard and click **Restore** if it does.

## Class list (optional)

In the lobby, the host can upload a CSV or type the groups into the **Class list** card. Students then tap their team and choose their name from a dropdown; names already taken show as "joined". Either format works:

```
Team,Name          Team 1
1,Asha             Asha
1,Ben              Ben
2,Chitra           Team 2
                   Chitra
```

From Excel, use **Save As → CSV**. Each team can have up to 10 names. If a student's phone dies, the host taps **×** next to their name to free it, and they can join again on another phone. Leave the list empty to let students type their own names.

## Game flow

| Phase | Time | What happens |
| --- | --- | --- |
| Lobby | until host starts | Students join a team |
| Story | 14 s | Shipwreck animation |
| Solo | 3 min | Each student ranks the passengers alone |
| Discuss | 15 min | The team shares one lifeboat and anyone can rearrange it. Any change clears approvals and shows teammates "Name changed the team order". The order locks when every member approves. If time runs out, the current shared order is used. The host sees ⚑ next to anyone who changed the order. |
| Results | | Each student sees only their own marks out of 90. The host sees every student's marks, order changes and team averages, and can download a CSV. |

Timed phases advance on their own. The host can skip ahead, add a minute, or reset.

## Files

- `public/index.html`: student, host and demo pages
- `lib/handler.js`: web server: page, API routes, security checks, rate limits
- `lib/game.js`: game rules, class-list parsing, and the in-memory game store
- `lib/supabase.js` + `supabase/schema.sql`: the Supabase game store (each action is one database function)
- `server.js`: run it on your own computer (in memory; set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to use Supabase instead)
- `api/game.js` + `vercel.json`: the Vercel deployment

With `node server.js` and no Supabase settings, the game is kept in memory, so restarting clears it.
