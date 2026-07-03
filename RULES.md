# Paint the Town — Game Rules (authoritative)

The single source of truth for how **Paint the Town** is played. Mechanics/numbers here are
canonical and mirror the simulator (`engine/src/config.ts`); the actual neighborhood **challenge
card decks** live in the sibling repo `jetlag-the-game/chicago_challenges/` (77 decks, ~1,257 cards).

> **Source-of-truth split:** game *mechanics, board, balance* → this repo (`paint-the-town`). Challenge
> *card content* → `jetlag-the-game/chicago_challenges/`. When a number here and in `config.ts`
> disagree, `config.ts` is what actually runs — keep them in sync.

Status: core model (wall, bands, scoring, clock) is **decided** and simulated. The rules we settled
in design review — **veto/failure, no-GPS hidden movement, budget/transit, phones/Google** — are
**decided** (below). The **special-ability layer** (claim bonuses, steals, curses) is **open** — see
"Open questions."

---

## 1. Objective

Two teams roam the **77 Chicago community areas** claiming territory for points over an **8-hour**
game (notional start: Saturday 9:00 AM). A **Fortnite-style wall closes inward from the city edge
toward the Loop**, locking each ring of neighborhoods as it consumes them. **Highest *locked* score
at the 8-hour buzzer wins;** ties break on **largest connected region** of owned areas.

## 2. The board & bands

- 77 community areas, each with a fixed **band** (1–4) by distance to the Loop and a point **value**:

  | Band | Where | Value |
  |---|---|---|
  | 1 | Loop core (Loop, Near N/S/W Side, Armour Square) | **8** |
  | 2 | inner ring | **4** |
  | 3 | middle ring | **2** |
  | 4 | city edge (e.g. O'Hare, Hegewisch, Riverdale, far NW/SW/SE) | **1** |

- Each area has a **deck** of challenge cards (`deckSize` in `board.json`; the content is in
  `jetlag-the-game`). Adjacency is tracked for the connected-region tiebreak.

## 3. The wall (closing circle)

The wall is centered on the Loop and contracts in steps, **locking the outermost still-open band
each time** (`config.wall.contractionsAtMin`):

| Time | Event |
|---|---|
| **2.5 h** (150 min) | Band 4 (edge) locks |
| **5.0 h** (300 min) | Band 3 locks |
| **6.5 h** (390 min) | Band 2 locks |
| **8.0 h** (480 min) | Band 1 (Loop) locks — buzzer |

- Points for an owned area are **provisional** until its band locks, then **locked** (final).
- Once a band locks, its areas can no longer be claimed or captured — it's out of play.
- Consequence (confirmed by balance sweeps): **the core decides games.** Cheap edge areas lock first
  and are worth the least, so a "core rush" beats an "edge sweep" ~19–1 under default values. Distant
  Band-4 claims (O'Hare) are only ever an *early* play, and currently under-incentivized — see Open.

## 4. Taking territory

**Claim (an unowned area):** travel to it, draw **one** random card from its deck, complete the card
to claim it. (Challenge work-time in the sim: 8–16 min.)

**Capture / steal (an area the opponent owns):** flip it to your team. The generic mechanic exists in
the engine (`capture` event); the *exact* player-facing rule — what it costs, whether it needs a
harder challenge — is **open** (see §11 and Open questions).

**Claiming reveals you** — see §6.

## 5. Failing or vetoing a challenge — *decided*

Human rule (the sim approximates this with a flat 15% fail chance + 10-min retry penalty — **to be
aligned**, see Open):

- Can't or won't complete the drawn card → **VETO**: team **frozen 15 min**, then **redraw a
  different card** from that area's deck.
- **Vetoes are limited to 2 per neighborhood** (you'll see up to 3 of its cards); after that, complete
  the card in hand or leave the area unclaimed.
- **Closed/inaccessible venue = FREE redraw** — no freeze, doesn't spend a veto (fairness valve for
  limited-hours spots like the Green Mill). Limited-hours cards should carry an exterior fallback.
- **Card-internal penalties** ("wrong guess = wait 5 min, retry") are part of *attempting* a card and
  do **not** spend a veto.
- *Tunable:* freeze length (default 15 min), vetoes per neighborhood (default 2).

## 6. Information & hidden movement — *decided (no GPS)*

There is **no live GPS/location tracking** of the other team — no tracker app, no map of where they
are. You learn their whereabouts **only when they claim a neighborhood** (each claim is announced:
which area, and that they were there). Between claims their movement is hidden — the game runs on
**prediction, timing, and bluffing** (early-Jet-Lag "fog of war," not the live-tracker seasons).

The app **enforces** this per seat (pick a team with `?team=A`/`?team=B`): the opponent's live
position marker, transit, in-progress claims and movement events are all hidden — you see only the
neighborhoods they own (map fill) and their successful-claim announcements in the feed. Hot-seat
mode (no seat chosen, one person refereeing both) still shows everything. *(The balance sim is
unaffected: its AI never routed off the opponent's position — it decides from its own location and
which areas are owned — so fog of war doesn't change balance results.)*

## 7. Budget & transit — *decided*

Money is deliberately **out of the way**; players never manage a cash budget.

- **Challenge costs are fully reimbursable** — spend freely on whatever a card requires; cost is never
  a reason to veto.
- **All public transit is all-expenses-paid:** free unlimited all-day CTA pass (bus + train), and
  Metra fares covered/reimbursed.
- **Private transport is banned by default** — no Uber/Lyft, taxi, rideshare scooter/bike, or private
  car — **unless a card/power-up grants it** (the *uber* power-up, §10).

## 8. Phones & Google — *decided*

A general rule applied by **spirit**, not per-card:

- **Allowed:** navigation, transit/routing, logistics — where to go, how to get there, where to find a
  food/business. (And filming.)
- **Not allowed:** looking up the **answer to a challenge** — any fact/count/solution the card tests.
  If you could just Google it, you can't.
- **Guess-then-verify cards:** lock your guess first (no phone), *then* you may look it up only to
  verify the committed guess.

## 9. Scoring & win

- Score = sum of **band values of areas you own**, counted as **locked** once their band closes.
- **Win:** highest **locked** score at the 8-h buzzer.
- **Tiebreak:** largest **connected region** of owned areas (adjacency map).

## 10. Power-ups — *catalog decided; integration open*

A global catalog earned from **caches** that spawn on the map (Phase 2; off in the MVP). Inventory cap
2. Current catalog (`config.powerUps`):

| Power-up | Effect | Rarity |
|---|---|---|
| **express** | skip a whole travel leg's time | common |
| **double-down** | next claim worth ×1.5 | common |
| **curse** | hit opponent: +20-min penalty, lasts 60 min | common |
| **lockdown** | freeze an opponent ability for 60 min | uncommon |
| **uber** | one private-transport hop (~12 min), bypassing transit | rare |

> **Open:** this catalog overlaps the per-neighborhood **Claim bonus / Steal / Curse** cards in the
> jetlag decks. We need to decide whether those per-area cards survive, fold into this catalog, or are
> cut. See Open questions.

## 11. Open questions / to reconcile

1. **Claim bonuses.** The jetlag decks each have an instant-claim "Claim bonus" card; the sim has no
   such concept (you claim by completing any challenge). Keep, redefine, or cut?
2. **Steals.** Reconcile generic `capture` (flip any owned area) vs. per-neighborhood Steal *cards*.
   What does capturing cost / require? Do we want only "a couple" steal options?
3. **Curses.** Reconcile the *curse* power-up vs. per-neighborhood Curse cards — and whether curses
   belong in this game at all.
4. **O'Hare / edge value.** Band 4 is worth 1 and locks first, so far areas (O'Hare especially) are
   rarely worth the trip. Boost via `bandValues`, `scoring.transitBonusPerLevel`, or per-area value so
   the early far-edge gamble pays. (O'Hare: airside is allowed via a reimbursable plane ticket.)
5. **Veto ↔ sim numbers.** Align `config.challenge` (failChance 0.15 / retryPenalty 10) with the human
   veto model (15-min freeze, 2 vetoes/area, closed-venue free redraw).
