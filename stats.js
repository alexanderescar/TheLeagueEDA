/**
 * stats.js — the league, compressed into something a model can read.
 *
 * /api/league is about 2 MB. No prompt takes that, and handing a language model
 * thousands of raw rows is how you get confidently wrong arithmetic. So this
 * precomputes every aggregate worth asking about and emits them as finished
 * numbers. The bot's job becomes retrieval and phrasing, never calculation.
 *
 * The output is plain text rather than JSON on purpose: one fact per line reads
 * more reliably than a nested object, and costs fewer tokens.
 *
 * ── Honesty about coverage ───────────────────────────────────────────────────
 * The league has run since 2010 but the data does not go back evenly:
 *
 *   2010-2026   schedules, scores, standings, champions — complete
 *   2011-2026   draft boards
 *   2018-2026   per-player season projections and actuals (ESPN has nothing
 *               earlier; requests 404)
 *   2026 only   per-player WEEKLY scoring, because that is the only season the
 *               boxscore fetcher has run against
 *
 * Every section states its own range, and the sheet ends with an explicit limits
 * block, so "who had the best bench in 2015" gets "we don't have that" rather
 * than an invention.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'league_data.json');

/** Round to one place and drop the trailing .0 — shorter lines, same meaning. */
function n1(v) {
    if (v == null || !isFinite(v)) return '?';
    const r = Math.round(v * 10) / 10;
    return String(r);
}

function mgrOf(t) {
    return (t && (t.managerNick || t.managerName)) || (t && t.name) || ('Team ' + (t && t.id));
}

/** Every completed game, flattened to one row per team per week. */
function flatten(seasons) {
    const rows = [];
    (seasons || []).forEach(s => {
        const by = {};
        (s.teams || []).forEach(t => { by[t.id] = t; });
        const reg = ((s.settings || {}).scheduleSettings || {}).matchupPeriodCount || 13;
        (s.schedule || []).forEach(m => {
            if (!m.home || !m.away) return;
            const hp = m.home.totalPoints || 0, ap = m.away.totalPoints || 0;
            if (hp <= 0 && ap <= 0) return;
            const ht = by[m.home.teamId], at = by[m.away.teamId];
            if (!ht || !at) return;
            [[ht, hp, at, ap], [at, ap, ht, hp]].forEach(([a, af, b, bf]) => {
                rows.push({
                    season: Number(s.season), week: m.matchupPeriodId,
                    key: a.managerKey || ('t:' + a.id), name: mgrOf(a),
                    opp: b.managerKey || ('t:' + b.id), oppName: mgrOf(b),
                    pf: af, pa: bf, win: af > bf, loss: af < bf,
                    playoff: m.matchupPeriodId > reg,
                });
            });
        });
    });
    return rows;
}

/** Career totals per manager, plus the all-play record that strips schedule luck. */
function careers(rows) {
    const acc = {};
    rows.forEach(r => {
        const a = acc[r.key] = acc[r.key] || {
            name: r.name, g: 0, w: 0, l: 0, pf: 0, pa: 0,
            rg: 0, rw: 0, rl: 0, rpf: 0,          // regular season only
            pg: 0, pw: 0, pl: 0,                  // playoffs only
            best: -Infinity, worst: Infinity, seasons: {}, apW: 0, apL: 0,
            over150: 0, under80: 0, lostOver130: 0, wonUnder90: 0,
        };
        a.name = r.name;
        a.g++; a.pf += r.pf; a.pa += r.pa;
        if (r.win) a.w++; if (r.loss) a.l++;
        // Kept separately so "career record" can be stated both ways rather than
        // silently meaning one of them.
        if (r.playoff) {
            a.pg++; if (r.win) a.pw++; if (r.loss) a.pl++;
        } else {
            a.rg++; a.rpf += r.pf; if (r.win) a.rw++; if (r.loss) a.rl++;
        }
        if (r.pf > a.best) a.best = r.pf;
        if (r.pf < a.worst) a.worst = r.pf;
        a.seasons[r.season] = true;
        if (r.pf >= 150) a.over150++;
        if (r.pf < 80) a.under80++;
        if (r.loss && r.pf > 130) a.lostOver130++;
        if (r.win && r.pf < 90) a.wonUnder90++;
    });

    // All-play: your record against everyone who played that same week.
    const byWeek = {};
    rows.forEach(r => {
        const k = r.season + '|' + r.week;
        (byWeek[k] = byWeek[k] || []).push(r);
    });
    Object.keys(byWeek).forEach(k => {
        const wk = byWeek[k];
        wk.forEach(a => wk.forEach(b => {
            if (a.key === b.key) return;
            if (a.pf > b.pf) acc[a.key].apW++;
            else if (a.pf < b.pf) acc[a.key].apL++;
        }));
    });

    return Object.keys(acc).map(k => {
        const a = acc[k];
        const apTot = a.apW + a.apL;
        return {
            key: k, name: a.name, g: a.g, w: a.w, l: a.l,
            rg: a.rg, rw: a.rw, rl: a.rl, rppg: a.rg ? a.rpf / a.rg : 0,
            pg: a.pg, pw: a.pw, pl: a.pl,
            ppg: a.pf / a.g, papg: a.pa / a.g,
            best: a.best, worst: a.worst,
            seasons: Object.keys(a.seasons).length,
            apW: a.apW, apL: a.apL,
            apPct: apTot ? a.apW / apTot : 0,
            winPct: a.g ? a.w / a.g : 0,
            // Luck: how much better your actual record is than your all-play says
            // it should be. Positive means the schedule has been kind.
            luck: a.g ? (a.w / a.g) - (apTot ? a.apW / apTot : 0) : 0,
            over150: a.over150, under80: a.under80,
            lostOver130: a.lostOver130, wonUnder90: a.wonUnder90,
        };
    }).sort((x, y) => y.winPct - x.winPct);
}

/** Lifetime record between every pair who have met. */
function rivalries(rows) {
    const acc = {};
    rows.forEach(r => {
        const k = r.key + '\u0000' + r.opp;
        const a = acc[k] = acc[k] || { a: r.name, b: r.oppName, w: 0, l: 0, pf: 0, pa: 0 };
        a.a = r.name; a.b = r.oppName;
        a.pf += r.pf; a.pa += r.pa;
        if (r.win) a.w++; if (r.loss) a.l++;
    });
    return Object.keys(acc).map(k => acc[k])
        .filter(x => x.w + x.l > 0)
        .sort((x, y) => (y.w + y.l) - (x.w + x.l));
}

/** The all-time record book. */
function recordBook(rows) {
    const byPts = rows.slice().sort((a, b) => b.pf - a.pf);
    const margins = rows.map(r => ({ r: r, m: r.pf - r.pa }));
    const wins = margins.filter(x => x.m > 0).sort((a, b) => b.m - a.m);
    const losses = rows.filter(r => r.loss).sort((a, b) => b.pf - a.pf);
    const line = (r, extra) =>
        `${n1(r.pf)} by ${r.name} vs ${r.oppName}, ${r.season} wk${r.week}${extra || ''}`;
    return {
        highest: byPts.slice(0, 5).map(r => line(r)),
        lowest: byPts.slice(-5).reverse().map(r => line(r)),
        biggestWins: wins.slice(0, 5).map(x => `+${n1(x.m)} — ${x.r.name} over ${x.r.oppName}, ${x.r.season} wk${x.r.week} (${n1(x.r.pf)}-${n1(x.r.pa)})`),
        closest: wins.slice(-5).reverse().map(x => `+${n1(x.m)} — ${x.r.name} over ${x.r.oppName}, ${x.r.season} wk${x.r.week} (${n1(x.r.pf)}-${n1(x.r.pa)})`),
        mostInLoss: losses.slice(0, 5).map(r => line(r)),
    };
}

/** Champions, runners-up and last place, season by season. */
function honours(seasons) {
    const out = [];
    (seasons || []).forEach(s => {
        const teams = s.teams || [];
        if (!teams.length) return;
        const champ = teams.filter(t => t.rankCalculatedFinal === 1)[0];
        const ru    = teams.filter(t => t.rankCalculatedFinal === 2)[0];
        let worst = null;
        teams.forEach(t => {
            const rank = t.rankCalculatedFinal || null;
            if (rank != null && (!worst || rank > worst.rank)) worst = { t: t, rank: rank };
        });
        out.push({
            season: Number(s.season),
            champion: champ ? mgrOf(champ) : null,
            runnerUp: ru ? mgrOf(ru) : null,
            sacko: worst ? mgrOf(worst.t) : null,
        });
    });
    return out.sort((a, b) => b.season - a.season);
}

/**
 * Season-by-season finish for every manager, split regular season from playoffs.
 *
 * The first version emitted one combined line per season. Asked for Nick's 2018 it
 * said "15-0, 148.1 ppg" — correct for all games, but when the follow-up asked for
 * the regular season alone there was nothing to answer from, and the model filled
 * the gap by guessing the schedule was 14 weeks. It was 13. A number that isn't in
 * here gets invented, so both splits go in, and the real regular-season length with
 * them.
 */
function seasonLines(seasons, rows) {
    const regWeeksBySeason = {};
    (seasons || []).forEach(s => {
        regWeeksBySeason[Number(s.season)] =
            ((s.settings || {}).scheduleSettings || {}).matchupPeriodCount || null;
    });

    const acc = {};
    rows.forEach(r => {
        const k = r.season + '|' + r.key;
        const a = acc[k] = acc[k] || {
            name: r.name, season: r.season,
            rw: 0, rl: 0, rpf: 0, rg: 0,      // regular season
            pw: 0, pl: 0, ppf: 0, pg: 0,      // playoffs
        };
        if (r.playoff) {
            a.pg++; a.ppf += r.pf;
            if (r.win) a.pw++; if (r.loss) a.pl++;
        } else {
            a.rg++; a.rpf += r.pf;
            if (r.win) a.rw++; if (r.loss) a.rl++;
        }
    });

    const rankByTeam = {};
    (seasons || []).forEach(s => {
        (s.teams || []).forEach(t => {
            rankByTeam[s.season + '|' + (t.managerKey || ('t:' + t.id))] = t.rankCalculatedFinal || null;
        });
    });

    return Object.keys(acc).map(k => {
        const a = acc[k];
        const rank = rankByTeam[k];
        const reg = a.rg
            ? `regular season ${a.rw}-${a.rl}, ${n1(a.rpf)} pts, ${n1(a.rpf / a.rg)} ppg`
            : 'regular season n/a';
        const po = a.pg
            ? `; playoffs ${a.pw}-${a.pl}, ${n1(a.ppf)} pts in ${a.pg} game${a.pg === 1 ? '' : 's'}`
            : '; no playoff games';
        const tg = a.rg + a.pg;
        const tot = `; overall ${a.rw + a.pw}-${a.rl + a.pl}, ${n1(a.rpf + a.ppf)} pts, ${n1((a.rpf + a.ppf) / tg)} ppg`;
        const wk = regWeeksBySeason[a.season];
        const fmt = wk ? ` (${wk}-week regular season)` : '';
        return `${a.season} ${a.name}${fmt}: ${reg}${po}${tot}`
             + (rank ? `; finished ${rank}` : '');
    }).sort();
}

/** Draft history: who keeps taking whom, and where. */
function draftIndex(seasons) {
    const players = {}, byMgr = {};
    (seasons || []).forEach(s => {
        const by = {};
        (s.teams || []).forEach(t => { by[t.id] = t; });
        (((s.draftDetail || {}).picks) || []).forEach(p => {
            const t = by[p.teamId];
            if (!t || !p.playerName) return;
            const who = mgrOf(t);
            const rec = players[p.playerName] = players[p.playerName] || { n: 0, by: {} };
            rec.n++; rec.by[who] = (rec.by[who] || 0) + 1;
            const m = byMgr[who] = byMgr[who] || { picks: 0, firstRound: {} };
            m.picks++;
            if (p.overallPickNumber != null && p.overallPickNumber <= 12) {
                const pos = p.position || '?';
                m.firstRound[pos] = (m.firstRound[pos] || 0) + 1;
            }
        });
    });
    const repeat = Object.keys(players)
        .filter(k => players[k].n >= 3)
        .map(k => {
            const r = players[k];
            const who = Object.keys(r.by).sort((a, b) => r.by[b] - r.by[a])
                .map(m => `${m} ${r.by[m]}`).join(', ');
            return `${k}: drafted ${r.n}x (${who})`;
        }).sort();
    const tendencies = Object.keys(byMgr).sort().map(m => {
        const f = byMgr[m].firstRound;
        const parts = Object.keys(f).sort((a, b) => f[b] - f[a]).map(p => `${p} ${f[p]}`);
        return `${m}: ${byMgr[m].picks} career picks; round 1 by position — ${parts.join(', ') || 'n/a'}`;
    });
    return { repeat, tendencies };
}

/** Current-season per-player weekly detail. Only exists where boxscores were fetched. */
function playerWeeks(season) {
    if (!season || !season.boxscores) return null;
    const by = {};
    (season.teams || []).forEach(t => { by[t.id] = t; });
    const totals = {}, weeks = [];
    Object.keys(season.boxscores).map(Number).sort((a, b) => a - b).forEach(w => {
        weeks.push(w);
        const wk = season.boxscores[String(w)];
        Object.keys(wk).forEach(tid => {
            (wk[tid].entries || []).forEach(e => {
                if (!e.name) return;
                const started = [20, 21].indexOf(e.lineupSlotId) === -1;
                const r = totals[e.name] = totals[e.name] || {
                    mgr: mgrOf(by[tid]), pts: 0, starts: 0, benched: 0,
                    best: -Infinity, bestWk: null,
                };
                const pts = Number(e.pts) || 0;
                if (started) { r.pts += pts; r.starts++; if (pts > r.best) { r.best = pts; r.bestWk = w; } }
                else { r.benched += pts; }
            });
        });
    });
    const top = Object.keys(totals)
        .filter(k => totals[k].starts > 0)
        .map(k => Object.assign({ name: k }, totals[k]))
        .sort((a, b) => b.pts - a.pts);
    return { weeks: weeks, top: top };
}

/** Build the whole sheet as text. */
function buildSheet(data) {
    const seasons = (data && data.seasons ? data.seasons : []).slice()
        .sort((a, b) => b.season - a.season);
    if (!seasons.length) return null;

    const rows = flatten(seasons);
    const car = careers(rows);
    const riv = rivalries(rows);
    const rec = recordBook(rows);
    const hon = honours(seasons);
    const drafts = draftIndex(seasons);
    const current = seasons[0];
    const pw = playerWeeks(current);

    const years = seasons.map(s => Number(s.season)).sort((a, b) => a - b);
    const L = [];

    L.push('LEAGUE: "The League", ESPN id 119089, 12 teams, half PPR.');
    L.push(`Seasons on record: ${years[0]}-${years[years.length - 1]} (${years.length}). `
         + `Completed team-games: ${rows.length}.`);
    L.push('');

    L.push('CAREER RECORDS. Each line gives the regular-season record first, then the');
    L.push('playoff record, then both combined — quote whichever the question asks for and');
    L.push('say which you used. All-play is the record against every team each week, which');
    L.push('removes schedule luck; "luck" is win% minus all-play%, so positive means the');
    L.push('schedule has helped them. Rate stats below cover all games unless marked.');
    car.forEach(c => {
        L.push(`${c.name}: regular season ${c.rw}-${c.rl} (${n1(c.rppg)} ppg); `
             + `playoffs ${c.pw}-${c.pl}; overall ${c.w}-${c.l} (${(c.winPct * 100).toFixed(1)}%) `
             + `over ${c.seasons} seasons, ${n1(c.ppg)} ppg, ${n1(c.papg)} against, `
             + `best ${n1(c.best)}, worst ${n1(c.worst)}, `
             + `all-play ${c.apW}-${c.apL} (${(c.apPct * 100).toFixed(1)}%), luck ${c.luck >= 0 ? '+' : ''}${(c.luck * 100).toFixed(1)}pts, `
             + `150+ games ${c.over150}, sub-80 games ${c.under80}, `
             + `lost scoring 130+ ${c.lostOver130}x, won scoring under 90 ${c.wonUnder90}x`);
    });
    L.push('');

    L.push('HEAD-TO-HEAD (lifetime, from the first name’s point of view)');
    riv.forEach(r => {
        L.push(`${r.a} vs ${r.b}: ${r.w}-${r.l} in ${r.w + r.l} meetings, ${n1(r.pf)}-${n1(r.pa)} total points`);
    });
    L.push('');

    L.push('CHAMPIONS, RUNNERS-UP AND SACKOS BY SEASON');
    hon.forEach(h => {
        L.push(`${h.season}: champion ${h.champion || '?'}; runner-up ${h.runnerUp || '?'}; last ${h.sacko || '?'}`);
    });
    L.push('');

    L.push('ALL-TIME RECORD BOOK');
    L.push('Highest scores: ' + rec.highest.join(' | '));
    L.push('Lowest scores: ' + rec.lowest.join(' | '));
    L.push('Biggest wins: ' + rec.biggestWins.join(' | '));
    L.push('Closest games: ' + rec.closest.join(' | '));
    L.push('Most points in a loss: ' + rec.mostInLoss.join(' | '));
    L.push('');

    L.push('SEASON BY SEASON (record, points, finishing position)');
    seasonLines(seasons, rows).forEach(l => L.push(l));
    L.push('');

    L.push(`DRAFT HISTORY (boards available ${years.filter(y => y >= 2011)[0]}-${years[years.length - 1]})`);
    L.push('Players taken three or more times:');
    drafts.repeat.forEach(l => L.push('  ' + l));
    L.push('First-round tendencies:');
    drafts.tendencies.forEach(l => L.push('  ' + l));
    L.push('');

    if (pw && pw.top.length) {
        L.push(`${current.season} PLAYER SCORING (weeks ${pw.weeks[0]}-${pw.weeks[pw.weeks.length - 1]}; `
             + 'started points only, with best single week)');
        pw.top.slice(0, 120).forEach(p => {
            L.push(`${p.name} (${p.mgr}): ${n1(p.pts)} in ${p.starts} starts`
                 + (p.best > -Infinity ? `, best ${n1(p.best)} wk${p.bestWk}` : '')
                 + (p.benched > 0 ? `, ${n1(p.benched)} while benched` : ''));
        });
        L.push('');
    }

    L.push('WHAT THIS SHEET DOES NOT COVER — say so plainly rather than guessing:');
    L.push(`- Per-player WEEKLY scoring exists for ${current.season} only. Earlier seasons have`);
    L.push('  team scores but no player-level weekly detail, so questions like "what did X score');
    L.push('  in week 4 of 2019" cannot be answered.');
    L.push('- Player season projections and actuals exist from 2018 onward; ESPN has nothing earlier.');
    L.push('- Trades, waiver claims and other transactions are not recorded anywhere in this data.');
    L.push('- Bench points and lineup decisions are only known for seasons with boxscores.');
    L.push('- Any number not stated above is unknown. Do not derive new totals by adding these up;');
    L.push('  if a figure is not here, say it is not available.');

    return L.join('\n');
}

// ── Cache ────────────────────────────────────────────────────────────────────
// The sheet costs a couple of hundred milliseconds to build and only changes when
// the weekly scrape rewrites the data file, so key the cache on that file's mtime.

let cache = null;

function sheetFor(data) {
    let stamp = 0;
    try { if (fs.existsSync(DATA_FILE)) stamp = fs.statSync(DATA_FILE).mtimeMs; } catch { /* ignore */ }
    if (cache && cache.stamp === stamp && stamp !== 0) return cache.text;
    const text = buildSheet(data);
    cache = { stamp: stamp, text: text };
    return text;
}

function stats(data) {
    const text = sheetFor(data);
    return {
        available: !!text,
        chars: text ? text.length : 0,
        seasons: data && data.seasons ? data.seasons.length : 0,
    };
}

module.exports = {
    buildSheet, sheetFor, stats,
    flatten, careers, rivalries, recordBook, honours, seasonLines, draftIndex, playerWeeks,
};
