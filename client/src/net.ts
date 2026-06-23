import type { ClientMessage, Intent, ServerMessage } from "@ptt/engine";

// Where the realtime host lives. In local Vite dev (or any split deploy) set
// VITE_SERVER_URL to the ws(s):// origin. When unset — e.g. the unified Cloudflare
// Worker serving this SPA — talk to the same origin we were served from.
function defaultWsUrl(): string {
  const env = (import.meta as { env?: Record<string, string> }).env?.VITE_SERVER_URL;
  if (env) return env;
  if (typeof location !== "undefined") {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  }
  return "ws://localhost:8787";
}

const WS_URL = defaultWsUrl();
export const HTTP_BASE = WS_URL.replace(/^ws/, "http");

export type { Intent, ClientMessage, ServerMessage };
export { WS_URL };
