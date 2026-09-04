# PartyUp Float authoritative server

Local Phase 10 proof: one Colyseus `float_room` runs one authoritative two-player Float match. The server uses `@partyup/balloon-core`; clients send actions and render Colyseus schema state.

## Run locally

Requirements: Node.js 22+ and the sibling core repository at `../partyup-balloon-core`.

```powershell
cmd /c npm install
cmd /c npm start
```

Open <http://localhost:2567> in two browser tabs. Each tab joins the same available `float_room` as Player A or B. Press **Ready** in both tabs to start. The server runs on port 2567; the Playground remains at `/playground` and the monitor at `/monitor`.

## Network contract

Clients send `room.send("action", payload)`. Supported payloads are:

```ts
{ type: "READY" }
{ type: "SEND_BALLOON", balloonType: "basic" | "speed" | "heavy", lane: 1 | 2 | 3 | 4 }
{ type: "MANUAL_POP", balloonId: string }
{ type: "PLACE_WALL", orientation: "vertical" | "horizontal", gridX: number, gridY: number }
{ type: "REMOVE_WALL" | "PLACE_NAILS" | "REMOVE_NAILS" | "PLACE_GLUE" | "REMOVE_GLUE" | "REPAIR_WALL", wallSegmentId: string }
```

The server derives the actor and target from the client's assigned seat. Client-provided actor IDs, target IDs, timestamps, costs, or damage values are ignored. Every accepted or rejected request produces an `action_result` message.

## Authority and timing

- Lifecycle: `WAITING → READY → ACTIVE → COMPLETE`.
- Exactly two seats are available, assigned A then B.
- Discrete actions are queued and applied at the next authoritative tick.
- `setFixedTimestep(..., 60)` drives the canonical core at 60 Hz.
- The core owns economy ticks, launch queues, paths, balloon movement, PvE waves, collisions, walls, attachments, structural damage, repair, health, and final result.
- Colyseus delta-syncs a compact rendering schema containing lifecycle, clock, round/wave state, player readiness/connectivity, economy, room health, unlocks, queues, walls, nails, glue, balloons, and winner.
- Dropped clients retain their seat for a 30-second reconnection window. A disconnect does not stop or crash an active match.

No Supabase integration, matchmaking changes, persistence, deployment configuration, prediction, spectators, or production infrastructure are included.

## Verify

```powershell
cmd /c npm test
cmd /c npm run build
cmd /c npx tsc --noEmit
```

The integration suite boots the real Colyseus server and verifies slots/readiness, the two-client cap, server clock, core-owned PvE/economy/launches, identity spoof resistance, room ownership, building, nails, glue, repairs, fixed one-damage manual pops, and same-tick draw resolution.
