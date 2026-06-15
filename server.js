const express = require('express');
const path = require('path');
const fs = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const LEAGUE_ID    = process.env.LEAGUE_ID    || '119089';
const ESPN_S2      = process.env.ESPN_S2      || '';
const SWID         = process.env.SWID         || '';
const TURSO_URL    = process.env.TURSO_URL    || '';
const TURSO_TOKEN  = process.env.TURSO_TOKEN  || '';

// Data file written by scrape.js
const DATA_FILE = path.join(__dirname, 'data', 'league_data.json');

app.use(express.static(path.join(__dirname, 'public')));

// ── Data source priority:
//    1. Turso (if configured)
//    2. Local JSON file (committed from scrape)
//    3. Live ESPN fetch (fallback, requires cookies)

async function getFromTurso() {
  if (!TURSO_URL || !TURSO_TOKEN) return null;
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  const res = await db.execute('SELECT data FROM league_data WHERE id = 1');
  if (!res.rows.length) return null;
  return JSON.parse(res.rows[0].data);
}

function getFromFile() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function espnHeaders() {
  const h = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://fantasy.espn.com/',
    'Origin': 'https://fantasy.espn.com',
  };
  if (ESPN_S2 && SWID) h['Cookie'] = `espn_s2=${ESPN_S2}; SWID=${SWID}`;
  return h;
}

async function fetchSeasonLive(season) {
  const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${LEAGUE_ID}`;

  const [main, draftRes] = await Promise.allSettled([
    fetch(`${base}?view=mTeam&view=mStandings&view=mSettings&view=mSchedule`, { headers: espnHeaders() }),
    fetch(`${base}?view=mDraftDetail`, { headers: espnHeaders() }),
  ]);

  if (main.status === 'rejected' || !main.value.ok) return null;
  const data = await main.value.json();
  if (!data.teams?.length) return null;

  let draftDetail = null;
  if (draftRes.status === 'fulfilled' && draftRes.value.ok) {
    const dd = await draftRes.value.json();
    draftDetail = dd.draftDetail || null;
  }

  return {
    season: parseInt(season),
    settings:    data.settings    || {},
    teams:       data.teams       || [],
    schedule:    data.schedule    || [],
    status:      data.status      || {},
    draftDetail,
    scrapedAt:   new Date().toISOString(),
    source:      'live',
  };
}

async function getAllData() {
  // 1. Try Turso
  try {
    const turso = await getFromTurso();
    if (turso?.seasons?.length) {
      console.log(`[Data] Loaded ${turso.seasons.length} seasons from Turso`);
      return { ...turso, source: 'turso' };
    }
  } catch (e) {
    console.warn('[Data] Turso error:', e.message);
  }

  // 2. Try local file
  const file = getFromFile();
  if (file?.seasons?.length) {
    console.log(`[Data] Loaded ${file.seasons.length} seasons from file`);
    return { ...file, source: 'file' };
  }

  // 3. Fallback: live ESPN fetch (needs cookies for private leagues)
  console.log('[Data] No stored data — attempting live ESPN fetch');
  const SEASONS = ['2024', '2023', '2022', '2021'];
  const results = await Promise.allSettled(SEASONS.map(fetchSeasonLive));
  const seasons = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean)
    .sort((a, b) => b.season - a.season);

  if (!seasons.length) return null;
  return { seasons, source: 'live', updatedAt: new Date().toISOString() };
}

// Main API endpoint
app.get('/api/league', async (req, res) => {
  try {
    const data = await getAllData();
    if (!data) {
      return res.status(502).json({
        error: 'No data available',
        fix: 'Run scrape.js locally to populate data, then redeploy. See README for instructions.',
        hasFile:  fs.existsSync(DATA_FILE),
        hasTurso: !!(TURSO_URL && TURSO_TOKEN),
        hasCookies: !!(ESPN_S2 && SWID),
      });
    }
    res.json(data);
  } catch (err) {
    console.error('[API] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Status endpoint — tells you exactly what data sources are configured
app.get('/api/status', (req, res) => {
  res.json({
    leagueId:    LEAGUE_ID,
    hasFile:     fs.existsSync(DATA_FILE),
    hasTurso:    !!(TURSO_URL && TURSO_TOKEN),
    hasCookies:  !!(ESPN_S2 && SWID),
    fileAge:     fs.existsSync(DATA_FILE)
      ? Math.round((Date.now() - fs.statSync(DATA_FILE).mtimeMs) / 1000 / 60) + ' min ago'
      : null,
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`The League on port ${PORT} · League ${LEAGUE_ID}`);
  console.log(`Data sources: file=${fs.existsSync(DATA_FILE)} turso=${!!(TURSO_URL&&TURSO_TOKEN)} cookies=${!!(ESPN_S2&&SWID)}`);
});
