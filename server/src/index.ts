// Authoritative WebSocket room server (spec §10). Clients send intents; the
// server resolves them against the engine and broadcasts the full state — two
// browsers can never disagree on the clock or ownership. Also serves board.json.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { formatDebugLogText, type Board } from "@ptt/engine";
import { Room } from "./room.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
// Load server/.env (e.g. GOOGLE_MAPS_API_KEY) if present; no-op when it's absent.
try {
  process.loadEnvFile(join(here, "../.env"));
} catch {
  /* no .env file — fall back to the ambient environment */
}
const board: Board = JSON.parse(readFileSync(join(here, "../../data/board.json"), "utf8"));
// Attach the per-neighborhood challenge decks (optional file; engine tolerates absence).
try {
  board.challenges = JSON.parse(readFileSync(join(here, "../../data/challenges.json"), "utf8")).byArea;
} catch {
  console.warn("challenges.json not found — claims will run without challenge text");
}
const PORT = Number(process.env.PORT ?? 8787);

const rooms = new Map<string, Room>();
const clients = new Map<WebSocket, string>(); // socket -> room id

// Debug/audit logs for every live game (written on finish + on reset of a played game).
const logDir = join(here, "../../logs");
function writeRoomDebugLog(room: Room, reason: string): void {
  const dbg = room.debugSnapshot({ generatedAtReal: new Date().toISOString() });
  if (!dbg) return;
  try {
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = join(logDir, `live-${stamp}-room-${room.id}-${reason}`);
    writeFileSync(`${base}.json`, JSON.stringify(dbg, null, 2));
    writeFileSync(`${base}.txt`, formatDebugLogText(dbg));
    console.log(`debug log (${reason}) → ${base}.json`);
  } catch (err) {
    console.warn("failed to write debug log:", err);
  }
}

function roomFor(id: string): Room {
  let r = rooms.get(id);
  if (!r) {
    r = new Room(id, board);
    rooms.set(id, r);
  }
  return r;
}

function broadcast(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg: ServerMessage = {
    type: "state",
    phase: room.phase,
    spawns: room.spawns,
    state: room.state,
  };
  const payload = JSON.stringify(msg);
  for (const [sock, rid] of clients) {
    if (rid === roomId && sock.readyState === sock.OPEN) sock.send(payload);
  }
}

function send(sock: WebSocket, msg: ServerMessage): void {
  if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(msg));
}

// HTTP: health + board.json (the client fetches the board + geojson here).
const http = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health") {
    res.writeHead(200).end("ok");
  } else if (req.url === "/board.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(readFileSync(join(here, "../../data/board.json")));
  } else {
    res.writeHead(404).end();
  }
});

const wss = new WebSocketServer({ server: http });

wss.on("connection", (sock) => {
  sock.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(sock, { type: "error", message: "bad json" });
    }
    try {
      if (msg.type === "join") {
        clients.set(sock, msg.room);
        roomFor(msg.room);
        return broadcast(msg.room);
      }
      const roomId = clients.get(sock);
      if (!roomId) return send(sock, { type: "error", message: "join a room first" });
      const room = roomFor(roomId);

      switch (msg.type) {
        case "setSpawn":
          room.setSpawn(msg.teamId, msg.areaId);
          break;
        case "setConfig":
          room.setConfig(msg.config);
          break;
        case "start":
          room.start();
          break;
        case "reset":
          if (room.state) writeRoomDebugLog(room, "reset"); // audit the game being torn down
          room.reset();
          break;
        case "intent":
          await room.applyIntent(msg.teamId, msg.intent);
          break;
      }
      broadcast(roomId);

      // Capture a debug log the moment a game finishes (once per game).
      if (room.phase === "finished" && !room.debugLogged) {
        writeRoomDebugLog(room, "finish");
        room.debugLogged = true;
      }
    } catch (err) {
      send(sock, { type: "error", message: String(err instanceof Error ? err.message : err) });
    }
  });

  sock.on("close", () => clients.delete(sock));
});

// Real-time clock: tick every running room a few times a second. Time creeps while
// a team is deciding and fast-forwards while both are committed (see Room.tickClock).
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.phase === "running") {
      const changed = room.tickClock(); // may flip phase to "finished" at the buzzer
      if (changed) broadcast(id);
    }
    if (room.phase === "finished" && !room.debugLogged) {
      writeRoomDebugLog(room, "finish");
      room.debugLogged = true;
      broadcast(id);
    }
  }
}, 250);

http.listen(PORT, () => {
  console.log(`Paint the Town room server on :${PORT}  (provider: ${process.env.GOOGLE_MAPS_API_KEY ? "google" : "estimate"})`);
});
