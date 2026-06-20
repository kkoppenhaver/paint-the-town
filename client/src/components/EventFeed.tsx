import type { EventLogEntry } from "@ptt/engine";
import { gameDateTime } from "../helpers";
import type { Config } from "@ptt/engine";

const ICON: Record<string, string> = {
  game_start: "▶", travel_start: "🚌", arrive: "📍", claim_start: "⏳",
  claim_success: "✅", claim_fail: "❌", capture: "⚔️", contraction: "🧱",
  area_locked: "🔒", cache_spawn: "🎁", cache_grab: "🤲", powerup_use: "✨",
  wait: "…", game_end: "🏁",
};

export function EventFeed({ log, config, names }: { log: EventLogEntry[]; config: Config; names: Record<string, string> }) {
  const recent = log.slice(-200).reverse();
  return (
    <div className="feed">
      <div className="feed-title">Event feed</div>
      <div className="feed-scroll">
        {recent.map((e, i) => (
          <div key={log.length - i} className={`feed-row ev-${e.type}`}>
            <span className="feed-time">{gameDateTime(config, e.simTime)}</span>
            <span className="feed-ico">{ICON[e.type] ?? "•"}</span>
            <span className="feed-text">
              {label(e, names)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function label(e: EventLogEntry, names: Record<string, string>): string {
  const who = e.teamId ? names[e.teamId] ?? e.teamId : "";
  const area = e.areaId != null ? `area ${e.areaId}` : "";
  switch (e.type) {
    case "game_start": return "Game start — spawns revealed";
    case "travel_start": return `${who} → ${area} (${e.detail?.minutes}m, ${e.detail?.source})`;
    case "arrive": return `${who} arrived at ${area}`;
    case "claim_start": {
      const ch = e.detail?.challenge as { title?: string; type?: string } | undefined;
      const chTxt = ch?.title ? ` — ${ch.type}: “${ch.title}”` : "";
      return `${who} attempting ${area} (${e.detail?.duration}m${e.detail?.capture ? ", capture" : ""})${chTxt}`;
    }
    case "claim_success": return `${who} claimed ${area}`;
    case "capture": return `${who} captured ${area}`;
    case "claim_fail": return `${who} flopped ${area}${e.detail?.reason === "wall" ? " (wall hit)" : ""}`;
    case "contraction": return `Wall contracts — Band ${e.detail?.band} locking`;
    case "area_locked": return `${area} locked (${e.detail?.holder ? names[String(e.detail.holder)] ?? e.detail.holder : "neutral"})`;
    case "cache_spawn": return `Cache appeared at ${area} (${e.detail?.contents})`;
    case "cache_grab": return `${who} grabbed ${e.detail?.contents}`;
    case "powerup_use": return `${who} used ${e.detail?.type}`;
    case "wait": return `${who} waiting`;
    case "game_end": return `Game over — winner: ${e.detail?.winner ? names[String(e.detail.winner)] ?? e.detail.winner : "tie"}`;
    default: return e.type;
  }
}
