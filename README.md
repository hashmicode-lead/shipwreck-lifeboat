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

The host key is random on every start. To set your own: `HOST_KEY=yourkey node server.js`. To change the port: `PORT=8080 node server.js`. If you host it behind a reverse proxy (an online host such as Render or Railway), also set `TRUST_PROXY=1`.

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

- `server.js`: game server and scoring (Node's built-in modules only)
- `public/index.html`: student and host pages

Game state is kept in memory, so restarting the server clears it. Traffic is plain HTTP on the local network.
