import { schema, t, type SchemaType } from "@colyseus/schema";

export type FloatLifecycle = "WAITING" | "READY" | "ACTIVE" | "COMPLETE";
export type FloatSlot = "A" | "B";

export const FloatWallState = schema({
  id: t.string(),
  orientation: t.string<"vertical" | "horizontal">(),
  gridX: t.int16(),
  gridY: t.int16(),
  integrity: t.uint8(),
  maxIntegrity: t.uint8(),
}, "FloatWallState");
export type FloatWallState = SchemaType<typeof FloatWallState>;

export const FloatNailState = schema({
  id: t.string(),
  wallSegmentId: t.string(),
  durability: t.uint8(),
  maxDurability: t.uint8(),
  status: t.string<"active" | "broken">(),
}, "FloatNailState");
export type FloatNailState = SchemaType<typeof FloatNailState>;

export const FloatGlueState = schema({
  id: t.string(),
  wallSegmentId: t.string(),
}, "FloatGlueState");
export type FloatGlueState = SchemaType<typeof FloatGlueState>;

export const FloatBalloonState = schema({
  id: t.string(),
  x: t.float32(),
  y: t.float32(),
  health: t.uint8(),
  maxHealth: t.uint8(),
  radius: t.float32(),
  balloonType: t.string<"basic" | "speed" | "heavy">(),
  source: t.string<"wave" | "player">(),
  senderId: t.string(),
  spawnLane: t.uint8(),
  glued: t.boolean(),
}, "FloatBalloonState");
export type FloatBalloonState = SchemaType<typeof FloatBalloonState>;

export const FloatQueuedBalloonState = schema({
  id: t.string(),
  balloonType: t.string<"basic" | "speed" | "heavy">(),
  lane: t.uint8(),
}, "FloatQueuedBalloonState");
export type FloatQueuedBalloonState = SchemaType<typeof FloatQueuedBalloonState>;

export const FloatPlayerRoomState = schema({
  id: t.string(),
  health: t.uint8(),
  maxHealth: t.uint8(),
  coins: t.int32(),
  income: t.int32(),
  nextIncomeTickAt: t.float64(),
  wallRevision: t.uint32(),
  basicUnlocked: t.boolean(),
  speedUnlocked: t.boolean(),
  heavyUnlocked: t.boolean(),
  walls: t.map(FloatWallState),
  nails: t.map(FloatNailState),
  glue: t.map(FloatGlueState),
  balloons: t.map(FloatBalloonState),
  launchQueue: t.map(FloatQueuedBalloonState),
}, "FloatPlayerRoomState");
export type FloatPlayerRoomState = SchemaType<typeof FloatPlayerRoomState>;

export const FloatPlayerState = schema({
  slot: t.string<FloatSlot>(),
  sessionId: t.string(),
  connected: t.boolean(),
  ready: t.boolean(),
  room: FloatPlayerRoomState,
}, "FloatPlayerState");
export type FloatPlayerState = SchemaType<typeof FloatPlayerState>;

export const FloatRoomState = schema({
  status: t.string<FloatLifecycle>(),
  matchId: t.string(),
  simulationTimeMs: t.float64(),
  serverTick: t.uint32(),
  round: t.uint32(),
  waveStatus: t.string(),
  waveSpawnedCount: t.uint32(),
  resultType: t.string(),
  winnerPlayerId: t.string(),
  players: t.map(FloatPlayerState),
}, "FloatRoomState");
export type FloatRoomState = SchemaType<typeof FloatRoomState>;
