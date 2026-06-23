// GameRoom — one Durable Object per game room. It is the authoritative actor: it holds
// canonical state, owns the connected WebSockets (Hibernation API), and drives the game
// clock with an alarm (replacing the Node server's setInterval). All game logic lives in
// the shared, host-agnostic @ptt/engine Room — this class is just the Cloudflare host.

import { DurableObject } from "cloudflare:workers";
import {
  Room,
  createGoogleProvider,
  estimateProvider,
  type Board,
  type ClientMessage,
  type ServerMessage,
  type RoomSnapshot,
  type TravelProvider,
} from "@ptt/engine";
import boardData from "./board.data.json";

export interface Env {
  ROOM: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
  GOOGLE_MAPS_API_KEY?: string;
}

// Baked at build time by scripts/build-worker-board.mjs (loadBoard() output: areas +
// adjacency + loopAreaId + challenges + transit, no map geojson). Shared by every room.
const board = boardData as unknown as Board;

const TICK_MS = 250; // clock cadence, matching the Node server's setInterval
const SNAPSHOT_KEY = "snapshot";

export class GameRoom extends DurableObject<Env> {
  private room: Room;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const key = env.GOOGLE_MAPS_API_KEY;
    const provider: TravelProvider = key ? createGoogleProvider(key) : estimateProvider;
    this.room = new Room(ctx.id.toString(), board, provider, key ? "google" : "estimate");
    // Rehydrate after an eviction/restart before serving any request (provider re-injected).
    ctx.blockConcurrencyWhile(async () => {
      const snap = await ctx.storage.get<RoomSnapshot>(SNAPSHOT_KEY);
      if (snap) this.room.restore(snap);
    });
  }

  // WebSocket upgrade. The room id is the DO name, so "join" is implicit — we hand the
  // fresh socket the current state immediately.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(this.stateJson());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.sendError(ws, "bad json");
    }
    try {
      switch (msg.type) {
        case "join":
          return ws.send(this.stateJson()); // already in this room — just resync
        case "setSpawn":
          this.room.setSpawn(msg.teamId, msg.areaId);
          break;
        case "setConfig":
          this.room.setConfig(msg.config);
          break;
        case "start":
          this.room.start(Date.now());
          await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
          break;
        case "reset":
          this.room.reset();
          await this.ctx.storage.deleteAlarm();
          break;
        case "intent":
          await this.room.applyIntent(msg.teamId, msg.intent);
          break;
      }
      await this.persist();
      this.broadcast();
    } catch (err) {
      this.sendError(ws, err instanceof Error ? err.message : String(err));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  // The clock. Each alarm advances game-time since the last tick and reschedules itself
  // while the game is running; it stops once the buzzer flips the phase to "finished".
  async alarm(): Promise<void> {
    const advanced = this.room.tickClock(Date.now());
    if (advanced) {
      await this.persist();
      this.broadcast();
    }
    if (this.room.phase === "running") {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  // RPC: on-demand debug/audit log for this room (replaces the Node server's disk logs).
  async debugLog(generatedAtReal: string): Promise<unknown> {
    return this.room.debugSnapshot({ generatedAtReal });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(SNAPSHOT_KEY, this.room.snapshot());
  }

  private stateJson(): string {
    const msg: ServerMessage = {
      type: "state",
      phase: this.room.phase,
      spawns: this.room.spawns,
      state: this.room.state,
    };
    return JSON.stringify(msg);
  }

  private broadcast(): void {
    const payload = this.stateJson();
    for (const ws of this.ctx.getWebSockets()) ws.send(payload);
  }

  private sendError(ws: WebSocket, message: string): void {
    const msg: ServerMessage = { type: "error", message };
    ws.send(JSON.stringify(msg));
  }
}
