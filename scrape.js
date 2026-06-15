#!/usr/bin/env node
/**
   * ESPN Fantasy Scraper — full historical data with player names & real team names
   * - Uses lm-api-reads.fantasy.espn.com (server-side friendly, no geo-block)
   * - Fetches player name/position lookup per season from ESPN players API
   * - Enriches draft picks with playerName + playerPosition at scrape time
   * - Scrapes 2011–2025 by default, skips any seasons that 404
   */

const fs   = require('fs');
const path = require('path');

const LEAGUE_ID   = process.env.LEAGUE_ID || '119089';
const ESPN_S2_RAW = process.env.ESPN_S2 || process.env.ESPN_2 || '';
const ESPN_S2     = ESPN_S2_RAW ? decodeURIComponent(ESPN_S2_RAW) : '';
const SWID        = process.env.SWID || '';
// Default: all seasons 2011-2025; override with SEASONS env var
const SEASONS = (process.env.SEASONS || '2025,2024,2023,2022,2021,2020,2019,2018,2017,2016,2015,2014,2013,2012,2011').split(',').map(s => s.trim());
const OUT_FILE = path.join(__dirname, 'data', 'league_data.json');

const ESPN_API   = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

// ESPN position ID → position abbreviation
const POSITION_MAP = { 1:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'K', 16:'D/ST' };

// ESPN lineup slot ID → slot label (for display)
const SLOT_MAP = { 0:'QB', 2:'RB', 4:'WR', 6:'TE', 16:'D/ST', 17:'K', 20:'Bench', 21:'IR', 23:'FLEX' };

function espnHeaders() {
    const h = {
          'Accept':           'application/json',
          'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer':          'https://fantasy.espn.com/',
          'Origin':           'https://fantasy.espn.com',
          'X-Fantasy-Filter': '{}',
    };
    if (ESPN_S2 && SWID) h['Cookie'] = `espn_s2=${ESPN_S2}; SWID=${SWID}`;
    return h;
}

async function fetchView(season, views) {
    const base = `${ESPN_API}/seasons/${season}/segments/0/leagues/${LEAGUE_ID}`;
    const url  = `${base}?${views.map(v => `view=${v}`).join('&')}`;
    const res  = await fetch(url, { headers: espnHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ESPN ${res.status} for season ${season}`);
    const text = await res.text();
    if (!text.trim() || text.trimStart().startsWith('<')) return null;
    return JSON.parse(text);
}

// Fetch player id→{name,position} map for a season using the players_wl endpoint
async function fetchPlayerMap(season, log) {
    const url = `${ESPN_API}/seasons/${season}/players?scoringPeriodId=0&view=players_wl`;
    try {
          const res = await fetch(url, { headers: espnHeaders() });
          if (!res.ok) return {};
          const text = await res.text();
          if (!text.trim() || text.trimStart().startsWith('<')) return {};
          const players = JSON.parse(text);
          const map = {};
          if (Array.isArray(players)) {
                  for (const p of players) {
                            if (p.id) {
                                        map[p.id] = {
                                                      name:     p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
                                                      position: POSITION_MAP[p.defaultPositionId] || `Pos${p.defaultPositionId}`,
                                        };
                            }
                  }
          }
          log(`  ✓ Loaded ${Object.keys(map).length} players for ${season}`);
          return map;
    } catch (e) {
          log(`  ⚠️  Could not load player map for ${season}: ${e.message}`);
          return {};
    }
}

async function scrapeSeason(season, log) {
    log(`  Scraping ${season}...`);

  const main = await fetchView(season, ['mTeam', 'mStandings', 'mSettings', 'mSchedule']);
    if (!main || !main.teams?.length) {
          log(`  ⚠️  No data for ${season} — skipping`);
          return null;
    }

  // Build teamId → team name map using the real team names from the API
  const teamMap = {};
    for (const t of main.teams) {
          teamMap[t.id] = t.name || t.abbrev || `Team ${t.id}`;
    }

  log(`  ✓ ${season}: ${main.teams.length} teams, ${(main.schedule||[]).length} matchups`);

  // Fetch player name map for this season
  const playerMap = await fetchPlayerMap(season, log);

  // Fetch draft data
  let draftDetail = null;
    try {
          const draftData = await fetchView(season, ['mDraftDetail']);
          if (draftData?.draftDetail) {
                  draftDetail = draftData.draftDetail;
                  // Enrich picks with player name, position, team name, and slot label
            if (draftDetail.picks) {
                      draftDetail.picks = draftDetail.picks.map(pick => {
                                  const player = playerMap[pick.playerId] || {};
                                  return {
                                                ...pick,
                                                playerName:     player.name     || `Player ${pick.playerId}`,
                                                playerPosition: player.position || SLOT_MAP[pick.lineupSlotId] || `Slot${pick.lineupSlotId}`,
                                                teamName:       teamMap[pick.teamId] || `Team ${pick.teamId}`,
                                  };
                      });
            }
                  log(`  ✓ ${season} draft: ${draftDetail.picks?.length || 0} picks enriched`);
          }
    } catch (e) {
          log(`  ⚠️  Draft unavailable for ${season}: ${e.message}`);
    }

  return {
        season:     parseInt(season),
        settings:   main.settings   || {},
        teams:      main.teams      || [],
        schedule:   main.schedule   || [],
        status:     main.status     || {},
        draftDetail,
        scrapedAt: new Date().toISOString(),
  };
}

async function runScrape(log = console.log) {
    log(`🏈 Scraping The League (ID: ${LEAGUE_ID})`);
    log(`   Seasons: ${SEASONS.join(', ')}`);
    log(`   API: ${ESPN_API}`);
    if (ESPN_S2) log(`   Auth: cookies set (decoded)`);
    else         log(`   Auth: none (public seasons only)`);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const allData = [];
    for (const season of SEASONS) {
          try {
                  const data = await scrapeSeason(season, log);
                  if (data) allData.push(data);
                  await new Promise(r => setTimeout(r, 700)); // polite delay
          } catch (err) {
                  log(`  ❌ ${season}: ${err.message}`);
          }
    }

  if (allData.length === 0) {
        throw new Error('No data scraped — check league accessibility.');
  }

  allData.sort((a, b) => b.season - a.season);
    const payload = { seasons: allData, updatedAt: new Date().toISOString() };
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));

  log(`\n✅ Saved ${allData.length} seasons to data/league_data.json`);
    allData.forEach(s => {
          const picks = s.draftDetail?.picks?.length || '?';
          const sample = s.draftDetail?.picks?.[0];
          log(`   ${s.season}: ${s.teams.length} teams · ${s.schedule.length} matchups · ${picks} draft picks${sample ? ` (e.g. "${sample.playerName}" - ${sample.playerPosition})` : ''}`);
    });

  return payload;
}

if (require.main === module) {
    runScrape().catch(err => { console.error('\n❌', err.message); process.exit(1); });
}

module.exports = { runScrape };
