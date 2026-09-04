import assert from "node:assert/strict";
import { BASIC_BALLOON_COST, STARTING_COINS, createBalloon, createBalloonRoom, createWaveState } from "@partyup/balloon-core";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import type { Room as ClientRoom } from "@colyseus/sdk";

import appConfig from "../src/app.config.js";
import { advanceFloatMatchSimulation, FLOAT_TICK_RATE, type FloatMatchState, type FloatRoom } from "../src/rooms/FloatRoom.js";
import type { FloatRoomState } from "../src/rooms/schema/FloatRoomState.js";

describe("authoritative FloatRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await boot(appConfig); });
  after(async () => { await colyseus.shutdown(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  async function activeMatch() {
    const room = await colyseus.createRoom<FloatRoomState>("float_room", {}) as FloatRoom;
    const clientA = await colyseus.connectTo(room);
    const clientB = await colyseus.connectTo(room);
    assert.equal(room.state.players.get("A")?.sessionId, clientA.sessionId);
    assert.equal(room.state.players.get("B")?.sessionId, clientB.sessionId);
    assert.equal(room.state.status, "READY");

    await sendAndReceive(room, clientA, { type: "READY" });
    await sendAndReceive(room, clientB, { type: "READY" });
    assert.equal(room.state.status, "ACTIVE");
    assert.ok(room.state.matchId.startsWith("float:"));
    return { room, clientA, clientB };
  }

  it("assigns exactly A and B, then starts only when both are ready", async () => {
    const room = await colyseus.createRoom<FloatRoomState>("float_room", {}) as FloatRoom;
    const clientA = await colyseus.connectTo(room);
    assert.equal(room.state.status, "WAITING");
    await sendAndReceive(room, clientA, { type: "READY" });
    assert.equal(room.state.status, "WAITING");

    const clientB = await colyseus.connectTo(room);
    assert.equal(room.state.status, "READY");
    await sendAndReceive(room, clientB, { type: "READY" });
    assert.equal(room.state.status, "ACTIVE");
    await assert.rejects(() => colyseus.connectTo(room));
  });

  it("owns the clock, PvE schedule, economy, and launch simulation", async () => {
    const { room, clientA, clientB } = await activeMatch();
    const canonical = coreMatch(room);
    const startingTime = canonical.simulationTimeMs;
    const wave = canonical.waveState;
    wave.status = "active";
    wave.transitionEndsAt = null;
    wave.nextSpawnAt = startingTime;
    wave.spawnedCount = 0;

    const actionResult = clientA.waitForMessage("action_result");
    const received = room.waitForNextMessage();
    clientA.send("action", { type: "SEND_BALLOON", balloonType: "basic", lane: 3, actorPlayerId: "B", sentAt: -999 });
    await received;
    await room.waitForNextTimestep();
    assert.equal((await actionResult).applied, true);

    assert.ok(canonical.simulationTimeMs > startingTime);
    assert.equal(room.state.simulationTimeMs, canonical.simulationTimeMs);
    assert.equal(canonical.players.A.room.economy.coins, STARTING_COINS - BASIC_BALLOON_COST);
    assert.equal(canonical.players.B.room.economy.coins, STARTING_COINS);
    assert.ok(canonical.players.B.room.balloons.some((balloon) => balloon.source === "player" && balloon.senderId === "A" && balloon.spawnLane === 3));
    assert.ok(canonical.players.A.room.balloons.some((balloon) => balloon.source === "wave"));
    assert.ok(canonical.players.B.room.balloons.some((balloon) => balloon.source === "wave"));
    assert.equal(room.state.players.get("B")?.room.balloons.size, canonical.players.B.room.balloons.length);

    await Promise.all([clientA.waitForNextPatch(), clientB.waitForNextPatch()]);
    const viewA = clientA.state as unknown as FloatRoomState;
    const viewB = clientB.state as unknown as FloatRoomState;
    assert.equal(viewA.simulationTimeMs, viewB.simulationTimeMs);
    assert.equal(viewA.players.get("A")?.room.coins, viewB.players.get("A")?.room.coins);
    assert.equal(viewA.players.get("B")?.room.balloons.size, viewB.players.get("B")?.room.balloons.size);
  });

  it("advances canonical milliseconds and room simulation seconds at 60 Hz", () => {
    const roomA = createBalloonRoom("timestep:A");
    const roomB = createBalloonRoom("timestep:B");
    const balloon = createBalloon(roomA.id, "timestep-balloon", "basic", 1, "left", "wave", { roundId: 1, waveSequence: 1 });
    balloon.currentCell = { column: 0, row: 0 };
    balloon.targetCell = null;
    balloon.y = 0.5;
    roomA.balloons.push(balloon);

    const match: FloatMatchState = {
      matchId: "timestep",
      players: {
        A: { room: roomA, senderSequence: 0 },
        B: { room: roomB, senderSequence: 0 },
      },
      simulationTimeMs: 0,
      waveState: createWaveState(1),
      status: "active",
      result: null,
    };
    const deltaSeconds = 1 / FLOAT_TICK_RATE;
    const deltaMs = 1000 / FLOAT_TICK_RATE;

    for (let tick = 1; tick <= FLOAT_TICK_RATE; tick += 1) {
      advanceFloatMatchSimulation(match, { dt: deltaSeconds, dtMs: deltaMs });
    }

    assert.ok(Math.abs(match.simulationTimeMs - 1000) < 0.000001);
    assert.ok(Math.abs(balloon.y - (0.5 - balloon.speed)) < 0.000001);
  });

  it("enforces room ownership for build, attachments, repair, and manual pops", async () => {
    const { room, clientA, clientB } = await activeMatch();
    const canonical = coreMatch(room);

    const placed = await queuedAction(room, clientA, { type: "PLACE_WALL", orientation: "vertical", gridX: 1, gridY: 5 });
    assert.equal(placed.applied, true);
    const wall = canonical.players.A.room.walls[0]!;
    assert.equal(room.state.players.get("A")?.room.walls.has(wall.id), true);
    assert.equal(room.state.players.get("B")?.room.walls.size, 0);

    assert.equal((await queuedAction(room, clientA, { type: "PLACE_NAILS", wallSegmentId: wall.id })).applied, true);
    assert.equal((await queuedAction(room, clientA, { type: "PLACE_GLUE", wallSegmentId: wall.id })).applied, true);
    assert.equal(room.state.players.get("A")?.room.nails.size, 1);
    assert.equal(room.state.players.get("A")?.room.glue.size, 1);

    const crossRepair = await queuedAction(room, clientB, { type: "REPAIR_WALL", wallSegmentId: wall.id });
    assert.equal(crossRepair.applied, false);
    assert.equal(crossRepair.code, "not_owner");
    wall.integrity = 5;
    assert.equal((await queuedAction(room, clientA, { type: "REPAIR_WALL", wallSegmentId: wall.id })).applied, true);
    assert.equal(room.state.players.get("A")?.room.walls.get(wall.id)?.integrity, 10);

    const balloon = createBalloon(canonical.players.A.room.id, "manual-pop-test", "basic", 1, "left", "wave", { roundId: 1, waveSequence: 99 });
    balloon.speed = 0;
    canonical.players.A.room.balloons.push(balloon);
    const illegalPop = await queuedAction(room, clientB, { type: "MANUAL_POP", balloonId: balloon.id, damage: 999 });
    assert.equal(illegalPop.applied, false);
    assert.equal(illegalPop.code, "not_owner");
    const legalPop = await queuedAction(room, clientA, { type: "MANUAL_POP", balloonId: balloon.id, damage: 999 });
    assert.equal(legalPop.applied, true);
    assert.equal(balloon.health, balloon.maxHealth - 1);
  });

  it("decides a same-tick double knockout as a server-side draw", async () => {
    const { room } = await activeMatch();
    const canonical = coreMatch(room);
    canonical.players.A.room.health = 0;
    canonical.players.B.room.health = 0;
    await room.waitForNextTimestep();
    assert.equal(room.state.status, "COMPLETE");
    assert.equal(room.state.resultType, "draw");
    assert.equal(room.state.winnerPlayerId, "");
  });
});

async function sendAndReceive(room: FloatRoom, client: ClientRoom, action: object) {
  const result = client.waitForMessage("action_result");
  const received = room.waitForNextMessage();
  client.send("action", action);
  await received;
  return result;
}

async function queuedAction(room: FloatRoom, client: ClientRoom, action: object) {
  const result = client.waitForMessage("action_result");
  const received = room.waitForNextMessage();
  client.send("action", action);
  await received;
  await room.waitForNextTimestep();
  return result;
}

function coreMatch(room: FloatRoom) {
  return (room as unknown as { match: FloatMatchState }).match;
}
