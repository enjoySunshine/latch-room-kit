import { CloseCode, Room, type Client, validate, type Messages, type AuthContext, definePlugins } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";
import { AnalyticsPlugin, CloudSavesPlugin, LeaderboardsPlugin } from "@colyseus/database";
import { z } from "zod";
import { database } from "./db/database.ts";
// Importing @colyseus/auth installs a JWT-decoding default for
// Room.onAuth (side-effect import). The example already imports it
// elsewhere via app.config.ts, but pinning the import here documents
// the dependency for anyone reading just this room file.
import "@colyseus/auth";
import { TrackUserSessionsPlugin } from "colyseus/plugins/track-user-sessions";

const VERSION = 5;

export const Player = schema({
  x: t.number(),
  y: t.number(),
  score: t.number(),
});
export type Player = SchemaType<typeof Player>;

export const MyRoomState = schema({
  mapWidth: t.number(),
  mapHeight: t.number(),
  players: t.map(Player),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;

const thirdPartyMessages: Messages<MyRoom> = {
  nopayload: function (client: MyClient, message: any) {
    this.broadcast("hello", {});
    client.send("hello", {});
  },

  with_validation: validate(z.object({
    name: z.string(),
  }), function (client: MyClient, message: any) {
    this.broadcast("obj_message", { message: "hello" });
    client.send("obj_message", { message: "hello" })
  }),

  // _ and * are equivalent (fallback handlers)
  // we're using both just to check types
  _: function (client: MyClient, type: string, message: any) {
    this.broadcast("hello", {});
  },
  // // _ and * are equivalent (fallback handlers)
  // // we're using both just to check types
  // '*': function (client: MyClient, type: string, message: any) {
  //   this.broadcast("hello", {});
  // },
}

/** Per-client, server-only move ordering bookkeeping (never replicated). */
interface MoveBookkeeping {
  /** Highest seq already written onto the player's state. */
  lastAppliedSeq: number;
  /** Higher-seq packets that landed before a missing lower seq. */
  pendingMoves: Map<number, { x: number; y: number }>;
}

type MyClient = Client<{
  userData: MoveBookkeeping & { custom?: boolean };
  auth: { custom: boolean };
  messages: {
    nopayload: never;
    message: any;
    nopayload_2: any;
    obj_message: { message: string };
    hello: any;
  };
}>;

const Input = schema({
  seq: t.number(),
  x: t.number(),
  y: t.number(),
});
type Input = SchemaType<typeof Input>;

/**
 * Out-of-order window kept per client before we give up on a missing seq.
 * Normal reordering only spans a handful of packets; the cap just stops a
 * silently-lost packet from pinning a player's input forever.
 */
const MAX_PENDING_MOVES = 256;

export class MyRoom extends Room<{ state: MyRoomState, client: MyClient, input: Input }> {
  state = new MyRoomState();

  // Database-driven plugins — one instance per room. The framework
  // walks this record at __init, computes the lifecycle/message layout
  // ONCE per Room class (cached on the constructor), and installs hook
  // wrappers on the prototype. Subsequent constructs of MyRoom reuse
  // the cached layout. Public methods are reachable as
  // `this.plugins.<key>.<method>(...)` with full types.

  plugins = definePlugins([
    new TrackUserSessionsPlugin(),
    new AnalyticsPlugin({ database, prefix: 'my_room' }),
    new CloudSavesPlugin({
      database,
      slot: 0,
      payload: (room, client) => {
        const player = room.state.players.get(client.sessionId);
        return player ? { x: player.x, y: player.y, score: player.score } : null;
      },
      apply: (room, client, data) => {
        const player = room.state.players.get(client.sessionId);
        if (!player || !data) return;
        const d = data as { x: number; y: number; score: number };
        player.x = d.x;
        player.y = d.y;
        player.score = d.score;
      },
    }),
    new LeaderboardsPlugin({
      database,
      boardId: 'my_room_score',
      boardName: 'MyRoom Score',
      score: (room, client) => room.state.players.get(client.sessionId)?.score ?? null,
    })
  ]);

  messages = {
    ...thirdPartyMessages,
    move: validate(z.object({
      seq: z.number().int().positive(),
      x: z.number(),
      y: z.number(),
      z: z.number().optional()
    }), (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) { return; }

      // Per-client ordering bookkeeping lives on userData (never replicated).
      // userData is optional on the base Client, so make sure it exists.
      const userData: MoveBookkeeping = client.userData ?? {
        lastAppliedSeq: 0,
        pendingMoves: new Map(),
      };
      client.userData = userData as MyClient['userData'];
      if (typeof userData.lastAppliedSeq !== "number") {
        userData.lastAppliedSeq = 0;
        userData.pendingMoves = new Map();
      }

      const { seq, x, y } = message;

      // A seq we already wrote (duplicate) or one older than it (late packet)
      // must never move the player backwards. Drop it before it can
      // overwrite a newer landing point.
      if (seq <= userData.lastAppliedSeq) {
        return;
      }

      // Hold out-of-order packets: 22 and 23 arriving before 21 stay buffered
      // so the replay still walks 105,105 -> 110,110 -> 115,115 in order and
      // the canvas (a pure view of this state) makes every step. The frontier
      // packet (seq === lastAppliedSeq + 1) is never buffered — it closes the
      // gap and drives the replay below.
      if (seq > userData.lastAppliedSeq + 1) {
        if (!userData.pendingMoves.has(seq)) {
          userData.pendingMoves.set(seq, { x, y });
        }
        if (userData.pendingMoves.size <= MAX_PENDING_MOVES) {
          return;
        }
        // A seq appears to be lost: skip the gap rather than freeze movement
        // forever. Everything below the new frontier is dropped with it.
        userData.lastAppliedSeq = Math.min(...userData.pendingMoves.keys()) - 1;
      }

      // Merge the frontier packet with the buffer, then write every
      // contiguous seq in order — each one lands its own (x, y) on state.
      const queue = new Map<number, { x: number; y: number }>(userData.pendingMoves);
      queue.set(userData.lastAppliedSeq + 1, { x, y });

      while (queue.has(userData.lastAppliedSeq + 1)) {
        const applySeq = userData.lastAppliedSeq + 1;
        const position = queue.get(applySeq)!;
        player.x = position.x;
        player.y = position.y;
        userData.lastAppliedSeq = applySeq;
        userData.pendingMoves.delete(applySeq);
      }

      console.log("MOVE", { sessionId: client.sessionId, VERSION, seq: userData.lastAppliedSeq, x: player.x, y: player.y });
    }),

    nopayload_2: (client: MyClient, message: any) => {
      client.send("obj_message", { message: "hello" })
      this.broadcast("obj_message", { message: "hello" })
    },

    _: (client: MyClient, type: string, message: any) => {
      this.broadcast(type as any, message);
    },
  };

  onCreate(options: any) {
    this.seatReservationTimeout = 31;

    // map dimensions
    this.state.mapWidth = 800;
    this.state.mapHeight = 600;

    this.onMessage("__move", (client, message) => {})
    this.onMessage("__dummy", (client, message) => { })

    this.onMessage("move_with_validation", z.object({ x: z.number(), y: z.number() }), (client, message) => {
      const player = this.state.players.get(client.sessionId)!;
      player.x = message.x;
      player.y = message.y;
    });

    this.setSimulationInterval(() => this.update());
  }

  onJoin(client: MyClient, options: { x?: number; y?: number } = {}) {
    const player = new Player();
    // A caller may pin the spawn (tests need a deterministic origin); the
    // default stays a random point inside the map.
    player.x = typeof options.x === "number" ? options.x : Math.random() * this.state.mapWidth;
    player.y = typeof options.y === "number" ? options.y : Math.random() * this.state.mapHeight;
    this.state.players.set(client.sessionId, player);

    // Move ordering bookkeeping (never replicated — userData stays server-side).
    // userData is optional on the base Client, so assign it rather than mutate.
    client.userData = {
      ...(client.userData ?? {}),
      lastAppliedSeq: 0,
      pendingMoves: new Map(),
    } as MyClient['userData'];

    console.log("ON JOIN", { VERSION });
  }

  public onReconnect(client: MyClient): void | Promise<any> {
    console.log(client.sessionId, "reconnected!");
  }

  update() {
    // this.state.players.forEach((player, key) => {
    //   player.x += 1;
    //   player.y += 1;
    // });
  }

  async onLeave(client, code: number) {
    try {
      if (code === CloseCode.CONSENTED) { throw new Error("consented leave"); }

      console.log(client.sessionId, "waiting for reconnection...");
      await this.allowReconnection(client, 10);

      console.log(client.sessionId, "reconnected!");

    } catch (e) {
      this.state.players.delete(client.sessionId);
      console.log(client.sessionId, "left!");
    }
  }

  onCacheRoom() {
    return { hello: true };
  }

  onRestoreRoom(cached: any): void {
    console.log("onRestoreRoom", cached);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  onBeforeShutdown() {
    //
    // Disconnect all clients after 5 seconds
    //
    this.clock.setTimeout(() => this.disconnect(), 5 * 1000);
  }

}
