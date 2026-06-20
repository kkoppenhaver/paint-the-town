import type { GameState } from "@ptt/engine";
import { gameDateTime } from "../helpers";

export function HUD({ state, idle }: { state: GameState; idle: string[] }) {
  const next = state.wall.nextContractionAt;
  const toNext = next != null ? next - state.clock.simTime : null;
  const bandLocking = state.wall.liveBands.length ? Math.max(...state.wall.liveBands) : null;

  return (
    <header className="hud">
      <div className="hud-block">
        <div className="hud-label">In-game time</div>
        <div className="hud-big">{gameDateTime(state.config, state.clock.simTime)}</div>
        <div className="hud-sub">{Math.round(state.clock.simTime)} / {state.config.game.gameLengthMin} min · {state.clock.phase}</div>
      </div>

      <div className="hud-block">
        <div className="hud-label">Next contraction</div>
        {toNext != null ? (
          <>
            <div className="hud-big">{fmt(toNext)}</div>
            <div className="hud-sub">locks Band {bandLocking}</div>
          </>
        ) : (
          <>
            <div className="hud-big">Buzzer</div>
            <div className="hud-sub">core (Band 1) locks at end</div>
          </>
        )}
      </div>

      <div className="hud-block hud-scores">
        {state.teams.map((t) => (
          <div key={t.id} className="hud-score" style={{ borderColor: t.color }}>
            <span className="dot" style={{ background: t.color }} /> {t.name}
            <strong>{t.lockedScore}</strong>
            <span className="prov">+{t.provisionalScore}</span>
          </div>
        ))}
      </div>

      <div className="hud-block">
        {state.clock.phase === "finished" ? (
          <div className="paused done">game over</div>
        ) : idle.length > 0 ? (
          <div className="paused">🐢 clock slow — {idle.join(" & ")} deciding</div>
        ) : (
          <div className="paused live">⏩ fast-forwarding…</div>
        )}
      </div>
    </header>
  );
}

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
