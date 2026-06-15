const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const LEAGUE_ID = process.env.LEAGUE_ID || '119089';
const ESPN_S2 = process.env.ESPN_S2 || '';
const SWID = process.env.SWID || '';

// Seasons to load — extend this array each year
const SEASONS = process.env.SEASONS
  ? process.env.SEASONS.split(',').map(s => s.trim())
  : ['2025', '2024', '2023', '2022'];

app.use(express.static(path.join(__dirname, 'public')));

function espnHeaders() {
  const h = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://fantasy.espn.com/',
    'Origin': 'https://fantasy.espn.com',
    'x-fantasy-filter': JSON.stringify({ schedule: { filterProposedMatchupPeriodIds: { value: [] } } }),
  };
  if (ESPN_S2 && SWID) {
    h['Cookie'] = `espn_s2=${ESPN_S2}; SWID=${SWID}`;
  }
  return h;
}

async function fetchSeason(season) {
  const views = ['mTeam', 'mStandings', 'mSettings', 'mSchedule'];
  const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${LEAGUE_ID}`;
  const url = `${base}?${views.map(v => `view=${v}`).join('&')}`;

  console.log(`[ESPN] Fetching season ${season}: ${url}`);

  const res = await fetch(url, { headers: espnHeaders() });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[ESPN] Season ${season} returned ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }

  const data = await res.json();

  // Validate we got real data
  if (!data.teams || data.teams.length === 0) {
    console.warn(`[ESPN] Season ${season}: no teams returned`);
    return null;
  }

  console.log(`[ESPN] Season ${season}: ${data.teams.length} teams, ${(data.schedule || []).length} matchups`);
  return { season: parseInt(season), ...data };
}

// Main league endpoint — returns all seasons
app.get('/api/league', async (req, res) => {
  try {
    const results = await Promise.allSettled(SEASONS.map(fetchSeason));
    const seasons = results
      .map(r => r.status === 'fulfilled' ? r.value : null)
      .filter(Boolean)
      .sort((a, b) => b.season - a.season);

    if (seasons.length === 0) {
      return res.status(502).json({
        error: 'No season data returned from ESPN',
        hint: 'Check that LEAGUE_ID is correct and the league is public. For private leagues, set ESPN_S2 and SWID env vars.',
        seasonsAttempted: SEASONS,
      });
    }

    res.json({ seasons });
  } catch (err) {
    console.error('[API] Unhandled error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint — raw ESPN response for one season
app.get('/api/debug/:season', async (req, res) => {
  try {
    const data = await fetchSeason(req.params.season);
    res.json(data || { error: 'No data returned' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, leagueId: LEAGUE_ID, seasons: SEASONS }));

app.listen(PORT, () => {
  console.log(`The League running on port ${PORT}`);
  console.log(`League ID: ${LEAGUE_ID} | Seasons: ${SEASONS.join(', ')}`);
});
