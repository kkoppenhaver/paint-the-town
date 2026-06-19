import { useState } from "react";
import type { Config } from "@ptt/engine";

interface Props {
  config: Config;
  onApply: (config: Config) => void;
  disabled?: boolean;
}

/** Editable tunables (spec §6/§7). Hot-applies a subset mid-game via the server. */
export function ConfigDrawer({ config, onApply, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Config>(structuredClone(config));

  const num = (path: () => number, set: (v: number) => void) => (
    <input type="number" value={path()} onChange={(e) => { set(Number(e.target.value)); setDraft({ ...draft }); }} />
  );

  return (
    <div className={`drawer ${open ? "open" : ""}`}>
      <button className="drawer-toggle" onClick={() => setOpen(!open)}>⚙ Config</button>
      {open && (
        <div className="drawer-body">
          <h4>Band values</h4>
          {(["1", "2", "3", "4"] as const).map((b) => (
            <label key={b}>Band {b} {num(() => draft.bandValues[b], (v) => (draft.bandValues[b] = v))}</label>
          ))}

          <h4>Wall contractions (min)</h4>
          {draft.wall.contractionsAtMin.map((_, i) => (
            <label key={i}>#{i + 1} (locks B{4 - i}) {num(() => draft.wall.contractionsAtMin[i]!, (v) => (draft.wall.contractionsAtMin[i] = v))}</label>
          ))}
          <label>Game length {num(() => draft.game.gameLengthMin, (v) => (draft.game.gameLengthMin = v))}</label>

          <h4>Challenges</h4>
          <label>Duration min {num(() => draft.challenge.durationMinRange[0], (v) => (draft.challenge.durationMinRange[0] = v))}</label>
          <label>Duration max {num(() => draft.challenge.durationMinRange[1], (v) => (draft.challenge.durationMinRange[1] = v))}</label>
          <label>Fail chance {num(() => draft.challenge.failChance, (v) => (draft.challenge.failChance = v))}</label>
          <label>Retry penalty {num(() => draft.challenge.retryPenaltyMin, (v) => (draft.challenge.retryPenaltyMin = v))}</label>

          <h4>Power-ups</h4>
          <label><input type="checkbox" checked={draft.powerUps.enabled} onChange={(e) => { draft.powerUps.enabled = e.target.checked; setDraft({ ...draft }); }} /> enabled</label>
          <label>Cache spawn every {num(() => draft.powerUps.cacheSpawnEveryMin, (v) => (draft.powerUps.cacheSpawnEveryMin = v))}</label>

          <button className="apply" disabled={disabled} onClick={() => onApply(structuredClone(draft))}>Apply</button>
        </div>
      )}
    </div>
  );
}
