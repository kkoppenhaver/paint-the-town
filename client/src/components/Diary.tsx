import type { EventLogEntry, GameState } from "@ptt/engine";
import { gameDateTime, type ClientBoard } from "../helpers";

/** A per-team running diary: that team's own moves, newest first, with in-game
 *  timestamps — so you can read its transit legs (and how long they took), claims,
 *  captures and flops at a glance in its own window. */
export function Diary({ state, board, teamId }: { state: GameState; board: ClientBoard; teamId: string }) {
  const nameOf = (id?: number) =>
    id != null ? board.areas.find((a) => a.id === id)?.name ?? `#${id}` : "";
  const mine = state.log.filter((e) => e.teamId === teamId);

  return (
    <div className="diary">
      <div className="diary-title">Diary</div>
      <div className="diary-scroll">
        {mine.length === 0 && <div className="diary-empty">No moves yet — make the first one.</div>}
        {mine
          .map((e, i) => ({ e, i }))
          .reverse()
          .map(({ e, i }) => {
            const line = phrase(e, nameOf);
            if (!line) return null;
            return (
              <div key={i} className={`diary-row d-${e.type}`}>
                <span className="diary-time">{gameDateTime(state.config, e.simTime)}</span>
                <span className="diary-ico">{line.icon}</span>
                <span className="diary-text">{line.text}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function phrase(e: EventLogEntry, nameOf: (id?: number) => string): { icon: string; text: string } | null {
  const d = e.detail ?? {};
  switch (e.type) {
    case "travel_start": {
      const dest = nameOf(d.destId as number);
      const route = d.summary ? ` · ${d.summary}` : d.source === "estimate" ? " · transit (est.)" : "";
      return { icon: "🚌", text: `Set off for ${dest} — ${d.minutes} min${route}` };
    }
    case "arrive":
      return { icon: "📍", text: `Arrived ${nameOf(e.areaId)}` };
    case "claim_start": {
      const ch = (d.challenge as { title?: string } | undefined)?.title;
      return {
        icon: "⏳",
        text: `Started ${nameOf(e.areaId)} challenge${ch ? ` — “${ch}”` : ""} (${d.duration} min)`,
      };
    }
    case "claim_success":
      return { icon: "✅", text: `Claimed ${nameOf(e.areaId)}` };
    case "capture":
      return { icon: "⚔️", text: `Captured ${nameOf(e.areaId)}` };
    case "claim_fail":
      return { icon: "❌", text: `Flopped ${nameOf(e.areaId)}${d.reason === "wall" ? " (wall closed in)" : ""}` };
    case "cache_grab":
      return { icon: "🎁", text: `Grabbed a ${d.contents} power-up` };
    case "powerup_use":
      return { icon: "✨", text: `Used ${d.type}` };
    case "wait":
      return { icon: "⏸", text: "Held position" };
    default:
      return null; // world events (contraction, cache_spawn, locks) live in the global feed
  }
}
