import {
  applyGameAction,
  applyIncomeTicks,
  applyLaunchQueue,
  createBalloonRoom,
  createSendBalloonAction,
  createWaveState,
  createWallSegment,
  updateRoomSimulation,
  updateWaveState,
  type Balloon,
  type BalloonRoom,
  type BalloonType,
  type GameAction,
  type WaveState,
  type GameActionResult,
  type GlueTrap,
  type NailStrip,
  type QueuedBalloon,
  type SpawnLane,
  type WallOrientation,
  type WallSegment,
} from "@partyup/balloon-core";
import { Client, CloseCode, Room, type StepContext } from "colyseus";
import {
  FloatBalloonState,
  FloatGlueState,
  FloatNailState,
  FloatPlayerRoomState,
  FloatPlayerState,
  FloatQueuedBalloonState,
  FloatRoomState,
  FloatWallState,
  type FloatSlot,
} from "./schema/FloatRoomState.js";

export const FLOAT_TICK_RATE = 60;
const MAX_PENDING_ACTIONS = 128;

type ClientAction = {
  type?: unknown;
  balloonType?: unknown;
  lane?: unknown;
  balloonId?: unknown;
  wallSegmentId?: unknown;
  orientation?: unknown;
  gridX?: unknown;
  gridY?: unknown;
};

type PendingAction = {
  client: Client;
  slot: FloatSlot;
  action: ServerAction;
};

type ServerAction = { actorPlayerId: FloatSlot; action: GameAction };
export type FloatMatchState = {
  matchId: string;
  players: Record<FloatSlot, { room: BalloonRoom; senderSequence: number }>;
  simulationTimeMs: number;
  waveState: WaveState;
  status: "active" | "complete";
  result: { type: "win" | "draw"; winnerPlayerId: FloatSlot | "" } | null;
};

export class FloatRoom extends Room<{ state: FloatRoomState }> {
  maxClients = 2;
  state = new FloatRoomState({
    status: "WAITING",
    matchId: "",
    simulationTimeMs: 0,
    serverTick: 0,
    round: 0,
    waveStatus: "waiting",
    waveSpawnedCount: 0,
    resultType: "",
    winnerPlayerId: "",
  });

  private match: FloatMatchState | null = null;
  private readonly slotsBySession = new Map<string, FloatSlot>();
  private readonly pendingActions: PendingAction[] = [];

  messages = {
    action: (client: Client, payload: unknown) => this.receiveAction(client, payload),
  };

  onCreate() {
    this.setFixedTimestep((ctx) => this.step(ctx), FLOAT_TICK_RATE);
  }

  onJoin(client: Client) {
    const slot = this.firstAvailableSlot();
    if (!slot) {
      client.leave(CloseCode.CONSENTED, "FloatRoom supports exactly two active players");
      return;
    }

    this.slotsBySession.set(client.sessionId, slot);
    this.state.players.set(slot, new FloatPlayerState({
      slot,
      sessionId: client.sessionId,
      connected: true,
      ready: false,
      room: emptyRoomState(),
    }));
    this.state.status = this.state.players.size === 2 ? "READY" : "WAITING";
  }

  onDrop(client: Client) {
    const player = this.playerFor(client);
    if (player) player.connected = false;
    this.allowReconnection(client, 30).catch(() => {});
  }

  onReconnect(client: Client) {
    const player = this.playerFor(client);
    if (player) player.connected = true;
  }

  onLeave(client: Client, _code: CloseCode) {
    const slot = this.slotsBySession.get(client.sessionId);
    if (!slot) return;

    const player = this.state.players.get(slot);
    if (player) player.connected = false;
    if (!this.match) {
      this.state.players.delete(slot);
      this.slotsBySession.delete(client.sessionId);
      this.state.status = this.state.players.size === 2 ? "READY" : "WAITING";
    }
  }

  private receiveAction(client: Client, payload: unknown) {
    const slot = this.slotsBySession.get(client.sessionId);
    if (!slot) return this.reject(client, "UNKNOWN", "not_seated", "Client has no active player seat");
    if (!isRecord(payload) || typeof payload.type !== "string") {
      return this.reject(client, "UNKNOWN", "invalid_action", "Action payload requires a type");
    }
    if (payload.type === "READY") return this.ready(client, slot);
    if (!this.match || this.state.status !== "ACTIVE") {
      return this.reject(client, payload.type, "match_not_active", "Match is not active");
    }
    if (this.pendingActions.length >= MAX_PENDING_ACTIONS) {
      return this.reject(client, payload.type, "rate_limited", "Server action queue is full");
    }

    const action = this.toCoreAction(slot, payload as ClientAction);
    if ("error" in action) return this.reject(client, payload.type, "invalid_payload", action.error);
    this.pendingActions.push({ client, slot, action: action.value });
  }

  private ready(client: Client, slot: FloatSlot) {
    if (this.match || this.state.status === "COMPLETE") {
      return this.reject(client, "READY", "already_started", "Match has already started");
    }
    const player = this.state.players.get(slot);
    if (!player) return;
    player.ready = true;
    client.send("action_result", { action: "READY", applied: true, code: "valid", message: "Player ready" });

    if (this.state.players.size !== 2 || ![...this.state.players.values()].every((candidate) => candidate.ready)) return;
    const matchId = `float:${this.roomId}`;
    this.match = {
      matchId,
      players: {
        A: { room: createBalloonRoom(`${matchId}:A`), senderSequence: 0 },
        B: { room: createBalloonRoom(`${matchId}:B`), senderSequence: 0 },
      },
      simulationTimeMs: 0,
      waveState: createWaveState(hashSeed(matchId)),
      status: "active",
      result: null,
    };
    this.state.status = "ACTIVE";
    this.state.matchId = matchId;
    this.syncState();
    this.lock();
  }

  private step(ctx: StepContext) {
    if (!this.match || this.state.status !== "ACTIVE") return;

    for (const pending of this.pendingActions.splice(0)) {
      const sender = this.match.players[pending.slot];
      const target = this.match.players[pending.slot === "A" ? "B" : "A"];
      const result = this.isOwnedByAnotherPlayer(pending)
        ? { action: pending.action.action.type, applied: false, code: "not_owner", message: "That item belongs to the other player" }
        : applyGameAction(sender.room, pending.action.action, target.room);
      pending.client.send("action_result", result);
    }
    advanceFloatMatchSimulation(this.match, ctx);
    this.completeMatchIfNeeded();
    this.state.serverTick = ctx.tick;
    this.syncState();
  }

  private toCoreAction(slot: FloatSlot, payload: ClientAction): { value: ServerAction } | { error: string } {
    const actorPlayerId = slot;
    switch (payload.type) {
      case "SEND_BALLOON": {
        if (!isBalloonType(payload.balloonType) || !isLane(payload.lane)) return { error: "SEND_BALLOON requires a valid balloonType and lane 1-4" };
        const targetPlayerId: FloatSlot = slot === "A" ? "B" : "A";
        const sender = this.match!.players[slot];
        sender.senderSequence += 1;
        return { value: { actorPlayerId, action: createSendBalloonAction({ balloonType: payload.balloonType, lane: payload.lane, targetRoomId: this.match!.players[targetPlayerId].room.id, matchId: this.match!.matchId, senderId: slot, senderSequence: sender.senderSequence, sentAt: this.match!.simulationTimeMs }) } };
      }
      case "MANUAL_POP":
        return typeof payload.balloonId === "string" && payload.balloonId
          ? { value: { actorPlayerId, action: { type: "POP_BALLOON", balloonId: payload.balloonId } } }
          : { error: "MANUAL_POP requires balloonId" };
      case "PLACE_WALL": {
        if (!isOrientation(payload.orientation) || !isInteger(payload.gridX) || !isInteger(payload.gridY)) return { error: "PLACE_WALL requires orientation, gridX, and gridY" };
        const roomId = this.match!.players[slot]!.room.id;
        return { value: { actorPlayerId, action: { type: "PLACE_WALL", wall: createWallSegment(roomId, payload.orientation, payload.gridX, payload.gridY) } } };
      }
      case "REMOVE_WALL":
      case "PLACE_NAILS":
      case "REMOVE_NAILS":
      case "PLACE_GLUE":
      case "REMOVE_GLUE":
      case "REPAIR_WALL":
        return typeof payload.wallSegmentId === "string" && payload.wallSegmentId
          ? { value: { actorPlayerId, action: { type: payload.type, wallSegmentId: payload.wallSegmentId } as GameAction } }
          : { error: `${payload.type} requires wallSegmentId` };
      default:
        return { error: `Unsupported action: ${String(payload.type)}` };
    }
  }

  private syncState() {
    if (!this.match) return;
    this.state.simulationTimeMs = this.match.simulationTimeMs;
    this.state.round = this.match.waveState.roundIndex + 1;
    this.state.waveStatus = this.match.waveState.status;
    this.state.waveSpawnedCount = this.match.waveState.spawnedCount;
    for (const slot of ["A", "B"] as const) {
      const player = this.state.players.get(slot);
      if (player) syncRoom(player.room, this.match.players[slot]!.room);
    }
    if (this.match.status === "complete") {
      this.state.status = "COMPLETE";
      this.state.resultType = this.match.result?.type ?? "";
      this.state.winnerPlayerId = this.match.result?.winnerPlayerId ?? "";
      this.pendingActions.length = 0;
    }
  }

  private completeMatchIfNeeded() {
    if (!this.match || this.match.status === "complete") return;
    const health = [this.match.players.A.room.health, this.match.players.B.room.health];
    if (health[0] > 0 && health[1] > 0) return;
    this.match.status = "complete";
    this.match.result = health[0] <= 0 && health[1] <= 0
      ? { type: "draw", winnerPlayerId: "" }
      : { type: "win", winnerPlayerId: health[0] > 0 ? "A" : "B" };
  }

  private isOwnedByAnotherPlayer(pending: PendingAction) {
    if (!this.match) return false;
    const otherRoom = this.match.players[pending.slot === "A" ? "B" : "A"].room;
    const action = pending.action.action;
    if (action.type === "POP_BALLOON") return otherRoom.balloons.some((balloon) => balloon.id === action.balloonId);
    if ("wallSegmentId" in action) return otherRoom.walls.some((wall) => wall.id === action.wallSegmentId);
    return false;
  }

  private playerFor(client: Client) {
    const slot = this.slotsBySession.get(client.sessionId);
    return slot ? this.state.players.get(slot) : undefined;
  }

  private firstAvailableSlot(): FloatSlot | null {
    if (!this.state.players.has("A")) return "A";
    if (!this.state.players.has("B")) return "B";
    return null;
  }

  private reject(client: Client, action: string, code: string, message: string) {
    client.send("action_result", { action, applied: false, code, message });
  }
}

export function advanceFloatMatchSimulation(
  match: FloatMatchState,
  { dt: deltaSeconds, dtMs: deltaMs }: Pick<StepContext, "dt" | "dtMs">,
) {
  match.simulationTimeMs += deltaMs;
  for (const player of Object.values(match.players)) applyIncomeTicks(player.room, match.simulationTimeMs);
  for (const slot of ["A", "B"] as const) {
    const otherSlot = slot === "A" ? "B" : "A";
    applyLaunchQueue(match.players[slot].room, match.players[otherSlot].room, match.simulationTimeMs);
  }
  updateWaveState(match.waveState, Object.values(match.players).map((player) => player.room), match.simulationTimeMs);
  for (const player of Object.values(match.players)) updateRoomSimulation(player.room, deltaSeconds);
}

function emptyRoomState() {
  return new FloatPlayerRoomState({
    id: "",
    health: 0,
    maxHealth: 0,
    coins: 0,
    income: 0,
    nextIncomeTickAt: 0,
    wallRevision: 0,
    basicUnlocked: true,
    speedUnlocked: false,
    heavyUnlocked: false,
  });
}

function syncRoom(target: FloatPlayerRoomState, source: BalloonRoom) {
  target.id = source.id;
  target.health = source.health;
  target.maxHealth = source.maxHealth;
  target.coins = source.economy.coins;
  target.income = source.economy.income;
  target.nextIncomeTickAt = source.economy.nextIncomeTickAt;
  target.wallRevision = source.wallRevision;
  target.basicUnlocked = source.unlockedBalloonTypes.basic;
  target.speedUnlocked = source.unlockedBalloonTypes.speed;
  target.heavyUnlocked = source.unlockedBalloonTypes.heavy;
  reconcile(target.walls, source.walls, (wall) => wall.id, syncWall, () => new FloatWallState());
  reconcile(target.nails, source.nailStrips, (nail) => nail.id, syncNail, () => new FloatNailState());
  reconcile(target.glue, source.glueTraps, (glue) => glue.id, syncGlue, () => new FloatGlueState());
  reconcile(target.balloons, source.balloons, (balloon) => balloon.id, syncBalloon, () => new FloatBalloonState());
  reconcile(target.launchQueue, source.attack.queue, (queued) => queued.id, syncQueued, () => new FloatQueuedBalloonState());
}

function reconcile<TSource, TTarget>(
  target: Map<string, TTarget>,
  source: readonly TSource[],
  keyOf: (value: TSource) => string,
  update: (targetValue: TTarget, sourceValue: TSource) => void,
  create: () => TTarget,
) {
  const live = new Set<string>();
  for (const sourceValue of source) {
    const key = keyOf(sourceValue);
    live.add(key);
    let targetValue = target.get(key);
    if (!targetValue) {
      targetValue = create();
      target.set(key, targetValue);
    }
    update(targetValue, sourceValue);
  }
  for (const key of target.keys()) if (!live.has(key)) target.delete(key);
}

function syncWall(target: FloatWallState, source: WallSegment) {
  Object.assign(target, { id: source.id, orientation: source.orientation, gridX: source.gridX, gridY: source.gridY, integrity: source.integrity, maxIntegrity: source.maxIntegrity });
}
function syncNail(target: FloatNailState, source: NailStrip) {
  Object.assign(target, { id: source.id, wallSegmentId: source.wallSegmentId, durability: source.durability, maxDurability: source.maxDurability, status: source.status });
}
function syncGlue(target: FloatGlueState, source: GlueTrap) {
  Object.assign(target, { id: source.id, wallSegmentId: source.wallSegmentId });
}
function syncBalloon(target: FloatBalloonState, source: Balloon) {
  Object.assign(target, { id: source.id, x: source.x, y: source.y, health: source.health, maxHealth: source.maxHealth, radius: source.radius, balloonType: source.balloonType, source: source.source, senderId: source.senderId ?? "", spawnLane: source.spawnLane, glued: source.glued });
}
function syncQueued(target: FloatQueuedBalloonState, source: QueuedBalloon) {
  Object.assign(target, { id: source.id, balloonType: source.balloonType, lane: source.lane });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function isLane(value: unknown): value is SpawnLane {
  return isInteger(value) && value >= 1 && value <= 4;
}
function isBalloonType(value: unknown): value is BalloonType {
  return value === "basic" || value === "speed" || value === "heavy";
}
function isOrientation(value: unknown): value is WallOrientation {
  return value === "vertical" || value === "horizontal";
}
function hashSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
