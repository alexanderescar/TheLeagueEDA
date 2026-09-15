/**
 * boxscore.js — what actually happened to each roster in a given week.
 *
 * Everything above this file worked from team totals, which is why the commentary
 * read like it was describing a spreadsheet. ESPN's mBoxscore view gives per-player
 * points AND the lineup slot they occupied, which is the difference between
 * "scored below average" and "benched Mahomes for a tight end who scored zero".
 *
 * Shared by the server (building the weekly brief) and the browser (weekly awards),
 * so it stays dependency-free and exports both ways.
 *
 * Slot IDs are ESPN's: 20 = bench, 21 = IR, everything else is a started slot.
 */

var BX_SLOT = { 0:'QB', 2:'RB', 4:'WR', 6:'TE', 16:'D/ST', 17:'K', 20:'BE', 21:'IR', 23:'FLEX' };
var BX_POS  = { 1:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'K', 16:'D/ST' };
var BX_BENCH_SLOTS = [20, 21];
var BX_LINEUP = { QB: 1, RB: 2, WR: 2, TE: 1, 'D/ST': 1, K: 1 };
var BX_FLEX_COUNT = 2;
var BX_FLEX_POS = ['RB', 'WR', 'TE'];

function bxRound(n) { return Math.round(n * 100) / 100; }

function bxPos(p) {
    if (p == null) return null;
    if (typeof p === 'number') return BX_POS[p] || null;
    var s = String(p).toUpperCase().replace(/\s/g, '');
    if (s === 'DST' || s === 'D/ST' || s === 'DEF') return 'D/ST';
    if (s === 'PK') return 'K';
    return ['QB','RB','WR','TE','K'].indexOf(s) > -1 ? s : null;
}

/**
 * Best legal lineup from a full roster, ignoring who was actually started.
 * FLEX goes to the best remaining RB/WR/TE, which is how ESPN would score it.
 */
function bxOptimal(players) {
    var by = {};
    players.forEach(function (p) {
        if (!p.pos) return;
        (by[p.pos] = by[p.pos] || []).push(p);
    });
    Object.keys(by).forEach(function (k) {
        by[k].sort(function (a, b) { return b.pts - a.pts; });
    });
    var used = {}, lineup = [], total = 0;
    Object.keys(BX_LINEUP).forEach(function (k) { used[k] = 0; });
    Object.keys(BX_LINEUP).forEach(function (k) {
        for (var i = 0; i < BX_LINEUP[k]; i++) {
            var p = (by[k] || [])[used[k]];
            if (p) { total += p.pts; lineup.push(p); used[k]++; }
        }
    });
    for (var f = 0; f < BX_FLEX_COUNT; f++) {
        var bestPos = null, bestVal = -Infinity;
        BX_FLEX_POS.forEach(function (k) {
            var p = (by[k] || [])[used[k]];
            if (p && p.pts > bestVal) { bestVal = p.pts; bestPos = k; }
        });
        if (bestPos) { total += bestVal; lineup.push(by[bestPos][used[bestPos]]); used[bestPos]++; }
    }
    return { total: bxRound(total), lineup: lineup };
}

/**
 * Turn one team's roster entries for one week into the facts worth writing about.
 *
 * entries: [{ lineupSlotId, playerId, name, posId, pts, acquired }]
 */
function bxTeamWeek(entries, opts) {
    opts = opts || {};
    var players = (entries || []).map(function (e) {
        return {
            id: e.playerId,
            name: e.name,
            pos: bxPos(e.posId != null ? e.posId : e.pos),
            slot: BX_SLOT[e.lineupSlotId] != null ? BX_SLOT[e.lineupSlotId] : String(e.lineupSlotId),
            started: BX_BENCH_SLOTS.indexOf(e.lineupSlotId) === -1,
            pts: bxRound(Number(e.pts) || 0),
            acquired: e.acquired || null,
        };
    }).filter(function (p) { return p.pos; });

    if (!players.length) return null;

    var starters = players.filter(function (p) { return p.started; }).sort(function (a, b) { return b.pts - a.pts; });
    var bench    = players.filter(function (p) { return !p.started; }).sort(function (a, b) { return b.pts - a.pts; });
    var startedTotal = bxRound(starters.reduce(function (a, p) { return a + p.pts; }, 0));
    var opt = bxOptimal(players);

    // The single worst decision: the best benched player, against the lowest starter
    // he was actually eligible to replace. A benched QB can't sub for a kicker.
    var blunder = null;
    bench.forEach(function (b) {
        var eligible = starters.filter(function (s) {
            if (s.pos === b.pos) return true;
            return BX_FLEX_POS.indexOf(b.pos) > -1 && BX_FLEX_POS.indexOf(s.pos) > -1;
        });
        if (!eligible.length) return;
        var worst = eligible[eligible.length - 1];
        var swing = bxRound(b.pts - worst.pts);
        if (swing > 0 && (!blunder || swing > blunder.swing)) {
            blunder = { benched: b, started: worst, swing: swing };
        }
    });

    var zeros = starters.filter(function (p) { return p.pts <= 0; });
    var hero = starters[0] || null;
    var share = (hero && startedTotal > 0) ? bxRound((hero.pts / startedTotal) * 100) : null;

    // A waiver or trade pickup outscoring the whole draft class is a good line.
    var added = players.filter(function (p) { return p.acquired && p.acquired !== 'DRAFT'; });
    var bestAdd = added.sort(function (a, b) { return b.pts - a.pts; })[0] || null;
    var drafted = players.filter(function (p) { return p.acquired === 'DRAFT'; }).sort(function (a, b) { return b.pts - a.pts; });
    var bestDrafted = drafted[0] || null;

    return {
        players: players,
        starters: starters,
        bench: bench,
        startedTotal: startedTotal,
        actual: opts.actual != null ? bxRound(opts.actual) : startedTotal,
        optimal: opt.total,
        optimalLineup: opt.lineup,
        left: bxRound(opt.total - startedTotal),
        blunder: blunder,
        zeros: zeros,
        hero: hero,
        heroShare: share,
        dud: starters.length ? starters[starters.length - 1] : null,
        topBench: bench[0] || null,
        bestAdd: bestAdd,
        bestDrafted: bestDrafted,
    };
}

/** Did the points left on the bench actually cost them the game? */
function bxCostThem(teamWeek, margin) {
    if (!teamWeek || margin == null) return false;
    return margin < 0 && teamWeek.left > Math.abs(margin);
}

/**
 * League-wide awards for one week. Input is a list of
 * { teamId, manager, teamName, box, margin, won, opponent }.
 */
function bxWeeklyAwards(teams) {
    var withBox = (teams || []).filter(function (t) { return t.box; });
    if (!withBox.length) return null;

    function pick(list, scoreFn, filterFn) {
        var pool = filterFn ? list.filter(filterFn) : list;
        if (!pool.length) return null;
        return pool.slice().sort(function (a, b) { return scoreFn(b) - scoreFn(a); })[0];
    }

    var mostLeft = pick(withBox, function (t) { return t.box.left; });
    var worstBlunder = pick(withBox,
        function (t) { return t.box.blunder ? t.box.blunder.swing : -1; },
        function (t) { return !!t.box.blunder; });
    var biggestZero = null;
    withBox.forEach(function (t) {
        (t.box.zeros || []).forEach(function (z) {
            // A zero from a high-slot player is more embarrassing than a kicker dud.
            if (!biggestZero || (z.pos !== 'K' && z.pos !== 'D/ST' && biggestZero.player.pos === 'K')) {
                biggestZero = { team: t, player: z };
            }
        });
    });
    var luckiest = pick(withBox,
        function (t) { return -t.box.actual; },
        function (t) { return t.won; });
    var unluckiest = pick(withBox,
        function (t) { return t.box.actual; },
        function (t) { return t.won === false; });
    var topPlayer = null;
    withBox.forEach(function (t) {
        (t.box.starters || []).forEach(function (p) {
            if (!topPlayer || p.pts > topPlayer.player.pts) topPlayer = { team: t, player: p };
        });
    });
    var costliest = pick(withBox,
        function (t) { return t.box.left; },
        function (t) { return bxCostThem(t.box, t.margin); });

    return {
        mostLeftOnBench: mostLeft,
        worstStartSit: worstBlunder,
        biggestZero: biggestZero,
        luckiestWin: luckiest,
        unluckiestLoss: unluckiest,
        topPlayer: topPlayer,
        costliestMistake: costliest,
    };
}

/**
 * Season-long accumulation — the shame table. Input is a map of
 * week -> [{ teamId, manager, box, margin, won }].
 */
function bxSeasonTotals(byWeek) {
    var acc = {};
    Object.keys(byWeek || {}).forEach(function (wk) {
        (byWeek[wk] || []).forEach(function (t) {
            if (!t.box) return;
            var a = acc[t.teamId] = acc[t.teamId] || {
                teamId: t.teamId, manager: t.manager, weeks: 0,
                left: 0, zeros: 0, blunders: 0, worstBlunder: null,
                costlyWeeks: 0, optimalWeeks: 0, actual: 0, optimal: 0,
            };
            a.weeks++;
            a.left = bxRound(a.left + t.box.left);
            a.actual = bxRound(a.actual + t.box.actual);
            a.optimal = bxRound(a.optimal + t.box.optimal);
            a.zeros += (t.box.zeros || []).length;
            if (t.box.left <= 0.01) a.optimalWeeks++;
            if (t.box.blunder) {
                a.blunders++;
                if (!a.worstBlunder || t.box.blunder.swing > a.worstBlunder.swing) {
                    a.worstBlunder = { week: Number(wk), swing: t.box.blunder.swing,
                                       benched: t.box.blunder.benched.name, started: t.box.blunder.started.name };
                }
            }
            if (bxCostThem(t.box, t.margin)) a.costlyWeeks++;
        });
    });
    var rows = Object.keys(acc).map(function (k) {
        var a = acc[k];
        a.leftPerWeek = a.weeks ? bxRound(a.left / a.weeks) : 0;
        // How close they came to playing a perfect lineup all season.
        a.efficiency = a.optimal > 0 ? bxRound((a.actual / a.optimal) * 100) : null;
        return a;
    });
    rows.sort(function (a, b) { return b.left - a.left; });
    return rows;
}

if (typeof module !== 'undefined') {
    module.exports = {
        bxTeamWeek, bxOptimal, bxWeeklyAwards, bxSeasonTotals, bxCostThem, bxPos, bxRound,
        BX_SLOT, BX_POS, BX_LINEUP, BX_BENCH_SLOTS,
    };
}
