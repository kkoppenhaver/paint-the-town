import { useState } from "react";
import type { GameState, PowerUpType, Team } from "@ptt/engine";
import type { Intent } from "../net";
import type { ClientBoard } from "../helpers";
import { Diary } from "./Diary";

interface Props {
  board: ClientBoard;
  state: GameState;
  team: Team;
  selectedArea: number | null;
  onIntent: (teamId: string, intent: Intent) => void;
  /** false → read-only opponent card (status + score, no controls). */
  controllable?: boolean;
  /** "(you)" tag on your own panel in two-browser play. */
  mine?: boolean;
}

export function TeamPanel({ board, state, team, selectedArea, onIntent, controllable = true, mine = false }: Props) {
  const [dest, setDest] = useState<number | "">("");
  const idle = !team.inTransit && team.busyUntilSimTime == null && !team.waiting;
  const here = board.areas.find((a) => a.id === team.locationAreaId)!;
  const hereState = state.areas[String(team.locationAreaId)]!;
  // Live = not yet swept by the wall. The engine locks an area only once the circle
  // has fully cleared it (the core stays live until the buzzer), so `locked` is the
  // authoritative claimable flag.
  const live = !hereState.locked;
  const canClaim = idle && live && hereState.holderTeamId !== team.id && hereState.deckRemaining > 0;
  const captures = hereState.holderTeamId != null && hereState.holderTeamId !== team.id;
  const target = dest !== "" ? dest : selectedArea ?? "";
  const areasByName = [...board.areas].sort((a, b) => a.name.localeCompare(b.name));
  const running = state.clock.phase === "running";

  return (
    <div className={`panel${controllable ? "" : " panel-readonly"}${running && idle && controllable ? " panel-active" : ""}`} style={{ borderTopColor: team.color }}>
      <div className="panel-head">
        <span className="dot" style={{ background: team.color }} /> {team.name}
        {mine && <span className="you-tag">you</span>}
        {!controllable && <span className="opp-tag">opponent</span>}
      </div>

      {running && controllable && (
        idle ? (
          <div className="turn-banner active" style={{ background: team.color }}>▶ Your turn — claim, travel, or wait</div>
        ) : (
          <div className="turn-banner committed">✓ committed — waiting for the clock to advance</div>
        )
      )}
      {controllable ? (
        <div className="panel-status">
          {team.inTransit ? (
            <>🚌 en route to area {team.inTransit.destId} · arrive {Math.round(team.inTransit.arrivalSimTime)}m</>
          ) : team.busyUntilSimTime != null ? (
            <>⏳ attempting {team.busyClaim?.areaId} · done {Math.round(team.busyUntilSimTime)}m</>
          ) : team.waiting ? (
            <>… waiting</>
          ) : (
            <>📍 at {here.name} (Band {here.band}{live ? ", live" : ", locked"})</>
          )}
        </div>
      ) : (
        // Fog of war: the opponent's whereabouts, transit and in-progress claims are
        // hidden. You learn where they've been only from the areas they claim (which
        // show on the map and in the feed).
        <div className="panel-status panel-fog">🌫 location hidden — revealed only when {team.name} claims a neighborhood</div>
      )}

      {controllable && team.busyClaim?.challenge && (
        <div className="challenge-card">
          <div className="ch-head">🎯 {team.busyClaim.challenge.type} challenge · difficulty {team.busyClaim.challenge.difficulty}</div>
          <div className="ch-title">{team.busyClaim.challenge.title}</div>
          <div className="ch-prompt">{team.busyClaim.challenge.prompt}</div>
          {team.busyClaim.challenge.restriction && (
            <div className="ch-restrict">⚠ {team.busyClaim.challenge.restriction}</div>
          )}
        </div>
      )}

      <div className="panel-score">
        <span>locked <strong>{team.lockedScore}</strong></span>
        <span>provisional <strong>{team.provisionalScore}</strong></span>
      </div>

      {!controllable ? null : (
      <>
      <div className="panel-actions">
        <button disabled={!canClaim} onClick={() => onIntent(team.id, { kind: "claim" })}>
          {captures ? "Capture" : "Claim"} {here.name}
        </button>

        <div className="travel-row">
          <select value={target} onChange={(e) => setDest(e.target.value === "" ? "" : Number(e.target.value))} disabled={!idle}>
            <option value="">travel to…</option>
            {areasByName.map((a) => (
              <option key={a.id} value={a.id} disabled={a.id === team.locationAreaId}>
                {a.name} (B{a.band})
              </option>
            ))}
          </select>
          <button
            disabled={!idle || target === "" || target === team.locationAreaId}
            onClick={() => target !== "" && onIntent(team.id, { kind: "travel", destId: Number(target) })}
          >
            Go
          </button>
        </div>

        <button disabled={!idle} className="wait-btn" onClick={() => onIntent(team.id, { kind: "wait" })}>
          Wait / hold
        </button>
      </div>

      {team.inventory.length > 0 && (
        <div className="panel-inv">
          <div className="inv-title">Inventory</div>
          {team.inventory.map((p, i) => (
            <button key={i} disabled={!idle} onClick={() => onIntent(team.id, { kind: "powerup", powerUp: p as PowerUpType, targetAreaId: selectedArea ?? undefined })}>
              ✨ {p}
            </button>
          ))}
        </div>
      )}
      </>
      )}

      {/* The diary is a team's private log of its own moves (transit legs, arrivals).
          Only show it for controllable panels — never for the fogged opponent card. */}
      {controllable && <Diary state={state} board={board} teamId={team.id} />}
    </div>
  );
}
