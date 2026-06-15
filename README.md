# The League — Fantasy Football Dashboard

## Getting Data (Required First Step)

The app needs your ESPN cookies to scrape data. ESPN requires authentication
for all league data, even "public" leagues.

### Step 1: Get your ESPN cookies

1. Open [fantasy.espn.com](https://fantasy.espn.com) in Chrome
2. Log in to your account
3. Open DevTools: **F12** (or right-click → Inspect)
4. Go to **Application** tab → **Cookies** → `https://fantasy.espn.com`
5. Copy the value of `espn_s2` (long string)
6. Copy the value of `SWID` (looks like `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`)

### Step 2: Run the scraper locally

```bash
# Install dependencies
npm install

# Run scraper with your cookies
ESPN_S2="your_espn_s2_value" SWID="{your-swid-value}" node scrape.js

# To scrape specific seasons (default: 2024,2023,2022,2021,2020):
ESPN_S2="..." SWID="..." SEASONS="2024,2023,2022" node scrape.js
```

This creates `data/league_data.json` with all historical data.

### Step 3: Deploy

```bash
git add data/league_data.json
git commit -m "Add league data"
git push
```

Railway will redeploy automatically. The app reads from the JSON file — no
live ESPN dependency in production.

### Refreshing data during the season

Re-run `node scrape.js` weekly and redeploy (or set up a scheduled Railway
cron job).

## Optional: Turso Database

For a more scalable setup, create a Turso database and set env vars in Railway:
- `TURSO_URL` — your Turso database URL
- `TURSO_TOKEN` — your Turso auth token

Then run the scraper with those env vars set and it'll upload to Turso automatically.

## Environment Variables (Railway)

| Variable | Required | Description |
|---|---|---|
| `LEAGUE_ID` | Optional | ESPN League ID (default: 119089) |
| `ESPN_S2` | Optional | ESPN cookie (for live fallback) |
| `SWID` | Optional | ESPN cookie (for live fallback) |
| `TURSO_URL` | Optional | Turso DB URL |
| `TURSO_TOKEN` | Optional | Turso auth token |
| `SEASONS` | Optional | Comma-separated seasons to scrape |

## Debugging

- Visit `/api/status` on your Railway URL to see what data sources are active
- Visit `/health` for a basic health check
