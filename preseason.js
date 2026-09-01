/**
 * preseason.js — draft-day data for the current season.
 *
 * Pulls two independent views of every drafted player and matches them up:
 *
 *   ESPN         projected points (corrected to the league's half PPR), pre-draft
 *                rank, and auction value. This is what people actually saw on
 *                their screen while drafting.
 *
 *   FantasyPros  expert consensus rankings for HALF PPR — the league's exact
 *                scoring — pooled from ~100 experts, plus tier, positional rank,
 *                expert disagreement (rank_std), ADP, strength-of-schedule stars
 *                and bye week.
 *
 * FantasyPros has no free API for this, but ecrData is embedded in the page HTML,
 * so one fetch per refresh is enough. We cache the result rather than hitting them
 * per page load.
 *
 * Output: data/preseason_<year>.json
 */

const fs   = require('fs');
const path = require('path');

const ESPN_API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const FP_URL   = 'https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php';
const DATA_DIR = path.join(__dirname, 'data');
const RECEPTION_STAT = '53';
const LEAGUE_PPR = 0.5;
const SOURCE_PPR = 1.0;

const NFL_TEAMS = {
    ARI:'Cardinals', ATL:'Falcons', BAL:'Ravens', BUF:'Bills', CAR:'Panthers',
    CHI:'Bears', CIN:'Bengals', CLE:'Browns', DAL:'Cowboys', DEN:'Broncos',
    DET:'Lions', GB:'Packers', HOU:'Texans', IND:'Colts', JAC:'Jaguars',
    JAX:'Jaguars', KC:'Chiefs', LAC:'Chargers', LAR:'Rams', LV:'Raiders',
    MIA:'Dolphins', MIN:'Vikings', NE:'Patriots', NO:'Saints', NYG:'Giants',
    NYJ:'Jets', PHI:'Eagles', PIT:'Steelers', SEA:'Seahawks', SF:'49ers',
    TB:'Buccaneers', TEN:'Titans', WAS:'Commanders', WSH:'Commanders',
};

function espnHeaders(filter) {
    const h = {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://fantasy.espn.com/',
        'Origin':  'https://fantasy.espn.com',
    };
    if (filter) h['X-Fantasy-Filter'] = JSON.stringify(filter);
    const s2 = process.env.ESPN_S2 || process.env.ESPN_2 || '';
    const swid = process.env.SWID || '';
    if (s2 && swid) h['Cookie'] = `espn_s2=${decodeURIComponent(s2)}; SWID=${swid}`;
    return h;
}

/**
 * Normalise a player name for cross-source matching.
 * Handles the usual suspects: punctuation, suffixes, and D/ST naming, where ESPN
 * says "Ravens D/ST" and FantasyPros says "Baltimore Ravens".
 */
function normName(name, pos) {
    if (!name) return '';
    let s = String(name).toLowerCase();
    if (String(pos || '').toUpperCase().replace(/[^A-Z]/g, '') === 'DST') {
        // Reduce both spellings to the nickname, which is the only shared token.
        s = s.replace(/d\/st|dst|defense|special teams/g, ' ');
        const words = s.trim().split(/\s+/).filter(Boolean);
        return words.length ? words[words.length - 1] : '';
    }
    return s
        .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
        .replace(/\./g, '').replace(/'/g, '').replace(/-/g, ' ')
        .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
        .replace(/[^a-z\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function toLeaguePoints(row) {
    if (!row || typeof row.appliedTotal !== 'number') return null;
    const rec = Number((row.stats || {})[RECEPTION_STAT]) || 0;
    return Math.round((row.appliedTotal - (SOURCE_PPR - LEAGUE_PPR) * rec) * 10) / 10;
}

/** ESPN player pool for one season, keyed by playerId. */
async function fetchEspnPool(year, ids, log) {
    const url = `${ESPN_API}/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;
    const out = {};
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const filter = { players: { filterIds: { value: ids.slice(i, i + CHUNK) } } };
        try {
            const ac = new AbortController();
            const tid = setTimeout(() => ac.abort(), 25000);
            const res = await fetch(url, { headers: espnHeaders(filter), signal: ac.signal });
            clearTimeout(tid);
            if (!res.ok) { log(`    ESPN HTTP ${res.status}`); continue; }
            let json = JSON.parse(await res.text());
            if (Array.isArray(json)) json = json[0];
            for (const entry of (json.players || [])) {
                const p = entry.player || {};
                if (p.id == null) continue;
                const rows = (p.stats || []).filter(s =>
                    s.statSplitTypeId === 0 && s.scoringPeriodId === 0 && Number(s.seasonId) === year);
                const ranks = (p.draftRanksByRankType || {}).PPR || {};
                out[p.id] = {
                    name: p.fullName,
                    proj: toLeaguePoints(rows.find(s => s.statSourceId === 1)),
                    act:  toLeaguePoints(rows.find(s => s.statSourceId === 0)),
                    rank: ranks.rank || null,
                    auction: ranks.auctionValue || null,
                };
            }
        } catch (e) { log(`    ESPN chunk failed: ${e.message}`); }
        await new Promise(r => setTimeout(r, 300));
    }
    return out;
}

/** FantasyPros expert consensus, scraped once from the embedded ecrData blob. */
async function fetchFantasyPros(log) {
    try {
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 30000);
        const res = await fetch(FP_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: ac.signal,
        });
        clearTimeout(tid);
        if (!res.ok) { log(`  FantasyPros HTTP ${res.status} — continuing with ESPN only`); return null; }
        const html = await res.text();

        const at = html.indexOf('ecrData');
        if (at === -1) { log('  FantasyPros: ecrData not found — page layout may have changed'); return null; }
        const brace = html.indexOf('{', at);
        if (brace === -1) return null;

        // Walk the braces to find the end of the JSON object.
        let depth = 0, end = -1, inStr = false, esc = false;
        for (let i = brace; i < html.length; i++) {
            const c = html[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end === -1) { log('  FantasyPros: could not parse ecrData'); return null; }

        const data = JSON.parse(html.slice(brace, end));
        const players = data.players || [];
        log(`  FantasyPros: ${players.length} players (${data.scoring} scoring, ${data.total_experts} experts, ${data.year})`);

        const map = {};
        for (const p of players) {
            const pos = p.player_position_id;
            const key = normName(p.player_name, pos);
            if (!key) continue;
            map[key] = {
                name: p.player_name,
                pos,
                team: p.player_team_id,
                ecr:  Number(p.rank_ecr) || null,
                best: Number(p.rank_min) || null,
                worst:Number(p.rank_max) || null,
                std:  Number(p.rank_std) || null,
                tier: Number(p.tier) || null,
                posRank: p.pos_rank || null,
                adp:  Number(p.rank_adp) || null,
                vsAdp: Number(p.ecr_vs_adp) || 0,
                bye:  Number(p.player_bye_week) || null,
                sos:  p.sos_stars || null,
            };
        }
        return { map, experts: data.total_experts, scoring: data.scoring, year: data.year };
    } catch (e) {
        log(`  FantasyPros failed: ${e.message} — continuing with ESPN only`);
        return null;
    }
}

async function buildPreseason(year, leagueData, log = console.log) {
    const data = leagueData || JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'league_data.json'), 'utf8'));
    const season = (data.seasons || []).find(s => Number(s.season) === Number(year));
    if (!season) throw new Error(`Season ${year} not found in league data — run a scrape first.`);

    const picks = ((season.draftDetail || {}).picks) || [];
    if (!picks.length) throw new Error(`Season ${year} has no draft picks yet.`);
    log(`  ${year}: ${picks.length} picks on the board`);

    const ids = [...new Set(picks.map(p => p.playerId).filter(x => x != null))];
    log(`  Fetching ESPN projections for ${ids.length} players...`);
    const espn = await fetchEspnPool(Number(year), ids, log);
    log(`  ESPN: matched ${Object.keys(espn).length}/${ids.length}`);

    log('  Fetching FantasyPros expert consensus...');
    const fp = await fetchFantasyPros(log);

    let fpHits = 0;
    const players = {};
    for (const pick of picks) {
        const e = espn[pick.playerId] || {};
        const name = e.name || pick.playerName;
        const pos  = pick.playerPosition;
        let f = null;
        if (fp) {
            f = fp.map[normName(name, pos)] || null;
            if (!f) {
                // Second pass: FantasyPros lists defenses by city, ESPN by nickname.
                const alt = normName(name, pos) || '';
                if (alt) f = fp.map[alt] || null;
            }
            if (f) fpHits++;
        }
        players[pick.playerId] = {
            name, pos,
            espnProj: e.proj != null ? e.proj : null,
            espnRank: e.rank || null,
            auction:  e.auction || null,
            fpEcr:  f ? f.ecr  : null,
            fpTier: f ? f.tier : null,
            fpStd:  f ? f.std  : null,
            fpPosRank: f ? f.posRank : null,
            fpAdp:  f ? f.adp  : null,
            fpVsAdp: f ? f.vsAdp : null,
            bye:    f ? f.bye  : null,
            sos:    f ? f.sos  : null,
            nflTeam: f ? f.team : null,
        };
    }

    const withProj = Object.values(players).filter(p => p.espnProj != null).length;
    const withEcr  = Object.values(players).filter(p => p.fpEcr != null).length;
    log(`  Coverage: ESPN projections ${withProj}/${picks.length} · FantasyPros ECR ${withEcr}/${picks.length}`);

    const payload = {
        year: Number(year),
        players,
        sources: {
            espn: { matched: Object.keys(espn).length, of: ids.length },
            fantasyPros: fp
                ? { matched: fpHits, of: picks.length, experts: fp.experts, scoring: fp.scoring, year: fp.year }
                : null,
        },
        builtAt: new Date().toISOString(),
    };

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `preseason_${year}.json`), JSON.stringify(payload));
    log(`  Saved data/preseason_${year}.json`);
    return payload;
}

function readPreseason(year) {
    try {
        const f = path.join(DATA_DIR, `preseason_${year}.json`);
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { return null; }
}

/** Attach preseason data onto the current season's picks. */
function annotatePreseason(data) {
    if (!data || !Array.isArray(data.seasons)) return data;
    for (const season of data.seasons) {
        const pre = readPreseason(season.season);
        if (!pre || !pre.players) continue;
        season.preseasonSources = pre.sources;
        const picks = ((season.draftDetail || {}).picks) || [];
        for (const pick of picks) {
            const rec = pre.players[pick.playerId];
            if (!rec) continue;
            if (rec.espnProj != null) pick.projPoints = rec.espnProj;
            if (rec.espnRank != null) pick.preDraftRank = rec.espnRank;
            pick.auction   = rec.auction;
            pick.fpEcr     = rec.fpEcr;
            pick.fpTier    = rec.fpTier;
            pick.fpStd     = rec.fpStd;
            pick.fpPosRank = rec.fpPosRank;
            pick.fpAdp     = rec.fpAdp;
            pick.fpVsAdp   = rec.fpVsAdp;
            pick.bye       = rec.bye;
            pick.sos       = rec.sos;
            pick.nflTeam   = rec.nflTeam;
        }
    }
    return data;
}

if (require.main === module) {
    const year = process.argv[2] || new Date().getFullYear();
    buildPreseason(year, null, console.log).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { buildPreseason, readPreseason, annotatePreseason, normName, toLeaguePoints, NFL_TEAMS };
