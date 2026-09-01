/**
 * recap.js — current-season draft recap: grades, roster analysis, playoff odds.
 *
 * ── On the playoff percentages ────────────────────────────────────────────────
 * These are deliberately conservative, and it's worth knowing why. Measured across
 * 96 team-seasons of this league (2018-2025):
 *
 *     weekly scoring noise, within a team ....... SD 23.4 pts
 *     real spread in team quality ............... SD 10.4 pts
 *     draft grade      -> final finish .......... r = 0.18
 *     roster projection-> actual scoring ........ r = 0.07
 *     manager skill, year over year ............. r = 0.00
 *     what players DID -> final finish .......... r = 0.50
 *
 * So: what your players do decides your season, but draft-day projections barely
 * predict what they'll do. A simulation that takes projections at face value would
 * spit out confident 25%-75% splits that this league's own history does not support.
 *
 * PROJECTION_RELIABILITY below is the shrinkage applied to projected roster strength
 * before simulating: our best estimate of true team quality has SD = reliability x 10.4.
 * The measured value is 0.074. We use 0.10 — a slight round up, on the grounds that the
 * historical measurement is somewhat attenuated (older ESPN projections are lower
 * quality and rosters churn all season) — but deliberately NOT much higher than what
 * the data supports. Raising it to 0.20 stretches the odds to 34-71%, which looks far
 * more authoritative than this league's history can justify.
 *
 * The result is odds roughly in the 42-62% band against a 50% baseline (6 of 12 make
 * the playoffs). If that feels boringly narrow, that IS the finding.
 */

var LINEUP_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, 'D/ST': 1, K: 1 };
var FLEX_COUNT   = 2;
var FLEX_POS     = ['RB', 'WR', 'TE'];

// Calibrated from this league's own history (2018-2025, half-PPR era).
var WEEKLY_NOISE_SD          = 23.4;
var BETWEEN_TEAM_SD          = 10.4;
var LEAGUE_MEAN_PPG          = 122.1;
var PROJECTION_RELIABILITY   = 0.10;
var SIMULATIONS              = 10000;

function rcNormPos(p) {
    if (!p) return null;
    var s = String(p).toUpperCase().replace(/\s/g, '');
    if (s === 'DST' || s === 'D/ST' || s === 'DEF') return 'D/ST';
    if (s === 'PK') return 'K';
    return ['QB', 'RB', 'WR', 'TE', 'K'].indexOf(s) > -1 ? s : null;
}

/** Best legal starting lineup from a set of players, by projected points. */
function bestLineup(players) {
    var by = { QB: [], RB: [], WR: [], TE: [], K: [], 'D/ST': [] };
    players.forEach(function (p) {
        var q = rcNormPos(p.pos);
        if (q && p.proj != null) by[q].push(p);
    });
    Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return b.proj - a.proj; }); });

    var used = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, 'D/ST': 0 };
    var starters = [], total = 0;
    Object.keys(LINEUP_SLOTS).forEach(function (k) {
        for (var i = 0; i < LINEUP_SLOTS[k]; i++) {
            var p = by[k][used[k]];
            if (p) { starters.push(p); total += p.proj; used[k]++; }
        }
    });
    for (var f = 0; f < FLEX_COUNT; f++) {
        var bestPos = null, bestVal = -1;
        FLEX_POS.forEach(function (k) {
            var p = by[k][used[k]];
            if (p && p.proj > bestVal) { bestVal = p.proj; bestPos = k; }
        });
        if (bestPos) { starters.push(by[bestPos][used[bestPos]]); total += bestVal; used[bestPos]++; }
    }
    return { starters: starters, total: Math.round(total * 10) / 10, byPos: by };
}

/** Replacement level per position across the whole drafted pool. */
function rcReplacement(players, teamCount) {
    var by = {};
    players.forEach(function (p) {
        var q = rcNormPos(p.pos);
        if (!q || p.proj == null) return;
        (by[q] = by[q] || []).push(p.proj);
    });
    Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return b - a; }); });
    var used = {};
    Object.keys(LINEUP_SLOTS).forEach(function (k) { used[k] = LINEUP_SLOTS[k] * teamCount; });
    var flexLeft = FLEX_COUNT * teamCount;
    while (flexLeft > 0) {
        var bp = null, bv = -Infinity;
        FLEX_POS.forEach(function (k) {
            var pool = by[k]; if (!pool) return;
            var next = pool[used[k]];
            if (next != null && next > bv) { bv = next; bp = k; }
        });
        if (!bp) break;
        used[bp]++; flexLeft--;
    }
    var levels = {};
    Object.keys(by).forEach(function (k) {
        var pool = by[k], idx = used[k] != null ? used[k] : pool.length;
        levels[k] = pool[idx] != null ? pool[idx] : (pool[pool.length - 1] || 0);
    });
    return levels;
}

function zScores(vals) {
    var n = vals.length;
    var mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
    var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / n) || 1;
    return vals.map(function (v) { return (v - mean) / sd; });
}

function rcLetter(z) {
    var bands = [[1.45,'A+'],[1.05,'A'],[0.75,'A-'],[0.45,'B+'],[0.15,'B'],
                 [-0.15,'B-'],[-0.45,'C+'],[-0.75,'C'],[-1.05,'C-'],[-1.45,'D']];
    for (var i = 0; i < bands.length; i++) if (z >= bands[i][0]) return bands[i][1];
    return 'F';
}

// ── Deterministic RNG so the odds don't wobble between page loads ──────────────
function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5;  s >>>= 0;
        return s / 4294967296;
    };
}
function normalPair(rng) {
    var u = 1 - rng(), v = rng();
    var m = Math.sqrt(-2 * Math.log(u));
    return [m * Math.cos(2 * Math.PI * v), m * Math.sin(2 * Math.PI * v)];
}

/**
 * Simulate the schedule. Returns playoff probability per team.
 *
 * schedule: [{ week, home, away }] — the games still to be played.
 * opts.banked: { teamId: { w, pf } } — wins and points already in the bank, so
 *              mid-season odds start from the real standings rather than 0-0.
 */
function simulatePlayoffs(teamMeans, schedule, playoffSpots, opts) {
    opts = opts || {};
    var iters = opts.iterations || SIMULATIONS;
    var noise = opts.noiseSd || WEEKLY_NOISE_SD;
    var banked = opts.banked || null;
    var ids = Object.keys(teamMeans);
    var n = ids.length;
    if (!n) return null;
    // With no games left the season is decided; fall out to the banked standings.
    if (!schedule.length && !banked) return null;

    var idx = {}; ids.forEach(function (id, i) { idx[id] = i; });
    var means = ids.map(function (id) { return teamMeans[id]; });
    var made = new Array(n).fill(0);
    var seedTotals = new Array(n).fill(0);
    var titleOdds = new Array(n).fill(0);
    var rng = makeRng(opts.seed || 20260901);

    var games = schedule.filter(function (m) {
        return idx[m.home] != null && idx[m.away] != null;
    });

    var baseWins = ids.map(function (id) { return banked && banked[id] ? (banked[id].w || 0) : 0; });
    var basePts  = ids.map(function (id) { return banked && banked[id] ? (banked[id].pf || 0) : 0; });

    for (var it = 0; it < iters; it++) {
        var wins = baseWins.slice();
        var pts  = basePts.slice();
        for (var g = 0; g < games.length; g++) {
            var h = idx[games[g].home], a = idx[games[g].away];
            var pair = normalPair(rng);
            var hs = means[h] + pair[0] * noise;
            var as = means[a] + pair[1] * noise;
            pts[h] += hs; pts[a] += as;
            if (hs > as) wins[h]++; else if (as > hs) wins[a]++;
            else { wins[h] += 0.5; wins[a] += 0.5; }
        }
        var order = [];
        for (var i = 0; i < n; i++) order.push(i);
        order.sort(function (x, y) { return (wins[y] - wins[x]) || (pts[y] - pts[x]); });
        for (var s = 0; s < n; s++) {
            var t = order[s];
            seedTotals[t] += s + 1;
            if (s < playoffSpots) made[t]++;
        }
        // Crude playoff: top seeds advance with probability weighted by scoring mean.
        var field = order.slice(0, playoffSpots);
        var champ = field[0], bestDraw = -Infinity;
        for (var f = 0; f < field.length; f++) {
            var draw = means[field[f]] + normalPair(rng)[0] * noise * 1.15;
            if (draw > bestDraw) { bestDraw = draw; champ = field[f]; }
        }
        titleOdds[champ]++;
    }

    var out = {};
    ids.forEach(function (id, i) {
        out[id] = {
            playoffPct: Math.round((made[i] / iters) * 1000) / 10,
            avgSeed:    Math.round((seedTotals[i] / iters) * 10) / 10,
            titlePct:   Math.round((titleOdds[i] / iters) * 1000) / 10,
        };
    });
    return out;
}

/**
 * Tiers are measured against the baseline (6 of 12 = 50%), not against absolute
 * cutoffs, and the bands are deliberately wide. With ~10k simulations the odds carry
 * roughly +/-1 point of noise, so narrow bands would let two effectively identical
 * teams land in different tiers — which is worse than no tier at all. Anything inside
 * +/-3 points of the baseline is called what it is: a coin flip.
 */
function oddsTier(pct, baseline) {
    var base = baseline == null ? 50 : baseline;
    var edge = pct - base;
    if (edge >= 7)  return { tier: 'Contender',         rank: 1 };
    if (edge >= 3)  return { tier: 'In the mix',        rank: 2 };
    if (edge > -3)  return { tier: 'Coin flip',         rank: 3 };
    if (edge > -8)  return { tier: 'Needs some breaks', rank: 4 };
    return             { tier: 'Long shot',         rank: 5 };
}

/**
 * Main entry: grade every team's draft and project the season.
 *
 * picks:    [{ teamId, pick, pos, name, espnProj, espnRank, fpEcr, fpStd, fpTier, bye, auction, keeper }]
 * teams:    [{ id, manager, teamName }]
 * schedule: [{ week, home, away }] regular season only
 */
function buildRecap(picks, teams, schedule, playoffSpots) {
    var usable = picks.filter(function (p) { return p.teamId != null && p.pick != null; });
    if (!usable.length || !teams.length) return null;
    var teamCount = teams.length;
    var spots = playoffSpots || 6;

    // ── Consensus rank: blend ESPN's board with FantasyPros' expert consensus ──
    usable.forEach(function (p) {
        var parts = [];
        if (p.espnRank != null) parts.push(p.espnRank);
        if (p.fpEcr    != null) parts.push(p.fpEcr);
        p.consensus = parts.length ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length : null;
        p.disagreement = (p.espnRank != null && p.fpEcr != null) ? Math.abs(p.espnRank - p.fpEcr) : null;
        p.proj = p.espnProj;
    });

    // Value against the slot spent, on the blended board.
    var ranked = usable.slice().sort(function (a, b) {
        var ra = a.consensus == null ? Infinity : a.consensus;
        var rb = b.consensus == null ? Infinity : b.consensus;
        return ra - rb || a.pick - b.pick;
    });
    var boardPos = new Map();
    ranked.forEach(function (p, i) { boardPos.set(p, i + 1); });
    usable.forEach(function (p) { p.slotValue = p.pick - boardPos.get(p); });

    // Points value over replacement.
    var levels = rcReplacement(usable, teamCount);
    usable.forEach(function (p) {
        var q = rcNormPos(p.pos);
        p.vor = (q && p.proj != null) ? Math.max(0, p.proj - (levels[q] || 0)) : 0;
    });
    var vorCurve = usable.map(function (p) { return p.vor; }).sort(function (a, b) { return b - a; });

    // ── Per-team aggregation ──
    var byTeam = {};
    teams.forEach(function (t) {
        byTeam[t.id] = {
            teamId: t.id, manager: t.manager, teamName: t.teamName,
            picks: [], vorGot: 0, vorExp: 0, slotValue: 0,
        };
    });
    usable.forEach(function (p) {
        var t = byTeam[p.teamId]; if (!t) return;
        t.picks.push(p);
        t.vorGot += p.vor;
        t.vorExp += vorCurve[p.pick - 1] != null ? vorCurve[p.pick - 1] : 0;
        t.slotValue += p.slotValue;
    });

    var rows = teams.map(function (t) { return byTeam[t.id]; }).filter(Boolean);
    rows.forEach(function (r) {
        r.picks.sort(function (a, b) { return a.pick - b.pick; });
        r.pointsEdge = Math.round((r.vorGot - r.vorExp) * 10) / 10;
        var lu = bestLineup(r.picks);
        r.starters = lu.starters;
        r.projPoints = lu.total;
        r.projPPG = Math.round((lu.total / 17) * 10) / 10;
    });

    // Grade = half points-value, half board-value. Two ways of being right.
    var zPoints = zScores(rows.map(function (r) { return r.pointsEdge; }));
    var zBoard  = zScores(rows.map(function (r) { return r.slotValue; }));
    rows.forEach(function (r, i) {
        r.zPoints = Math.round(zPoints[i] * 100) / 100;
        r.zBoard  = Math.round(zBoard[i] * 100) / 100;
        r.gradeZ  = Math.round(((zPoints[i] + zBoard[i]) / 2) * 100) / 100;
        r.grade   = rcLetter(r.gradeZ);
    });

    // ── Positional strength vs the league ──
    var posList = ['QB', 'RB', 'WR', 'TE'];
    var posVals = {};
    posList.forEach(function (pos) {
        posVals[pos] = rows.map(function (r) {
            return r.picks.reduce(function (a, p) {
                return a + (rcNormPos(p.pos) === pos ? p.vor : 0);
            }, 0);
        });
    });
    posList.forEach(function (pos) {
        var z = zScores(posVals[pos]);
        var sorted = posVals[pos].slice().sort(function (a, b) { return b - a; });
        rows.forEach(function (r, i) {
            r.pos = r.pos || {};
            r.pos[pos] = {
                value: Math.round(posVals[pos][i] * 10) / 10,
                z: Math.round(z[i] * 100) / 100,
                rank: sorted.indexOf(posVals[pos][i]) + 1,
            };
        });
    });

    // ── Roster shape and bye-week landmines ──
    rows.forEach(function (r) {
        var early = r.picks.filter(function (p) { return p.pick <= teamCount * 4; });
        var eRB = early.filter(function (p) { return rcNormPos(p.pos) === 'RB'; }).length;
        var eWR = early.filter(function (p) { return rcNormPos(p.pos) === 'WR'; }).length;
        r.shape = eRB === 0 ? 'Zero-RB'
                : eRB === 1 ? 'Hero-RB'
                : eRB >= 3  ? 'RB-heavy'
                : eWR >= 3  ? 'WR-heavy'
                : 'Balanced';

        var byes = {};
        r.starters.forEach(function (p) {
            if (p.bye) (byes[p.bye] = byes[p.bye] || []).push(p);
        });
        r.byeTrouble = Object.keys(byes)
            .filter(function (w) { return byes[w].length >= 3; })
            .map(function (w) {
                return { week: Number(w), count: byes[w].length,
                         players: byes[w].map(function (p) { return p.name; }) };
            })
            .sort(function (a, b) { return b.count - a.count; });

        // Top-heaviness: how much of the projected lineup rides on two players.
        var vals = r.starters.map(function (p) { return p.proj || 0; }).sort(function (a, b) { return b - a; });
        var top2 = vals.slice(0, 2).reduce(function (a, b) { return a + b; }, 0);
        var all  = vals.reduce(function (a, b) { return a + b; }, 0) || 1;
        r.topHeavy = Math.round((top2 / all) * 1000) / 10;
    });

    // ── Playoff odds off the real schedule ──
    var ppgs = rows.map(function (r) { return r.projPPG; });
    var zPpg = zScores(ppgs);
    var teamMeans = {};
    rows.forEach(function (r, i) {
        // Shrink projected strength to what history says projections are actually worth.
        r.simMean = LEAGUE_MEAN_PPG + zPpg[i] * BETWEEN_TEAM_SD * PROJECTION_RELIABILITY;
        teamMeans[r.teamId] = r.simMean;
    });
    var sim = simulatePlayoffs(teamMeans, schedule || [], spots, {});
    rows.forEach(function (r) {
        var s = sim && sim[r.teamId];
        r.playoffPct = s ? s.playoffPct : null;
        r.titlePct   = s ? s.titlePct   : null;
        r.avgSeed    = s ? s.avgSeed    : null;
        r.baseline   = Math.round((spots / teamCount) * 1000) / 10;
        r.oddsEdge   = (r.playoffPct != null) ? Math.round((r.playoffPct - r.baseline) * 10) / 10 : null;
        var t = oddsTier(r.playoffPct == null ? r.baseline : r.playoffPct, r.baseline);
        r.tier = t.tier; r.tierRank = t.rank;
    });

    // ── League-wide superlatives ──
    var all = usable.slice();
    var withValue = all.filter(function (p) { return p.consensus != null; });
    var superlatives = {
        steal:  withValue.slice().sort(function (a, b) { return b.slotValue - a.slotValue; })[0] || null,
        reach:  withValue.slice().sort(function (a, b) { return a.slotValue - b.slotValue; })[0] || null,
        bestPick: all.slice().sort(function (a, b) { return (b.vor - a.vor) || (a.pick - b.pick); })[0] || null,
        controversial: all.filter(function (p) { return p.fpStd != null; })
                          .sort(function (a, b) { return b.fpStd - a.fpStd; })[0] || null,
        splitPick: all.filter(function (p) { return p.disagreement != null; })
                      .sort(function (a, b) { return b.disagreement - a.disagreement; })[0] || null,
    };
    Object.keys(superlatives).forEach(function (k) {
        var p = superlatives[k];
        if (p) {
            var owner = byTeam[p.teamId];
            superlatives[k] = {
                name: p.name, pos: rcNormPos(p.pos), pick: p.pick,
                manager: owner ? owner.manager : '?',
                consensus: p.consensus != null ? Math.round(p.consensus) : null,
                slotValue: p.slotValue, vor: Math.round(p.vor * 10) / 10,
                std: p.fpStd, espnRank: p.espnRank, fpEcr: p.fpEcr,
                disagreement: p.disagreement,
            };
        }
    });

    rows.sort(function (a, b) { return b.gradeZ - a.gradeZ; });
    rows.forEach(function (r, i) { r.gradeRank = i + 1; });

    return {
        rows: rows,
        superlatives: superlatives,
        replacement: levels,
        calibration: {
            weeklyNoiseSd: WEEKLY_NOISE_SD,
            betweenTeamSd: BETWEEN_TEAM_SD,
            reliability: PROJECTION_RELIABILITY,
            simulations: SIMULATIONS,
            baseline: Math.round((spots / teamCount) * 1000) / 10,
        },
    };
}

if (typeof module !== 'undefined') {
    module.exports = {
        buildRecap, simulatePlayoffs, bestLineup, rcReplacement, rcNormPos,
        rcLetter, oddsTier, zScores, makeRng,
        PROJECTION_RELIABILITY, WEEKLY_NOISE_SD, BETWEEN_TEAM_SD, LEAGUE_MEAN_PPG,
    };
}
