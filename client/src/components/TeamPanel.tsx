import { useState } from "react";
import type { GameState, PowerUpType, Team } from "@ptt/engine";
import type { Intent } from "../net";
import type { ClientBoard } from "../helpers";

interface Props {
  board: ClientBoard;
  state: GameState;
  team: Team;
  selectedArea: number | null;
  onIntent: (teamId: string, intent: Intent) => void;
}

export function TeamPanel({ board, state, team, selectedArea, onIntent }: Props) {
  const [dest, setDest] = useState<number | "">("");
  const idle = !team.inTransit && team.busyUntilSimTime == null && !team.waiting;
  const here = board.areas.find((a) => a.id === team.locationAreaId)!;
  const hereState = state.areas[String(team.locationAreaId)]!;
  const live = !hereState.locked && state.wall.liveBands.includes(here.band);
  const canClaim = idle && live && hereState.holderTeamId !== team.id && hereState.deckRemaining > 0;
  const captures = hereState.holderTeamId != null && hereState.holderTeamId !== team.id;
  const target = dest !== "" ? dest : selectedArea ?? "";

  return (
    <div className="panel" style={{ borderTopColor: team.color }}>
      <div className="panel-head">
        <span className="dot" style={{ background: team.color }} /> {team.name}
      </div>

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

      <div className="panel-score">
        <span>locked <strong>{team.lockedScore}</strong></span>
        <span>provisional <strong>{team.provisionalScore}</strong></span>
      </div>

      <div className="panel-actions">
        <button disabled={!canClaim} onClick={() => onIntent(team.id, { kind: "claim" })}>
          {captures ? "Capture" : "Claim"} {here.name}
        </button>

        <div className="travel-row">
          <select value={target} onChange={(e) => setDest(e.target.value === "" ? "" : Number(e.target.value))} disabled={!idle}>
            <option value="">travel to…</option>
            {board.areas.map((a) => (
              <option key={a.id} value={a.id} disabled={a.id === team.locationAreaId}>
                {a.id} · {a.name} (B{a.band})
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
    </div>
  );
}
