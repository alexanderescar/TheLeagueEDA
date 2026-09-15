/**
 * brief.js — the packet Claude writes each week's blurbs from.
 *
 * The rule the commentary has to satisfy: by Week 7 it should know everything that
 * happened in Weeks 1-6. A blurb that only sees the current week produces the same
 * shape of sentence every time and reads like a form letter. So every team's entry
 * carries three layers:
 *
 *   week     what just happened — score, opponent, start/sit calls, heroes, zeros
 *   season   everything to date — record, all-play, bench waste, repeat mistakes,
 *            how their draft picks are actually doing, who they have beaten
 *   history  all 16 seasons — lifetime head-to-head, personal bests, league records
 *
 * Nothing here is written prose. It is facts with enough context attached that the
 * writer can tell a 30-point bench mistake in a blowout win (funny) from the same
 * mistake in a three-point loss (a eulogy), and can spot the third time someone has
 * benched the same player.
 */

const fs   = require('fs');
const path = require('path');
const BX   = require('./public/boxscore.js');

const DATA_DIR = path.join(__dirname, 'data');

function round(n, d) {
    if (n == null || !isFinite(n)) return null;
    const m = Math.pow(10, d == null ? 2 : d);
    return Math.round(n * m) / m;
}

function completedWeeks(season) {
    const total = {}, scored = {};
    ((season && season.schedule) || []).forEach(m => {
        if (!m || !m.home || !m.away || m.matchupPeriodId == null) return;
        const wk = m.matchupPeriodId;
        total[wk] = (total[wk] || 0) + 1;
        if ((m.home.totalPoints || 0) > 0 || (m.away.totalPoints || 0) > 0) scored[wk] = (scored[wk] || 0) + 1;
    });
    return Object.keys(total).map(Number).filter(wk => scored[wk] === total[wk]).sort((a, b) => a - b);
}

/** Manager label for a team, falling back to the team name. */
function mgrOf(t) {
    return (t && (t.managerNick || t.managerName)) || (t && t.name) || ('Team ' + (t && t.id));
}

/** Every team's weekly score across a season, keyed by teamId. */
function weeklyScores(season, throughWeek) {
    const out = {};
    ((season && season.schedule) || []).forEach(m => {
        if (!m.home || !m.away) return;
        const wk = m.matchupPeriodId;
        if (throughWeek != null && wk > throughWeek) return;
        const hp = m.home.totalPoints || 0, ap = m.away.totalPoints || 0;
        if (hp <= 0 && ap <= 0) return;
        (out[m.home.teamId] = out[m.home.teamId] || []).push({ week: wk, pts: hp, opp: m.away.teamId, oppPts: ap });
        (out[m.away.teamId] = out[m.away.teamId] || []).push({ week: wk, pts: ap, opp: m.home.teamId, oppPts: hp });
    });
    Object.keys(out).forEach(k => out[k].sort((a, b) => a.week - b.week));
    return out;
}

/** All-play record through a given week. */
function allPlay(weekly, throughWeek) {
    const ids = Object.keys(weekly);
    const out = {};
    ids.forEach(id => { out[id] = { w: 0, l: 0, t: 0 }; });
    const weeks = {};
    ids.forEach(id => weekly[id].forEach(g => {
        if (throughWeek != null && g.week > throughWeek) return;
        (weeks[g.week] = weeks[g.week] || []).push({ id, pts: g.pts });
    }));
    Object.keys(weeks).forEach(wk => {
        const rows = weeks[wk];
        rows.forEach(a => rows.forEach(b => {
            if (a.id === b.id) return;
            if (a.pts > b.pts) out[a.id].w++;
            else if (a.pts < b.pts) out[a.id].l++;
            else out[a.id].t++;
        }));
    });
    return out;
}

/** Lifetime head-to-head between two managers across every season on file. */
function lifetimeH2H(allSeasons, aKey, bKey) {
    let w = 0, l = 0, aPts = 0, bPts = 0, meetings = [];
    allSeasons.forEach(s => {
        const byId = {};
        (s.teams || []).forEach(t => { byId[t.id] = t; });
        (s.schedule || []).forEach(m => {
            if (!m.home || !m.away) return;
            const hp = m.home.totalPoints || 0, ap = m.away.totalPoints || 0;
            if (hp <= 0 && ap <= 0) return;
            const ht = byId[m.home.teamId], at = byId[m.away.teamId];
            if (!ht || !at) return;
            const hk = ht.managerKey, ak = at.managerKey;
            let mine, theirs;
            if (hk === aKey && ak === bKey) { mine = hp; theirs = ap; }
            else if (hk === bKey && ak === aKey) { mine = ap; theirs = hp; }
            else return;
            if (mine > theirs) w++; else if (mine < theirs) l++;
            aPts += mine; bPts += theirs;
            meetings.push({ season: s.season, week: m.matchupPeriodId, mine: round(mine, 1), theirs: round(theirs, 1) });
        });
    });
    meetings.sort((x, y) => (y.season - x.season) || (y.week - x.week));
    return {
        wins: w, losses: l, meetings: meetings.length,
        pointsFor: round(aPts, 1), pointsAgainst: round(bPts, 1),
        recent: meetings.slice(0, 3),
    };
}

/** Where a score ranks against every week this manager has ever played. */
function scoreContext(allSeasons, mgrKey, pts) {
    const all = [];
    allSeasons.forEach(s => {
        const byId = {};
        (s.teams || []).forEach(t => { byId[t.id] = t; });
        (s.schedule || []).forEach(m => {
            if (!m.home || !m.away) return;
            [[m.home, m.away], [m.away, m.home]].forEach(([side]) => {
                const t = byId[side.teamId];
                if (!t || t.managerKey !== mgrKey) return;
                const p = side.totalPoints || 0;
                if (p > 0) all.push({ season: s.season, week: m.matchupPeriodId, pts: p });
            });
        });
    });
    if (!all.length) return null;
    all.sort((a, b) => b.pts - a.pts);
    const better = all.filter(x => x.pts > pts).length;
    return {
        careerGames: all.length,
        rankAmongOwn: better + 1,
        careerBest: { pts: round(all[0].pts, 1), season: all[0].season, week: all[0].week },
        careerWorst: { pts: round(all[all.length - 1].pts, 1), season: all[all.length - 1].season, week: all[all.length - 1].week },
        isPersonalBest: better === 0,
        isPersonalWorst: all[all.length - 1].pts === pts,
    };
}

/**
 * Build the brief for one week.
 * Returns { year, week, teams: [...] }.
 */
function buildBrief(data, year, week) {
    const seasons = (data.seasons || []).slice().sort((a, b) => b.season - a.season);
    const season = seasons.find(s => Number(s.season) === Number(year));
    if (!season) throw new Error(`Season ${year} not found.`);

    const done = completedWeeks(season);
    const wk = week != null ? Number(week) : (done.length ? done[done.length - 1] : 0);
    if (!wk) throw new Error('No completed weeks yet.');

    const boxWeeks = season.boxscores || {};
    const byId = {};
    (season.teams || []).forEach(t => { byId[t.id] = t; });

    const weekly = weeklyScores(season, wk);
    const ap = allPlay(weekly, wk);

    // Which players each team drafted, so "waiver pickup" is derived from the draft
    // board rather than an ESPN field that comes back null in the boxscore view.
    const draftedBy = {};
    (((season.draftDetail || {}).picks) || []).forEach(p => {
        (draftedBy[p.teamId] = draftedBy[p.teamId] || {})[p.playerId] = p.overallPickNumber;
    });

    // Season-to-date box facts for every week we have, for cumulative context.
    const perWeekBox = {};
    Object.keys(boxWeeks).forEach(w => {
        if (Number(w) > wk) return;
        perWeekBox[w] = Object.keys(boxWeeks[w]).map(tid => {
            const rec = boxWeeks[w][tid];
            const entries = rec.entries.map(e => ({
                ...e,
                acquired: (draftedBy[tid] && draftedBy[tid][e.playerId]) ? 'DRAFT' : 'ADD',
            }));
            const box = BX.bxTeamWeek(entries, { actual: rec.total });
            return { teamId: Number(tid), manager: mgrOf(byId[tid]), box, margin: rec.margin, won: rec.margin > 0 };
        });
    });
    const seasonTotals = BX.bxSeasonTotals(perWeekBox);
    const totalsById = {};
    seasonTotals.forEach(r => { totalsById[r.teamId] = r; });

    // How often has each manager benched the same player? Repeat offences are the
    // single best running joke the data can support.
    const benchRepeat = {};
    Object.keys(perWeekBox).forEach(w => {
        perWeekBox[w].forEach(t => {
            if (!t.box || !t.box.blunder) return;
            const key = t.teamId + '|' + t.box.blunder.benched.name;
            const r = benchRepeat[key] = benchRepeat[key] || { teamId: t.teamId, player: t.box.blunder.benched.name, weeks: [], total: 0 };
            r.weeks.push(Number(w));
            r.total = round(r.total + t.box.blunder.swing, 1);
        });
    });

    const thisWeekBox = perWeekBox[String(wk)] || [];
    const boxById = {};
    thisWeekBox.forEach(t => { boxById[t.teamId] = t; });

    const weekPts = thisWeekBox.map(t => t.box.actual).filter(p => p > 0);
    const weekHigh = weekPts.length ? Math.max(...weekPts) : 0;
    const weekLow  = weekPts.length ? Math.min(...weekPts) : 0;
    const weekAvg  = weekPts.length ? weekPts.reduce((a, b) => a + b, 0) / weekPts.length : 0;

    const teams = (season.teams || []).map(t => {
        const games = weekly[t.id] || [];
        const thisGame = games.find(g => g.week === wk) || null;
        const opp = thisGame ? byId[thisGame.opp] : null;
        const bx = boxById[t.id];
        const box = bx ? bx.box : null;
        const tot = totalsById[t.id] || null;
        const a = ap[t.id] || { w: 0, l: 0, t: 0 };
        const wins = games.filter(g => g.pts > g.oppPts).length;
        const losses = games.filter(g => g.pts < g.oppPts).length;

        const repeats = Object.keys(benchRepeat)
            .map(k => benchRepeat[k])
            .filter(r => r.teamId === t.id && r.weeks.length > 1)
            .sort((x, y) => y.total - x.total);

        // Draft callbacks: how this week's starters were acquired, and the best and
        // worst of their actual draft picks so far.
        const draftMap = draftedBy[t.id] || {};
        const startersByOrigin = box ? box.starters.map(p => ({
            name: p.name, pos: p.pos, pts: p.pts,
            draftedAt: draftMap[p.id] != null ? draftMap[p.id] : null,
        })) : [];

        return {
            teamId: t.id,
            manager: mgrOf(t),
            teamName: t.name,
            week: thisGame ? {
                opponent: opp ? mgrOf(opp) : null,
                opponentTeam: opp ? opp.name : null,
                points: round(thisGame.pts, 1),
                opponentPoints: round(thisGame.oppPts, 1),
                margin: round(thisGame.pts - thisGame.oppPts, 1),
                won: thisGame.pts > thisGame.oppPts,
                wasWeekHigh: Math.abs(thisGame.pts - weekHigh) < 0.01,
                wasWeekLow: Math.abs(thisGame.pts - weekLow) < 0.01,
                vsWeekAvg: round(thisGame.pts - weekAvg, 1),
                starters: startersByOrigin,
                bench: box ? box.bench.map(p => ({ name: p.name, pos: p.pos, pts: p.pts })) : [],
                pointsLeftOnBench: box ? box.left : null,
                optimalScore: box ? box.optimal : null,
                benchCostThemTheGame: box ? BX.bxCostThem(box, thisGame.pts - thisGame.oppPts) : false,
                worstStartSit: box && box.blunder ? {
                    benched: box.blunder.benched.name, benchedPts: box.blunder.benched.pts,
                    started: box.blunder.started.name, startedPts: box.blunder.started.pts,
                    swing: box.blunder.swing,
                } : null,
                hero: box && box.hero ? { name: box.hero.name, pts: box.hero.pts, shareOfTotal: box.heroShare } : null,
                zeros: box ? box.zeros.map(z => ({ name: z.name, pos: z.pos })) : [],
            } : null,
            season: {
                weeksPlayed: games.length,
                record: `${wins}-${losses}`,
                pointsFor: round(games.reduce((s, g) => s + g.pts, 0), 1),
                ppg: games.length ? round(games.reduce((s, g) => s + g.pts, 0) / games.length, 1) : null,
                allPlay: `${a.w}-${a.l}`,
                allPlayPct: (a.w + a.l + a.t) ? round((a.w + a.t / 2) / (a.w + a.l + a.t), 3) : null,
                beaten: games.filter(g => g.pts > g.oppPts).map(g => mgrOf(byId[g.opp])),
                lostTo: games.filter(g => g.pts < g.oppPts).map(g => mgrOf(byId[g.opp])),
                weeklyScores: games.map(g => ({ week: g.week, pts: round(g.pts, 1), opp: mgrOf(byId[g.opp]), won: g.pts > g.oppPts })),
                totalLeftOnBench: tot ? tot.left : null,
                leftOnBenchPerWeek: tot ? tot.leftPerWeek : null,
                lineupEfficiency: tot ? tot.efficiency : null,
                zerosStarted: tot ? tot.zeros : 0,
                perfectLineupWeeks: tot ? tot.optimalWeeks : 0,
                weeksBenchCostThemAGame: tot ? tot.costlyWeeks : 0,
                worstBenchCallOfSeason: tot ? tot.worstBlunder : null,
                repeatBenchOffences: repeats.slice(0, 2),
            },
            history: (function () {
                const h = {};
                if (opp && t.managerKey && opp.managerKey) {
                    h.lifetimeVsOpponent = lifetimeH2H(seasons, t.managerKey, opp.managerKey);
                }
                if (t.managerKey && thisGame) {
                    h.scoreContext = scoreContext(seasons, t.managerKey, thisGame.pts);
                }
                return h;
            })(),
        };
    });

    return {
        year: Number(year),
        week: wk,
        weeksCompleted: done,
        leagueWeek: {
            high: round(weekHigh, 1), low: round(weekLow, 1), average: round(weekAvg, 1),
            totalLeftOnBench: round(thisWeekBox.reduce((a, t) => a + (t.box ? t.box.left : 0), 0), 1),
        },
        seasonShameTable: seasonTotals.map(r => ({
            manager: r.manager, weeks: r.weeks, totalLeftOnBench: r.left,
            perWeek: r.leftPerWeek, efficiency: r.efficiency,
            zerosStarted: r.zeros, perfectWeeks: r.optimalWeeks,
            gamesLostToBenchCalls: r.costlyWeeks, worstCall: r.worstBlunder,
        })),
        teams,
        generatedAt: new Date().toISOString(),
    };
}

function readBlurbs(year) {
    try {
        const f = path.join(DATA_DIR, `blurbs_${year}.json`);
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { return null; }
}

function saveBlurbs(year, week, blurbs) {
    const store = readBlurbs(year) || { year: Number(year), weeks: {} };
    store.weeks[String(week)] = { blurbs, savedAt: new Date().toISOString() };
    store.year = Number(year);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `blurbs_${year}.json`), JSON.stringify(store));
    return store;
}

/** Attach written blurbs onto the season so the frontend can prefer them. */
function annotateBlurbs(data) {
    if (!data || !Array.isArray(data.seasons)) return data;
    for (const season of data.seasons) {
        const b = readBlurbs(season.season);
        if (b && b.weeks && Object.keys(b.weeks).length) season.blurbs = b.weeks;
    }
    return data;
}

module.exports = { buildBrief, readBlurbs, saveBlurbs, annotateBlurbs, lifetimeH2H, scoreContext, completedWeeks };
