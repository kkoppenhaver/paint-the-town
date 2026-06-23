// Unified Worker entry. Routes realtime WebSocket traffic to the per-room Durable Object
// and serves everything else (the built SPA + the full board.json) from static assets.

import { GameRoom, type Env } from "./GameRoom.js";

export { GameRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Realtime: /ws?room=ID → the GameRoom DO for that room handles the upgrade.
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room");
      if (!room) return new Response("missing ?room", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected a WebSocket upgrade", { status: 426 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }

    // On-demand debug/audit log: /rooms/:id/debug.json (RPC into the room's DO).
    const dbg = url.pathname.match(/^\/rooms\/([^/]+)\/debug\.json$/);
    if (dbg) {
      const stub = env.ROOM.get(env.ROOM.idFromName(decodeURIComponent(dbg[1])));
      const log = await stub.debugLog(new Date().toISOString());
      if (!log) return new Response("no game in this room yet", { status: 404 });
      return Response.json(log);
    }

    // SPA + /board.json, with index.html fallback for client-side routes.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
