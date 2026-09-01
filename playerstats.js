/**
 * playerstats.js — preseason projections + actual season points for every drafted player.
 *
 * ESPN only exposes player projection/actual data from 2018 onward (404 before that),
 * so draft grades cover 2018-2025 only.
 *
 * Source endpoint is the public "leaguedefaults/3" player pool, which scores in FULL PPR.
 * The League is HALF PPR (0.5/reception since 2017), so every total is corrected by
 * subtracting 0.5 x receptions (statId 53), which ESPN includes in both the actual and
 * projected stat maps. That yields points in the league's own scoring system.
 *
 * Output: data/player_stats.json
 *   { "2019": { "3116406": { "proj": 250.1, "act": 300.2, "rank": 12 }, ... }, ... }
 */

const fs   = require('fs');
const path = require('path');

const ESPN_API   = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const DATA_FILE  = path.join(__dirname, 'data', 'league_data.json');
const OUT_FILE   = path.join(__dirname, 'data', 'player_stats.json');
const FIRST_YEAR = 2018;                 // ESPN 404s before this
const CHUNK      = 100;                  // player ids per request
const RECEPTION_STAT = '53';
const LEAGUE_PPR = 0.5;                  // The League's points per reception
const SOURCE_PPR = 1.0;                  // leaguedefaults/3 is full PPR

function headers(filter) {
    const h = {
        'Accept':           'application/json',
        'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer':          'https://fantasy.espn.com/',
        'Origin':           'https://fantasy.espn.com',
        'X-Fantasy-Filter': JSON.stringify(filter),
    };
    const s2   = process.env.ESPN_S2 || process.env.ESPN_2 || '';
    const swid = process.env.SWID || '';
    if (s2 && swid) h['Cookie'] = `espn_s2=${decodeURIComponent(s2)}; SWID=${swid}`;
    return h;
}

/** Convert a full-PPR stat row to the league's half-PPR scoring. */
function toLeaguePoints(row) {
    if (!row) return null;
    const total = row.appliedTotal;
    if (typeof total !== 'number') return null;
    const receptions = Number((row.stats || {})[RECEPTION_STAT]) || 0;
    const adjusted = total - (SOURCE_PPR - LEAGUE_PPR) * receptions;
    return Math.round(adjusted * 10) / 10;
}

async function fetchChunk(year, ids, log) {
    const url = `${ESPN_API}/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;
    // NOTE: filterIds must NOT be combined with `limit` — ESPN returns 400 if it is.
    const filter = { players: { filterIds: { value: ids } } };
    const ac  = new AbortController();
    const tid = setTimeout(() => ac.abort(), 25000);
    try {
        const res = await fetch(url, { headers: headers(filter), signal: ac.signal });
        if (!res.ok) { log(`    HTTP ${res.status} on a chunk of ${ids.length}`); return {}; }
        const text = await res.text();
        if (!text.trim() || text.trimStart().startsWith('<')) return {};
        let json = JSON.parse(text);
        if (Array.isArray(json)) json = json[0];

        const out = {};
        for (const entry of (json.players || [])) {
            const p = entry.player || {};
            if (p.id == null) continue;
            const rows = (p.stats || []).filter(s =>
                s.statSplitTypeId === 0 &&      // full season, not split
                s.scoringPeriodId === 0 &&      // season total, not a single week
                Number(s.seasonId) === year     // guard against other years leaking in
            );
            const act  = toLeaguePoints(rows.find(s => s.statSourceId === 0));
            const proj = toLeaguePoints(rows.find(s => s.statSourceId === 1));
            const rank = ((p.draftRanksByRankType || {}).PPR || {}).rank;
            const rec = {};
            if (act  != null && act  !== 0) rec.act  = act;
            if (proj != null && proj !== 0) rec.proj = proj;
            if (rank) rec.rank = rank;
            if (Object.keys(rec).length) out[p.id] = rec;
        }
        return out;
    } catch (e) {
        log(`    chunk failed: ${e.message}`);
        return {};
    } finally {
        clearTimeout(tid);
    }
}

/** Collect the unique playerIds drafted in a given season. */
function draftedIds(season) {
    const picks = ((season || {}).draftDetail || {}).picks || [];
    return [...new Set(picks.map(p => p.playerId).filter(id => id != null))];
}

async function buildPlayerStats(leagueData, log = console.log) {
    const data = leagueData || (fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : null);
    if (!data || !Array.isArray(data.seasons)) throw new Error('No league data to read drafts from.');

    const result  = {};
    const summary = [];

    for (const season of data.seasons.slice().sort((a, b) => b.season - a.season)) {
        const year = Number(season.season);
        if (year < FIRST_YEAR) continue;

        const ids = draftedIds(season);
        if (!ids.length) { log(`  ${year}: no draft picks on file — skipped`); continue; }

        log(`  ${year}: requesting ${ids.length} drafted players...`);
        const map = {};
        for (let i = 0; i < ids.length; i += CHUNK) {
            Object.assign(map, await fetchChunk(year, ids.slice(i, i + CHUNK), log));
            await new Promise(r => setTimeout(r, 350));
        }

        const withProj = Object.values(map).filter(v => v.proj != null).length;
        const withAct  = Object.values(map).filter(v => v.act  != null).length;
        const withRank = Object.values(map).filter(v => v.rank != null).length;
        result[year] = map;
        summary.push({ year, drafted: ids.length, matched: Object.keys(map).length, withProj, withAct, withRank });
        log(`  ${year}: matched ${Object.keys(map).length}/${ids.length} · proj ${withProj} · actual ${withAct} · rank ${withRank}`);
    }

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({ players: result, summary, builtAt: new Date().toISOString() }));
    log(`\nSaved ${Object.keys(result).length} seasons of player stats.`);
    return { players: result, summary };
}

function readPlayerStats() {
    try {
        if (!fs.existsSync(OUT_FILE)) return null;
        return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    } catch { return null; }
}

/** Attach proj/act/rank onto each draft pick so the frontend gets it for free. */
function annotateDraftStats(data) {
    if (!data || !Array.isArray(data.seasons)) return data;
    const store = readPlayerStats();
    if (!store || !store.players) return data;
    for (const season of data.seasons) {
        const map = store.players[season.season];
        if (!map) continue;
        const picks = ((season.draftDetail || {}).picks) || [];
        for (const pick of picks) {
            const rec = map[pick.playerId];
            if (!rec) continue;
            if (rec.proj != null) pick.projPoints   = rec.proj;
            if (rec.act  != null) pick.actualPoints = rec.act;
            if (rec.rank != null) pick.preDraftRank = rec.rank;
        }
    }
    return data;
}

if (require.main === module) {
    buildPlayerStats(null, console.log).catch(err => { console.error('\n' + err.message); process.exit(1); });
}

module.exports = { buildPlayerStats, readPlayerStats, annotateDraftStats, toLeaguePoints, FIRST_YEAR };
