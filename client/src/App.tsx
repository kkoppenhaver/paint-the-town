import { useEffect, useMemo, useState } from "react";
import { useRoom } from "./useRoom";
import { fetchBoard, type ClientBoard } from "./helpers";
import { MapView } from "./components/MapView";
import { HUD } from "./components/HUD";
import { TeamPanel } from "./components/TeamPanel";
import { EventFeed } from "./components/EventFeed";
import { ConfigDrawer } from "./components/ConfigDrawer";
import { Summary } from "./components/Summary";

const ROOM = new URLSearchParams(location.search).get("room") ?? "demo";

export default function App() {
  const [board, setBoard] = useState<ClientBoard | null>(null);
  const [selectedArea, setSelectedArea] = useState<number | null>(null);
  const room = useRoom(ROOM);

  useEffect(() => { fetchBoard().then(setBoard).catch(() => setBoard(null)); }, []);

  const teamColors = useMemo(() => {
    const m: Record<string, string> = {};
    if (room.state) for (const t of room.state.teams) m[t.id] = t.color;
    else m.A = "#e63946"; // lobby fallback
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
        {room.state && <ConfigDrawer config={room.state.config} onApply={room.setConfig} />}
      </div>

      {room.phase === "lobby" || !room.state ? (
        <Lobby board={board} spawns={room.spawns} selected={selectedArea}
          onPick={setSelectedArea} onSpawn={room.setSpawn} onStart={room.start} teamColors={teamColors} />
      ) : (
        <div className="game">
          <HUD state={room.state} idle={idle} />
          <div className="game-body">
            <aside className="left">
              {room.state.teams.slice(0, 1).map((t) => (
                <TeamPanel key={t.id} board={board} state={room.state!} team={t} selectedArea={selectedArea} onIntent={room.sendIntent} />
              ))}
            </aside>
            <main className="center">
              <MapView board={board} state={room.state} teamColors={teamColors} onPickArea={setSelectedArea} />
              {selectedArea != null && <AreaTip board={board} state={room.state} id={selectedArea} />}
            </main>
            <aside className="right">
              {room.state.teams.slice(1).map((t) => (
                <TeamPanel key={t.id} board={board} state={room.state!} team={t} selectedArea={selectedArea} onIntent={room.sendIntent} />
              ))}
            </aside>
            <section className="feedwrap">
              <EventFeed log={room.state.log} config={room.state.config} names={names} />
            </section>
          </div>
          {room.phase === "finished" && <Summary board={board} state={room.state} onReset={room.reset} />}
        </div>
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

function Lobby({ board, spawns, selected, onPick, onSpawn, onStart, teamColors }: {
  board: ClientBoard; spawns: Record<string, number>; selected: number | null;
  onPick: (id: number) => void; onSpawn: (teamId: string, areaId: number) => void; onStart: () => void; teamColors: Record<string, string>;
}) {
  const teams = ["A", "B"];
  const ready = teams.every((t) => spawns[t] != null);
  return (
    <div className="lobby">
      <div className="lobby-side">
        <h2>Pick spawns</h2>
        <p>Click an area on the map, then assign it. Both teams reveal together at start.</p>
        {teams.map((t) => (
          <div key={t} className="lobby-team">
            <span className="dot" style={{ background: teamColors[t] ?? "#888" }} /> Team {t}
            <span className="spawn">{spawns[t] != null ? board.areas.find((a) => a.id === spawns[t])?.name : "—"}</span>
            <button disabled={selected == null} onClick={() => selected != null && onSpawn(t, selected)}>
              set to {selected != null ? `#${selected}` : "…"}
            </button>
          </div>
        ))}
        <button className="start" disabled={!ready} onClick={onStart}>Start game</button>
        <p className="hint">Tip: open a second browser at <code>?room=</code>{location.search || "?room=demo"} for two-team play, or drive both panels here (hot-seat).</p>
      </div>
      <MapView board={board} state={null} teamColors={teamColors} onPickArea={onPick} />
    </div>
  );
}
