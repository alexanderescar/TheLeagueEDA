# The League — Fantasy Football Analytics Dashboard

**A full-stack web app that pulls years of ESPN fantasy-football history into one always-on dashboard.**

The League scrapes a fantasy league's data straight from the ESPN API, stores it, and serves it through a deployed web dashboard — so a group of friends can see standings, records, and historical trends across multiple seasons in one place instead of digging through ESPN's UI season by season.

> Full-stack project: Node.js scraper + data pipeline + deployed web app. Built, deployed, and documented end-to-end.

---

## The problem

ESPN's fantasy app makes it hard to see history. Once a season ends, the interesting stuff — multi-year records, head-to-head trends, who's actually the best manager over time — is buried or gone. I wanted one place that pulled it all together and stayed live.

## What it does

- **Scrapes multiple seasons** of league data from the ESPN API (default: the last five seasons).
- **Stores the data** as a JSON snapshot (with an optional database backend) so the production site has no live dependency on ESPN.
- **Serves a dashboard** that's deployed and always on, with health-check and status endpoints for debugging.
- **Refreshes on demand** — re-run the scraper weekly during the season and redeploy, or wire it to a scheduled job.

## Tech stack

- **Backend / scraper:** Node.js
- **Data:** JSON snapshot, with optional [Turso](https://turso.tech/) (SQLite) database backend
- **Hosting:** Railway (auto-redeploys on push)
- **Source data:** ESPN Fantasy API (cookie-authenticated)

## Architecture at a glance

```
ESPN API ──> scrape.js ──> data/league_data.json ──> web dashboard (Railway)
                                  │
                                  └──(optional)──> Turso database
```

The production app reads from the committed JSON file, so the site stays up even if ESPN is unreachable.

---

## Getting started

### 1. Get your ESPN cookies
ESPN requires authentication for all league data, even "public" leagues.

1. Open `fantasy.espn.com` in Chrome and log in.
2. Open DevTools (`F12`) → **Application** tab → **Cookies** → `https://fantasy.espn.com`.
3. Copy the value of **`espn_s2`** (a long string) and **`SWID`** (looks like `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`).

### 2. Run the scraper
```bash
# Install dependencies
npm install

# Run the scraper with your cookies
ESPN_S2="your_espn_s2_value" SWID="{your-swid-value}" node scrape.js

# Optional: choose specific seasons (default: 2024,2023,2022,2021,2020)
ESPN_S2="..." SWID="..." SEASONS="2024,2023,2022" node scrape.js
```
This creates `data/league_data.json` with all historical data.

### 3. Deploy
```bash
git add data/league_data.json
git commit -m "Add league data"
git push
```
Railway redeploys automatically.

### Refreshing during the season
Re-run `node scrape.js` weekly and redeploy (or set up a scheduled Railway cron job).

### Optional: Turso database
For a more scalable setup, create a Turso database and set these env vars in Railway:
- `TURSO_URL` — your Turso database URL
- `TURSO_TOKEN` — your Turso auth token

Then run the scraper with those vars set and it uploads to Turso automatically.

### Environment variables (Railway)
| Variable | Required | Description |
|----------|----------|-------------|
| `LEAGUE_ID` | Optional | ESPN League ID |
| `ESPN_S2` | Optional | ESPN cookie (for live fallback) |
| `SWID` | Optional | ESPN cookie (for live fallback) |
| `TURSO_URL` | Optional | Turso DB URL |
| `TURSO_TOKEN` | Optional | Turso auth token |
| `SEASONS` | Optional | Comma-separated seasons to scrape |

### Debugging
- `/api/status` — shows which data sources are active
- `/health` — basic health check

---

## What I learned / what I'd do differently

- Decoupling production from the live ESPN API (read from a committed snapshot) was the key design call — it made the site reliable instead of breaking every time ESPN changed something.
- Next iteration: a scheduled job to auto-refresh in-season, and a few visualizations on top of the raw history (manager ratings over time, head-to-head heatmaps).

---

*Built by [Alexander Escar](https://github.com/alexanderescar).*
