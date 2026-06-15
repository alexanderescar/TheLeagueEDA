#!/usr/bin/env node
/**
   * ESPN Fantasy Scraper — no dotenv dependency, callable as module or CLI
   * Handles ESPN_S2 or ESPN_2 env var name (Railway typo-tolerant)
   *
   * CLI:  node scrape.js
   * Module: const { runScrape } = require('./scrape'); await runScrape(log);
   */

const fs = require('fs');
const path = require('path');

const LEAGUE_ID = process.env.LEAGUE_ID || '119089';
// Accept ESPN_S2 or ESPN_2 (common Railway typo)
const ESPN_S2   = process.env.ESPN_S2 || process.env.ESPN_2 || '';
const SWID      = process.env.SWID || '';
const SEASONS   = (process.env.SEASONS || '2024,2023,2022,2021,2020').split(',').map(s => s.trim());
const OUT_FILE  = path.join(__dirname, 'data', 'league_data.json');

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
    const res  = await fetch(url, { headers: espnHeaders() });
    if (!res.ok) {
          const body = await res.text();
          throw new Error(`ESPN ${res.status} for season ${season}: ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    // Detect HTML login redirect
  if (text.trimStart().startsWith('<')) {
        throw new Error(`ESPN returned HTML for season ${season} — cookies are expired or invalid`);
  }
    return JSON.parse(text);
}

async function scrapeSeason(season, log) {
    log(`  Scraping ${season}...`);
    const main = await fetchView(season, ['mTeam', 'mStandings', 'mSettings', 'mSchedule']);
    if (!main.teams || main.teams.length === 0) {
          log(`  ⚠️  No teams found for ${season} — skipping`);
          return null;
    }
    log(`  ✓ ${season}: ${main.teams.length} teams, ${(main.schedule||[]).length} matchups`);

  let draftDetail = null;
    try {
          const draft = await fetchView(season, ['mDraftDetail']);
          draftDetail = draft.draftDetail || null;
          log(`  ✓ ${season} draft: ${draftDetail?.picks?.length || 0} picks`);
    } catch (e) {
          log(`  ⚠️  Draft unavailable for ${season}: ${e.message}`);
    }

  return {
        season: parseInt(season),
        settings:    main.settings    || {},
        teams:       main.teams       || [],
        schedule:    main.schedule    || [],
        status:      main.status      || {},
        draftDetail,
        scrapedAt: new Date().toISOString(),
  };
}

async function runScrape(log = console.log) {
    if (!ESPN_S2 || !SWID) {
          throw new Error('ESPN_S2 (or ESPN_2) and SWID env vars are required');
    }

  log(`🏈 Scraping The League (ID: ${LEAGUE_ID})`);
    log(`   Seasons: ${SEASONS.join(', ')}`);
    log(`   Cookie check: espn_s2=${ESPN_S2.slice(0,15)}...`);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const allData = [];
    for (const season of SEASONS) {
          try {
                  const data = await scrapeSeason(season, log);
                  if (data) allData.push(data);
                  await new Promise(r => setTimeout(r, 600));
          } catch (err) {
                  log(`  ❌ ${season}: ${err.message}`);
          }
    }

  if (allData.length === 0) {
        throw new Error('No data scraped — cookies are likely expired. Get fresh ones from ESPN DevTools.');
  }

  allData.sort((a, b) => b.season - a.season);
    const payload = { seasons: allData, updatedAt: new Date().toISOString() };
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));

  log(`\n✅ Saved ${allData.length} seasons to data/league_data.json`);
    allData.forEach(s => {
          log(`   ${s.season}: ${s.teams.length} teams · ${s.schedule.length} matchups · ${s.draftDetail?.picks?.length || '?'} draft picks`);
    });

  return payload;
}

// Run as CLI
if (require.main === module) {
    runScrape().catch(err => {
          console.error('\n❌', err.message);
          process.exit(1);
    });
}

module.exports = { runScrape };
