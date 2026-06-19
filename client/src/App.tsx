import { useEffect, useMemo, useState } from "react";
import { useRoom } from "./useRoom";
import { fetchBoard, type ClientBoard } from "./helpers";
import { MapView } from "./components/MapView";
import { HUD } from "./components/HUD";
import { TeamPanel } from "./components/TeamPanel";
import { EventFeed } from "./components/EventFeed";
import { ConfigDrawer } from "./components/ConfigDrawer";
import { Summary } from "./components/Summary";

const PARAMS = new URLSearchParams(location.search);
const ROOM = PARAMS.get("room") ?? "demo";
const INITIAL_TEAM = (() => {
  const t = (PARAMS.get("team") ?? "").toUpperCase();
  return t === "A" || t === "B" ? t : null;
})();

/** Persist the chosen team in the URL so a reload keeps this browser's seat. */
function writeTeamParam(team: string | null) {
  const p = new URLSearchParams(location.search);
  if (team) p.set("team", team); else p.delete("team");
  history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
}

export default function App() {
  const [board, setBoard] = useState<ClientBoard | null>(null);
  const [selectedArea, setSelectedArea] = useState<number | null>(null);
  const [myTeam, setMyTeam] = useState<string | null>(INITIAL_TEAM);
  const room = useRoom(ROOM);

  useEffect(() => { fetchBoard().then(setBoard).catch(() => setBoard(null)); }, []);

  function chooseTeam(team: string | null) { setMyTeam(team); writeTeamParam(team); }

  const teamColors = useMemo(() => {
    const m: Record<string, string> = {};
    if (room.state) for (const t of room.state.teams) m[t.id] = t.color;
    else { m.A = "#e63946"; m.B = "#1d6fb8"; } // lobby fallback (matches DEFAULT_CONFIG)
    return m;
  }, [room.state]);

  if (!board) return <div className="boot">Loading board… (is the server running on :8787?)</div>;

  const names = room.state ? Object.fromEntries(room.state.teams.map((t) => [t.id, t.name])) : {};
  const idle = room.state ? room.state.teams.filter((t) => !t.inTransit && t.busyUntilSimTime == null && !t.waiting).map((t) => t.name) : [];

  return (
    <div className="app">
      <div className="topbar">
        <strong>Paint the Town</strong> <span className="room">room: {ROOM}</span>
        <span className={`conn ${room.connected ? "ok" : "bad"}`}>{room.connected ? "● live" : "○ offline"}</span>
        {room.error && <span className="err">⚠ {room.error}</span>}
        <TeamSwitcher myTeam={myTeam} onChoose={chooseTeam} teamColors={teamColors} names={names} />
        {room.phase !== "lobby" && (
          <button className="reset-btn" title="End this game and return to spawn pick"
            onClick={() => { if (confirm("Reset the game and return to the lobby?")) room.reset(); }}>
            ↺ reset
          </button>
        )}
        {room.state && <ConfigDrawer config={room.state.config} onApply={room.setConfig} />}
      </div>

      {room.phase === "lobby" || !room.state ? (
        <Lobby board={board} spawns={room.spawns} selected={selectedArea} myTeam={myTeam}
          onPick={setSelectedArea} onSpawn={room.setSpawn} onStart={room.start} teamColors={teamColors} names={names} />
      ) : (
        (() => {
          // Seat order: in two-browser play YOUR team is the primary (left) panel
          // and you control only it; the opponent shows as a read-only card.
          // Hot-seat (no team chosen) keeps both panels controllable.
          const teams = room.state!.teams;
          const mine = myTeam ? teams.find((t) => t.id === myTeam) ?? null : null;
          const left = mine ?? teams[0];
          const right = mine ? teams.find((t) => t.id !== myTeam) ?? teams[1] : teams[1];
          return (
        <div className="game">
          <HUD state={room.state} idle={idle} />
          <div className="game-body">
            <aside className="left">
              <TeamPanel board={board} state={room.state!} team={left} selectedArea={selectedArea}
                onIntent={room.sendIntent} controllable={!myTeam || left.id === myTeam} mine={!!myTeam && left.id === myTeam} />
            </aside>
            <main className="center">
              <MapView board={board} state={room.state} teamColors={teamColors} onPickArea={setSelectedArea} />
              {selectedArea != null && <AreaTip board={board} state={room.state} id={selectedArea} />}
            </main>
            <aside className="right">
              <TeamPanel board={board} state={room.state!} team={right} selectedArea={selectedArea}
                onIntent={room.sendIntent} controllable={!myTeam} mine={false} />
            </aside>
            <section className="feedwrap">
              <EventFeed log={room.state.log} config={room.state.config} names={names} />
            </section>
          </div>
          {room.phase === "finished" && <Summary board={board} state={room.state} onReset={room.reset} />}
        </div>
          );
        })()
      )}
    </div>
  );
}

function AreaTip({ board, state, id }: { board: ClientBoard; state: NonNullable<ReturnType<typeof useRoom>["state"]>; id: number }) {
  const a = board.areas.find((x) => x.id === id);
  const s = state?.areas[String(id)];
  if (!a || !s) return null;
  const holder = s.holderTeamId ? state!.teams.find((t) => t.id === s.holderTeamId)?.name : "neutral";
  return (
    <div className="areatip">
      <strong>{a.name}</strong> (#{a.id}) · Band {a.band} · value {state!.config.bandValues[String(a.band) as "1" | "2" | "3" | "4"]}<br />
      holder: {holder} · deck {s.deckRemaining} · {s.locked ? "locked" : "live"}
    </div>
  );
}

function TeamSwitcher({ myTeam, onChoose, teamColors, names }: {
  myTeam: string | null; onChoose: (t: string | null) => void;
  teamColors: Record<string, string>; names: Record<string, string>;
}) {
  const label = (t: string) => names[t] ?? `Team ${t}`;
  return (
    <div className="seat">
      <span className="seat-label">seat:</span>
      {(["A", "B"] as const).map((t) => (
        <button key={t} className={`seat-btn${myTeam === t ? " on" : ""}`}
          style={myTeam === t ? { borderColor: teamColors[t], color: teamColors[t] } : undefined}
          onClick={() => onChoose(t)}>
          <span className="dot" style={{ background: teamColors[t] ?? "#888" }} /> {label(t)}
        </button>
      ))}
      <button className={`seat-btn${myTeam == null ? " on" : ""}`} onClick={() => onChoose(null)}>both (hot-seat)</button>
    </div>
  );
}

function Lobby({ board, spawns, selected, myTeam, onPick, onSpawn, onStart, teamColors, names }: {
  board: ClientBoard; spawns: Record<string, number>; selected: number | null; myTeam: string | null;
  onPick: (id: number) => void; onSpawn: (teamId: string, areaId: number) => void; onStart: () => void;
  teamColors: Record<string, string>; names: Record<string, string>;
}) {
  const teams = myTeam ? [myTeam] : ["A", "B"];
  const bothSpawned = ["A", "B"].every((t) => spawns[t] != null);
  const label = (t: string) => names[t] ?? `Team ${t}`;
  const base = `${location.origin}${location.pathname}?room=${ROOM}`;
  const opp = myTeam === "A" ? "B" : "A";

  return (
    <div className="lobby">
      <div className="lobby-side">
        <h2>{myTeam ? `You are ${label(myTeam)} — pick your spawn` : "Pick spawns"}</h2>
        <p>Click an area on the map, then assign it. Both teams stay hidden until the game starts.</p>
        {teams.map((t) => (
          <div key={t} className="lobby-team">
            <span className="dot" style={{ background: teamColors[t] ?? "#888" }} /> {label(t)}{t === myTeam ? " (you)" : ""}
            <span className="spawn">{spawns[t] != null ? board.areas.find((a) => a.id === spawns[t])?.name : "—"}</span>
            <button disabled={selected == null} onClick={() => selected != null && onSpawn(t, selected)}>
              set to {selected != null ? `#${selected}` : "…"}
            </button>
          </div>
        ))}

        {myTeam && (
          <div className="lobby-team opp-status">
            <span className="dot" style={{ background: teamColors[opp] ?? "#888" }} /> {label(opp)}
            <span className="spawn">{spawns[opp] != null ? "ready ✓" : "choosing spawn…"}</span>
          </div>
        )}

        <button className="start" disabled={!bothSpawned} onClick={onStart}>
          {bothSpawned ? "Start game" : "Waiting for both spawns…"}
        </button>

        {myTeam ? (
          <p className="hint">Your teammate (the other browser) should open <code>{`${base}&team=${opp}`}</code> and pick their spawn. Either of you can start once both are set.</p>
        ) : (
          <p className="hint">Two-browser play: open <code>{`${base}&team=A`}</code> in one window and <code>{`${base}&team=B`}</code> in the other — each controls one team. Or use the <b>seat</b> switch above and drive both here (hot-seat).</p>
        )}
      </div>
      <MapView board={board} state={null} teamColors={teamColors} onPickArea={onPick} />
    </div>
  );
}
