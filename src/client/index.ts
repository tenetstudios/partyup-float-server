import { ColyseusSDK } from "@colyseus/sdk";
import type { default as server } from "../app.config.js";
import type { FloatRoomState, FloatSlot } from "../rooms/schema/FloatRoomState.js";

const client = new ColyseusSDK<typeof server>(
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
);

const statusEl = byId("status");
const logEl = byId("log");
const wallSelect = byId("wall-id") as HTMLSelectElement;
let ownSlot: FloatSlot | null = null;
let roomSend: (payload: object) => void = () => {};

async function main() {
  const room = await client.joinOrCreate("float_room");
  currentSessionId = room.sessionId;
  roomSend = (payload) => room.send("action", payload);

  room.onMessage("action_result", (result: { applied: boolean; action: string; message: string }) => {
    appendLog(`${result.applied ? "OK" : "REJECTED"} ${result.action}: ${result.message}`);
  });
  room.onStateChange((state) => render(state));
  room.onLeave(() => { statusEl.textContent = "Disconnected"; });

  bind("ready", () => roomSend({ type: "READY" }));
  bind("send-balloon", () => roomSend({
    type: "SEND_BALLOON",
    balloonType: (byId("balloon-type") as HTMLSelectElement).value,
    lane: Number((byId("lane") as HTMLSelectElement).value),
  }));
  bind("place-wall", () => roomSend({
    type: "PLACE_WALL",
    orientation: (byId("orientation") as HTMLSelectElement).value,
    gridX: Number((byId("grid-x") as HTMLInputElement).value),
    gridY: Number((byId("grid-y") as HTMLInputElement).value),
  }));
  for (const action of ["REMOVE_WALL", "PLACE_NAILS", "REMOVE_NAILS", "PLACE_GLUE", "REMOVE_GLUE", "REPAIR_WALL"] as const) {
    bind(action.toLowerCase().replaceAll("_", "-"), () => roomSend({ type: action, wallSegmentId: wallSelect.value }));
  }

  await new Promise<void>((resolve) => room.onStateChange.once(() => resolve()));
  render(room.state);
}

function render(state: FloatRoomState) {
  if (!ownSlot) {
    for (const slot of ["A", "B"] as const) {
      if (state.players.get(slot)?.sessionId === currentSessionId) ownSlot = slot;
    }
  }
  const result = state.status === "COMPLETE"
    ? state.resultType === "draw" ? " · DRAW" : ` · Player ${state.winnerPlayerId} wins`
    : "";
  statusEl.textContent = `You: Player ${ownSlot ?? "…"} · ${state.status} · ${(state.simulationTimeMs / 1000).toFixed(1)}s · Round ${state.round || "-"}${result}`;

  for (const slot of ["A", "B"] as const) {
    const player = state.players.get(slot);
    const panel = byId(`player-${slot.toLowerCase()}`);
    if (!player) {
      panel.innerHTML = `<h2>Player ${slot}</h2><p>Waiting for player…</p>`;
      continue;
    }
    const gameRoom = player.room;
    panel.innerHTML = `
      <h2>Player ${slot} ${player.ready ? "✓ ready" : ""}${player.connected ? "" : " · reconnecting"}</h2>
      <p>Health <strong>${gameRoom.health}/${gameRoom.maxHealth}</strong> · Coins <strong>${gameRoom.coins}</strong> · Income <strong>${gameRoom.income}</strong> · Queue ${gameRoom.launchQueue.size}</p>
      <div class="board" id="board-${slot.toLowerCase()}"></div>
      <p class="structures">${[...gameRoom.walls.values()].map((wall) => `${wall.orientation[0].toUpperCase()}(${wall.gridX},${wall.gridY}) ${wall.integrity}/${wall.maxIntegrity}`).join(" · ") || "No walls"}</p>`;
    const board = byId(`board-${slot.toLowerCase()}`);
    for (const balloon of gameRoom.balloons.values()) {
      const node = document.createElement("button");
      const canManuallyPop = slot === ownSlot && state.status === "ACTIVE";
      node.type = "button";
      node.className = `balloon ${balloon.balloonType}${balloon.glued ? " glued" : ""}`;
      node.style.left = `${balloon.x * 100}%`;
      node.style.top = `${balloon.y * 100}%`;
      node.title = `${balloon.balloonType} ${balloon.health}/${balloon.maxHealth} (${balloon.source})`;
      node.disabled = !canManuallyPop;
      if (canManuallyPop) {
        node.addEventListener("pointerdown", (event) => {
          if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
          event.preventDefault();
          event.stopPropagation();
          roomSend({ type: "MANUAL_POP", balloonId: balloon.id });
        });
      }
      board.appendChild(node);
    }
  }

  const selected = wallSelect.value;
  wallSelect.replaceChildren();
  const ownRoom = ownSlot ? state.players.get(ownSlot)?.room : undefined;
  for (const wall of ownRoom?.walls.values() ?? []) {
    const option = document.createElement("option");
    option.value = wall.id;
    option.textContent = `${wall.orientation} (${wall.gridX}, ${wall.gridY}) · ${wall.integrity}/${wall.maxIntegrity}`;
    wallSelect.appendChild(option);
  }
  if ([...wallSelect.options].some((option) => option.value === selected)) wallSelect.value = selected;
}

let currentSessionId = "";

main().catch((error) => {
  console.error(error);
  statusEl.textContent = "Could not connect to float_room";
});

function byId(id: string) {
  return document.getElementById(id)!;
}
function bind(id: string, handler: () => void) {
  byId(id).addEventListener("click", handler);
}
function appendLog(message: string) {
  logEl.textContent = `${message}\n${logEl.textContent}`.slice(0, 4000);
}
