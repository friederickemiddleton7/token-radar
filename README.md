# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/friederickemiddleton7/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/friederickemiddleton7/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A pre-token launch radar for the [`token-radar-01`](https://make.fun/bounty/token-radar-01) bounty. It reads a sealed snapshot of every
protocol DefiLlama tracks, finds the ones that still record no token and are not a wrapped, staked
or bridged product of one that trades, and ranks them by what their launch would be worth — each
with a concrete plan to farm it.

## Run it

```bash
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Needs Node 22.18+ (TypeScript runs as-is). The input is the sealed snapshot the kit supplies.

## What it writes to `out/`

- `board.json` — 200 ranked pre-token protocols with the model's numbers and a farm plan each.
- `data.js` — the same board as a `window.RADAR` object for the page.
- `dashboard/` — the static page (no framework, no network calls).
- `screenshots/` — the board, a detail view and a filtered view.
- `dossier.json` — everything above bundled, including the dashboard's source.

## The value model

One function, stated in the page and applied to every row:

```
implied = TVL × (TVL / floor)^-0.15 × 0.22   // scale: a concave multiple of TVL
        × (1 + clamp(change_7d, -25, +60)/100 × 0.35)   // momentum over seven days
        × (0.75 + 0.25 × min(age_days, 1095)/1095)      // accrual: time run with no token
```

The floor is the watchlist's own $5,000,000. Unknown age counts as 365 days, unknown growth as 0%.
Every number the page shows comes from this function — nothing is a hardcoded score.

## The board

The 40 watchlist protocols all appear, plus the 160 pre-token protocols below the floor with the
most TVL, so the radar also shows what is *early* rather than only what is already large. The 24
live-token protocols are set aside in their own view at the market's own capitalisation and are
never ranked against the pre-token board.

## License

MIT.

---

<sub>Entered on [make.fun](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
