#!/usr/bin/env node
/**
 * ESPN Fantasy Scraper
 * Run this locally (while logged into ESPN) to populate the database.
 *
 * Usage:
 *   ESPN_S2="your_espn_s2_cookie" SWID="{your-swid}" node scrape.js
 *
 * Or set them in a .env file (never commit .env to git).
 *
 * To get your cookies:
 *   1. Open https://fantasy.espn.com in Chrome
 *   2. Open DevTools (F12) → Application → Cookies → https://fantasy.espn.com
 *   3. Copy the value of `espn_s2` and `SWID`
 */

require('dotenv').config();
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

const LEAGUE_ID  = process.env.LEAGUE_ID  || '119089';
const ESPN_S2    = process.env.ESPN_S2    || '';
const SWID       = process.env.SWID       || '';
const SEASONS    = (process.env.SEASONS   || '2024,2023,2022,2021,2020').split(',').map(s => s.trim());

// Output path for local JSON backup (always written regardless of DB)
const OUT_FILE = path.join(__dirname, 'data', 'league_data.json');

if (!ESPN_S2 || !SWID) {
  console.error('\n❌  ESPN_S2 and SWID are required.\n');
  console.error('Get them from: ESPN Fantasy → DevTools → Application → Cookies → fantasy.espn.com\n');
  console.error('Then run:\n  ESPN_S2="..." SWID="{...}" node scrape.js\n');
  process.exit(1);
}

function espnHeaders() {
  return {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://fantasy.espn.com/',
    'Origin': 'https://fantasy.espn.com',
    'Cookie': `espn_s2=${ESPN_S2}; SWID=${SWID}`,
  };
}

async function fetchView(season, views) {
  const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${LEAGUE_ID}`;
  const url  = `${base}?${views.map(v => `view=${v}`).join('&')}`;

  const res = await fetch(url, { headers: espnHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ESPN ${res.status} for season ${season}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function scrapeSeason(season) {
  console.log(`\n📅  Scraping season ${season}...`);

  // Fetch main league data
  const main = await fetchView(season, ['mTeam', 'mStandings', 'mSettings', 'mSchedule']);

  if (!main.teams || main.teams.length === 0) {
    console.warn(`   ⚠️  No teams found for ${season} — skipping`);
    return null;
  }
  console.log(`   ✅  ${main.teams.length} teams, ${(main.schedule||[]).length} matchups`);

  // Fetch draft data separately
  let draftData = null;
  try {
    const draft = await fetchView(season, ['mDraftDetail']);
    draftData = draft.draftDetail || null;
    const picks = draftData?.picks?.length || 0;
    console.log(`   ✅  Draft: ${picks} picks`);
  } catch (e) {
    console.warn(`   ⚠️  Draft data unavailable for ${season}: ${e.message}`);
  }

  return {
    season: parseInt(season),
    settings:    main.settings    || {},
    teams:       main.teams       || [],
    schedule:    main.schedule    || [],
    status:      main.status      || {},
    draftDetail: draftData,
    scrapedAt:   new Date().toISOString(),
  };
}

async function main() {
  console.log('🏈  ESPN Fantasy Scraper');
  console.log(`   League: ${LEAGUE_ID}`);
  console.log(`   Seasons: ${SEASONS.join(', ')}`);
  console.log(`   Cookies: espn_s2=${ESPN_S2.slice(0,20)}... SWID=${SWID.slice(0,10)}...`);

  // Ensure output dir
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const allData = [];

  for (const season of SEASONS) {
    try {
      const data = await scrapeSeason(season);
      if (data) allData.push(data);
      // Polite delay between requests
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.error(`   ❌  Error scraping ${season}: ${err.message}`);
    }
  }

  if (allData.length === 0) {
    console.error('\n❌  No data scraped. Check your cookies and league ID.\n');
    process.exit(1);
  }

  // Sort newest first
  allData.sort((a, b) => b.season - a.season);

  // Write local JSON file
  fs.writeFileSync(OUT_FILE, JSON.stringify({ seasons: allData, updatedAt: new Date().toISOString() }, null, 2));
  console.log(`\n✅  Saved ${allData.length} seasons to ${OUT_FILE}`);

  // If Turso URL is configured, also write to DB
  const TURSO_URL   = process.env.TURSO_URL;
  const TURSO_TOKEN = process.env.TURSO_TOKEN;

  if (TURSO_URL && TURSO_TOKEN) {
    console.log('\n📤  Uploading to Turso...');
    try {
      const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

      await db.execute(`CREATE TABLE IF NOT EXISTS league_data (
        id        INTEGER PRIMARY KEY DEFAULT 1,
        data      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);

      await db.execute({
        sql: `INSERT OR REPLACE INTO league_data (id, data, updated_at) VALUES (1, ?, ?)`,
        args: [JSON.stringify({ seasons: allData }), new Date().toISOString()],
      });

      console.log('✅  Uploaded to Turso successfully');
    } catch (err) {
      console.error(`❌  Turso upload failed: ${err.message}`);
      console.log('   (Local JSON file is still good — you can use that instead)');
    }
  } else {
    console.log('\n💡  To use Turso (optional): set TURSO_URL and TURSO_TOKEN env vars');
    console.log('   The app will fall back to the local JSON file otherwise.');
  }

  console.log(`\n🎉  Done! Scraped ${allData.length} seasons:`);
  allData.forEach(s => {
    console.log(`   ${s.season}: ${s.teams.length} teams · ${s.schedule.length} matchups · draft: ${s.draftDetail?.picks?.length || '?'} picks`);
  });

  console.log('\nNext steps:');
  console.log('  1. Commit data/league_data.json to your repo (or set up Turso)');
  console.log('  2. Deploy to Railway — the app will serve from stored data');
  console.log('  3. Re-run scrape.js weekly during the season to refresh\n');
}

main();
