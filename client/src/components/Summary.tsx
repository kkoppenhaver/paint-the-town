import type { GameState } from "@ptt/engine";
import { areaValue, type ClientBoard } from "../helpers";

/** Post-game summary + telemetry export (spec §6/§9), computed from the event log. */
export function Summary({ board, state, onReset }: { board: ClientBoard; state: GameState; onReset: () => void }) {
  const names = Object.fromEntries(state.teams.map((t) => [t.id, t.name]));
  const bandOf = (id: number) => board.areas.find((a) => a.id === id)!.band;

  // per-team transit + captures from the log
  const transit: Record<string, number> = {};
  const captures: Record<string, number> = {};
  const pending: Record<string, number> = {};
  for (const t of state.teams) { transit[t.id] = 0; captures[t.id] = 0; }
  for (const e of state.log) {
    if (e.type === "travel_start" && e.teamId) pending[e.teamId] = e.simTime;
    if (e.type === "arrive" && e.teamId && pending[e.teamId] != null) {
      transit[e.teamId]! += e.simTime - pending[e.teamId]!;
      delete pending[e.teamId];
    }
    if (e.type === "capture" && e.teamId) captures[e.teamId]! += 1;
  }

  const perBand = [1, 2, 3, 4].map((band) => {
    const areas = board.areas.filter((a) => a.band === band);
    let claimed = 0, points = 0;
    for (const a of areas) {
      const h = state.areas[String(a.id)]?.holderTeamId;
      if (h) { claimed++; points += areaValue(state.config, band); }
    }
    const flips = state.log.filter((e) => (e.type === "claim_success" || e.type === "capture") && e.areaId != null && bandOf(e.areaId) === band).length;
    return { band, claimed, total: areas.length, points, flips };
  });

  const ranked = [...state.teams].sort((a, b) => b.lockedScore - a.lockedScore);
  const margin = ranked.length >= 2 ? ranked[0]!.lockedScore - ranked[1]!.lockedScore : 0;
  const gl = state.config.game.gameLengthMin;

  const exportJson = () => download("paint-the-town-run.json", JSON.stringify({ config: state.config, log: state.log, final: state.teams }, null, 2));
  const exportCsv = () => {
    const header = "team,lockedScore,provisional,transitMin,transitPct,captures";
    const rows = state.teams.map((t) => [t.name, t.lockedScore, t.provisionalScore, Math.round(transit[t.id]!), ((100 * transit[t.id]!) / gl).toFixed(0), captures[t.id]].join(","));
    download("paint-the-town-run.csv", [header, ...rows].join("\n"));
  };

  return (
    <div className="summary-overlay">
      <div className="summary">
        <h2>{state.winnerTeamId ? `${names[state.winnerTeamId]} wins` : "Tie game"}</h2>
        <div className="summary-margin">margin {margin} pts</div>

        <table>
          <thead><tr><th>Team</th><th>Locked</th><th>Areas</th><th>Captures</th><th>Transit %</th></tr></thead>
          <tbody>
            {state.teams.map((t) => {
              const held = Object.values(state.areas).filter((a) => a.holderTeamId === t.id).length;
              return (
                <tr key={t.id}>
                  <td><span className="dot" style={{ background: t.color }} /> {t.name}</td>
                  <td>{t.lockedScore}</td><td>{held}</td><td>{captures[t.id]}</td>
                  <td>{((100 * transit[t.id]!) / gl).toFixed(0)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h4>Per band</h4>
        <table>
          <thead><tr><th>Band</th><th>Claimed</th><th>Points</th><th>Flips</th></tr></thead>
          <tbody>
            {perBand.map((b) => (
              <tr key={b.band}><td>Band {b.band}</td><td>{b.claimed}/{b.total}</td><td>{b.points}</td><td>{b.flips}</td></tr>
            ))}
          </tbody>
        </table>

        <div className="summary-actions">
          <button onClick={exportJson}>Export JSON</button>
          <button onClick={exportCsv}>Export CSV</button>
          <button className="apply" onClick={onReset}>New game</button>
        </div>
      </div>
    </div>
  );
}

function download(name: string, content: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
