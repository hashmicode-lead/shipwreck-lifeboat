# Lifeboat: a shipwreck decision game

A classroom game for LEAD College of Management. The MV Aurora Star sinks, and a lifeboat can rescue one person at a time. Students rank 10 passengers on their own, discuss as a team, then the team captain enters the team's agreed order. Each student's score is the sum of |their seat − team seat| over all 10 passengers (0 = perfect match, 50 = opposite order).

Built for about 100 students at once (up to 20 teams of 10) on a shared Wi‑Fi network.

## Run it

Needs Node.js 18 or newer. No packages to install.

```
node server.js
```

The terminal prints the student address, the host address and a host key.

- **Students** open the printed `http://<this-pc-ip>:3000` on the same Wi‑Fi, enter a name and pick a team.
- **Host** opens `http://localhost:3000/host` and enters the host key.

The host key is random on every start. To set your own: `HOST_KEY=yourkey node server.js`. To change the port: `PORT=8080 node server.js`.

## Game flow

| Phase | Time | What happens |
| --- | --- | --- |
| Lobby | until host starts | Students join a team |
| Captain | 60 s | Each team votes for its captain (most votes wins; a tie goes to whoever joined first) |
| Story | 14 s | Shipwreck animation |
| Solo | 3 min | Each student ranks the passengers alone |
| Discuss | 5 min | Teams agree on one order |
| Decide | 3 min | The captain enters the team's order |
| Results | | Scores, passenger-by-passenger differences, team averages for the host |

Timed phases advance on their own. The host can skip ahead, add a minute, or reset.

## Files

- `server.js`: game server and scoring (Node's built-in modules only)
- `public/index.html`: student and host pages

Game state is kept in memory, so restarting the server clears it. Traffic is plain HTTP on the local network.
