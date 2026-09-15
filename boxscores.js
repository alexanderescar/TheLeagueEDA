/**
 * boxscores.js — pulls per-player weekly scoring from ESPN and caches it.
 *
 * ESPN's mBoxscore view returns one scoring period at a time, so a full season is
 * one request per week. We cache what we've already fetched and only ask for weeks
 * that are (a) not cached and (b) actually complete, because a half-played week
 * would be cached with Sunday-afternoon numbers and never refreshed.
 *
 * Output: data/boxscores_<year>.json
 *   { year, weeks: { "1": { "<teamId>": { entries:[...], total, opponent, margin } } } }
 */

const fs   = require('fs');
const path = require('path');

const ESPN_API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const LEAGUE_ID = process.env.LEAGUE_ID || '119089';
const DATA_DIR = path.join(__dirname, 'data');

function espnHeaders() {
    const h = {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://fantasy.espn.com/',
        'Origin':  'https://fantasy.espn.com',
    };
    const s2 = process.env.ESPN_S2 || process.env.ESPN_2 || '';
    const swid = process.env.SWID || '';
    if (s2 && swid) h['Cookie'] = `espn_s2=${decodeURIComponent(s2)}; SWID=${swid}`;
    return h;
}

function outFile(year) { return path.join(DATA_DIR, `boxscores_${year}.json`); }

function readBoxscores(year) {
    try {
        const f = outFile(year);
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { return null; }
}

/** Which weeks are finished? A week counts only when every matchup has a score. */
function completedWeeks(season) {
    const total = {}, scored = {};
    ((season && season.schedule) || []).forEach(m => {
        if (!m || !m.home || !m.away || m.matchupPeriodId == null) return;
        const wk = m.matchupPeriodId;
        total[wk] = (total[wk] || 0) + 1;
        if ((m.home.totalPoints || 0) > 0 || (m.away.totalPoints || 0) > 0) {
            scored[wk] = (scored[wk] || 0) + 1;
        }
    });
    return Object.keys(total)
        .map(Number)
        .filter(wk => scored[wk] === total[wk])
        .sort((a, b) => a - b);
}

async function fetchWeek(year, week, log) {
    const url = `${ESPN_API}/seasons/${year}/segments/0/leagues/${LEAGUE_ID}`
              + `?view=mBoxscore&view=mMatchupScore&scoringPeriodId=${week}`;
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 25000);
    try {
        const res = await fetch(url, { headers: espnHeaders(), signal: ac.signal });
        if (!res.ok) { log(`    week ${week}: HTTP ${res.status}`); return null; }
        const text = await res.text();
        if (!text.trim() || text.trimStart().startsWith('<')) return null;
        let json = JSON.parse(text);
        if (Array.isArray(json)) json = json[0];

        const out = {};
        (json.schedule || []).forEach(m => {
            if (m.matchupPeriodId !== week || !m.home || !m.away) return;
            [[m.home, m.away], [m.away, m.home]].forEach(([side, opp]) => {
                const roster = side.rosterForCurrentScoringPeriod || side.rosterForMatchupPeriod || {};
                const entries = (roster.entries || []).map(e => {
                    const p = (e.playerPoolEntry || {}).player || {};
                    return {
                        playerId: e.playerId,
                        lineupSlotId: e.lineupSlotId,
                        name: p.fullName || `Player ${e.playerId}`,
                        posId: p.defaultPositionId,
                        pts: (e.playerPoolEntry || {}).appliedStatTotal || 0,
                        acquired: e.acquisitionType || null,
                    };
                });
                if (!entries.length) return;
                out[side.teamId] = {
                    entries,
                    total: side.totalPoints || 0,
                    opponent: opp.teamId,
                    margin: Math.round(((side.totalPoints || 0) - (opp.totalPoints || 0)) * 100) / 100,
                };
            });
        });
        return Object.keys(out).length ? out : null;
    } catch (e) {
        log(`    week ${week} failed: ${e.message}`);
        return null;
    } finally {
        clearTimeout(tid);
    }
}

/**
 * Fetch any completed weeks we don't already have.
 * Cached weeks are never re-fetched — a finished week's box score doesn't change.
 */
async function buildBoxscores(year, leagueData, log = console.log, opts = {}) {
    const data = leagueData || JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'league_data.json'), 'utf8'));
    const season = (data.seasons || []).find(s => Number(s.season) === Number(year));
    if (!season) throw new Error(`Season ${year} not in league data.`);

    const done = completedWeeks(season);
    if (!done.length) { log(`  ${year}: no completed weeks yet`); return { year: Number(year), weeks: {} }; }

    const existing = readBoxscores(year) || { year: Number(year), weeks: {} };
    const want = opts.force ? done : done.filter(wk => !existing.weeks[String(wk)]);
    log(`  ${year}: ${done.length} week(s) complete, ${want.length} to fetch`);

    for (const wk of want) {
        const got = await fetchWeek(Number(year), wk, log);
        if (got) {
            existing.weeks[String(wk)] = got;
            const n = Object.keys(got).length;
            const players = Object.values(got).reduce((a, t) => a + t.entries.length, 0);
            log(`  week ${wk}: ${n} teams, ${players} player lines`);
        }
        await new Promise(r => setTimeout(r, 400));
    }

    existing.year = Number(year);
    existing.builtAt = new Date().toISOString();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(outFile(year), JSON.stringify(existing));
    log(`  Saved data/boxscores_${year}.json (${Object.keys(existing.weeks).length} weeks)`);
    return existing;
}

/** Attach the cached boxscores onto the season so the frontend gets them. */
function annotateBoxscores(data) {
    if (!data || !Array.isArray(data.seasons)) return data;
    for (const season of data.seasons) {
        const bx = readBoxscores(season.season);
        if (bx && bx.weeks && Object.keys(bx.weeks).length) season.boxscores = bx.weeks;
    }
    return data;
}

if (require.main === module) {
    const year = process.argv[2] || new Date().getFullYear();
    buildBoxscores(year, null, console.log, { force: process.argv.indexOf('--force') > -1 })
        .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { buildBoxscores, readBoxscores, annotateBoxscores, completedWeeks, fetchWeek };
