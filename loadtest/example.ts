import { Client, Room } from "@colyseus/sdk";
import { cli, Options } from "@colyseus/loadtest";

export async function main(options: Options) {
  const client = new Client(options.endpoint);
  const room: Room = await client.joinOrCreate(options.roomName, {
  });

  console.log("joined FloatRoom successfully");

  room.onMessage("action_result", (payload: any) => {
    console.log("action result:", payload);
  });

  room.onStateChange.once(() => {
    room.send("action", { type: "READY" });
  });

  room.onLeave((code: number) => {
    console.log("left", code);
  });
}

cli(main);
