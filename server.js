const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const LEAGUE_ID = process.env.LEAGUE_ID || '119089';
const SEASON = process.env.SEASON || '2025';

// Optional private league cookies (set in Railway env vars if needed later)
const ESPN_S2 = process.env.ESPN_S2 || '';
const SWID = process.env.SWID || '';

const ESPN_BASE = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}`;

app.use(express.static(path.join(__dirname, 'public')));

// ESPN proxy endpoint
app.get('/api/league', async (req, res) => {
  try {
    const views = [
      'mTeam',
      'mStandings',
      'mSettings',
      'mSchedule',
      'mRoster',
    ];
    const url = `${ESPN_BASE}?${views.map(v => `view=${v}`).join('&')}`;

    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; FantasyHQ/1.0)',
      'Referer': 'https://fantasy.espn.com/',
      'Origin': 'https://fantasy.espn.com',
    };

    if (ESPN_S2 && SWID) {
      headers['Cookie'] = `espn_s2=${ESPN_S2}; SWID=${SWID}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: `ESPN API returned ${response.status}`,
        detail: text.slice(0, 300),
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Fantasy HQ running on port ${PORT}`);
  console.log(`League: ${LEAGUE_ID} | Season: ${SEASON}`);
});
