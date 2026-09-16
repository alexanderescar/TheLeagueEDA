/**
 * highscores.js — the weekly high-score prize, tracked properly.
 *
 * Constitution 2.1: "Weekly high scorer during the regular season receives $25."
 *
 * Two things worth knowing about how this counts:
 *
 * 1. ELIGIBLE WEEKS follow each season's own regular season, not a fixed number.
 *    The league ran 13-week regular seasons through 2020 and 14 from 2021, so a
 *    literal "weeks 1-14" would have handed regular-season money to a playoff score
 *    in every season before 2021.
 *
 * 2. MONEY AND SCORES ARE SEPARATE. Weekly high scores are tracked back to 2011 as a
 *    record book. Dollars are only attached from HS_MONEY_FROM onward, because the
 *    constitution is on version 5 and the prize has not always existed. Crediting
 *    someone $400 for weeks that never paid out would be fiction.
 *
 * Ties split the prize, so a season's payout always equals weeks x $25.
 */

/**
 * The weekly prize has three eras, traced through the constitution versions and the
 * votes that created them. Treating it as a flat $25 would credit people for money
 * that did not exist, and would overpay the 2019-2023 seasons by 25%.
 *
 *   before 2019   no weekly prize at all. v1 paid a $100 season-long scoring champion
 *                 instead. A weekly prize was proposed and rejected in 2014, 2015 and
 *                 2017 before it finally passed.
 *   2019-2023     $20, regular season through week 13. Created by the August 2019 vote
 *                 (11-1) that replaced the season scoring champion, and recorded in
 *                 constitution v2.
 *   2024 onward   $25, regular season through week 14, per constitution v4 and v6 2.1.
 *
 * Eligible weeks follow each season's own regular season rather than a fixed number,
 * which happens to line up: the league ran 13-week regular seasons through 2020 and
 * 14 from 2021.
 */
var HS_ERAS = [
    { from: 2024, prize: 25 },
    { from: 2019, prize: 20 },
];

/** What the weekly high score paid in a given season. 0 means no prize existed. */
function hsPrizeFor(season) {
    for (var i = 0; i < HS_ERAS.length; i++) {
        if (Number(season) >= HS_ERAS[i].from) return HS_ERAS[i].prize;
    }
    return 0;
}

function hsRound(n) { return Math.round(n * 100) / 100; }

/** Regular-season length for a season, falling back to 13. */
function hsRegWeeks(season) {
    var s = season && season.settings && season.settings.scheduleSettings;
    return (s && s.matchupPeriodCount) || 13;
}

/**
 * Every eligible week across every season, with its winner(s).
 * resolve(teamId, season) should return a display name.
 */
function hsWeeklyWinners(allSeasons, resolve) {
    var out = [];
    (allSeasons || []).slice().sort(function (a, b) { return b.season - a.season; }).forEach(function (s) {
        var reg = hsRegWeeks(s);
        var byWeek = {};
        (s.schedule || []).forEach(function (m) {
            if (!m.home || !m.away) return;
            var w = m.matchupPeriodId;
            if (w == null || w > reg) return;
            var hp = m.home.totalPoints || 0, ap = m.away.totalPoints || 0;
            if (hp <= 0 && ap <= 0) return;
            (byWeek[w] = byWeek[w] || []).push(
                { teamId: m.home.teamId, pts: hp, oppPts: ap },
                { teamId: m.away.teamId, pts: ap, oppPts: hp }
            );
        });
        Object.keys(byWeek).map(Number).sort(function (a, b) { return a - b; }).forEach(function (w) {
            var rows = byWeek[w].slice().sort(function (a, b) { return b.pts - a.pts; });
            if (!rows.length) return;
            var top = rows[0].pts;
            var winners = rows.filter(function (r) { return Math.abs(r.pts - top) < 0.001; });
            var prize = hsPrizeFor(s.season);
            var paid = prize > 0;
            out.push({
                season: Number(s.season),
                week: w,
                score: hsRound(top),
                tie: winners.length > 1,
                money: paid ? hsRound(prize / winners.length) : null,
                prize: paid ? prize : null,
                paid: paid,
                winners: winners.map(function (r) {
                    return {
                        teamId: r.teamId,
                        name: resolve ? resolve(r.teamId, s) : ('Team ' + r.teamId),
                        pts: hsRound(r.pts),
                        // Leading the league and still losing is the cruellest way to
                        // win $25, and worth calling out.
                        lostAnyway: r.pts < r.oppPts,
                    };
                }),
            });
        });
    });
    return out;
}

/** Career totals per manager. */
function hsByManager(weeks) {
    var acc = {};
    (weeks || []).forEach(function (wk) {
        wk.winners.forEach(function (win) {
            var a = acc[win.name] = acc[win.name] || {
                name: win.name, weeks: 0, money: 0, paidWeeks: 0,
                best: null, seasons: {}, ties: 0, wonAndLost: 0,
            };
            a.weeks++;
            a.seasons[wk.season] = (a.seasons[wk.season] || 0) + 1;
            if (wk.tie) a.ties++;
            if (win.lostAnyway) a.wonAndLost++;
            if (wk.paid) { a.paidWeeks++; a.money = hsRound(a.money + (wk.money || 0)); }
            if (!a.best || win.pts > a.best.pts) {
                a.best = { pts: win.pts, season: wk.season, week: wk.week };
            }
        });
    });
    var rows = Object.keys(acc).map(function (k) {
        var a = acc[k];
        a.seasonCount = Object.keys(a.seasons).length;
        a.bestSeason = Object.keys(a.seasons).reduce(function (best, yr) {
            return (!best || a.seasons[yr] > a.seasons[best]) ? yr : best;
        }, null);
        a.bestSeasonWeeks = a.bestSeason ? a.seasons[a.bestSeason] : 0;
        return a;
    });
    rows.sort(function (a, b) {
        return (b.money - a.money) || (b.weeks - a.weeks) || (b.best.pts - a.best.pts);
    });
    return rows;
}

/** Season summaries, newest first. */
function hsBySeason(weeks) {
    var acc = {};
    (weeks || []).forEach(function (wk) {
        var a = acc[wk.season] = acc[wk.season] || { season: wk.season, weeks: [], money: 0 };
        a.weeks.push(wk);
        if (wk.paid) a.money = hsRound(a.money + (wk.prize || 0));
    });
    return Object.keys(acc).map(function (k) { return acc[k]; })
        .sort(function (a, b) { return b.season - a.season; })
        .map(function (s) {
            s.weeks.sort(function (a, b) { return a.week - b.week; });
            var counts = {};
            s.weeks.forEach(function (w) { w.winners.forEach(function (x) { counts[x.name] = (counts[x.name] || 0) + 1; }); });
            var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
            s.topEarner = top || null;
            s.topEarnerWeeks = top ? counts[top] : 0;
            return s;
        });
}

/** Record-book extras. */
function hsRecords(weeks) {
    if (!weeks || !weeks.length) return null;
    var flat = [];
    weeks.forEach(function (wk) {
        wk.winners.forEach(function (w) {
            flat.push({ name: w.name, pts: w.pts, season: wk.season, week: wk.week, lostAnyway: w.lostAnyway });
        });
    });
    var highest = flat.slice().sort(function (a, b) { return b.pts - a.pts; })[0];
    var lowest  = flat.slice().sort(function (a, b) { return a.pts - b.pts; })[0];

    // Most weeks won in a single season.
    var perSeason = {};
    weeks.forEach(function (wk) {
        wk.winners.forEach(function (w) {
            var k = wk.season + '|' + w.name;
            perSeason[k] = (perSeason[k] || 0) + 1;
        });
    });
    var bestSeason = Object.keys(perSeason).map(function (k) {
        var p = k.split('|');
        return { season: Number(p[0]), name: p[1], count: perSeason[k] };
    }).sort(function (a, b) { return b.count - a.count; })[0];

    // Longest run of consecutive weekly wins within one season.
    var streak = null;
    var bySeasonName = {};
    weeks.forEach(function (wk) {
        wk.winners.forEach(function (w) {
            var k = wk.season + '|' + w.name;
            (bySeasonName[k] = bySeasonName[k] || []).push(wk.week);
        });
    });
    Object.keys(bySeasonName).forEach(function (k) {
        var list = bySeasonName[k].slice().sort(function (a, b) { return a - b; });
        var run = 1, bestRun = 1, start = list[0], bestStart = list[0];
        for (var i = 1; i < list.length; i++) {
            if (list[i] === list[i - 1] + 1) { run++; }
            else { run = 1; start = list[i]; }
            if (run > bestRun) { bestRun = run; bestStart = start; }
        }
        if (bestRun > 1 && (!streak || bestRun > streak.run)) {
            var p = k.split('|');
            streak = { season: Number(p[0]), name: p[1], run: bestRun, from: bestStart };
        }
    });

    var cruel = flat.filter(function (f) { return f.lostAnyway; })
        .sort(function (a, b) { return b.pts - a.pts; });

    return {
        highest: highest,
        lowestWinning: lowest,
        mostInSeason: bestSeason,
        longestStreak: streak,
        wonAndLost: cruel.slice(0, 5),
        wonAndLostCount: cruel.length,
        totalWeeks: weeks.length,
        totalPaid: weeks.filter(function (w) { return w.paid; }).length,
        ties: weeks.filter(function (w) { return w.tie; }).length,
    };
}

if (typeof module !== 'undefined') {
    module.exports = {
        hsWeeklyWinners, hsByManager, hsBySeason, hsRecords, hsRegWeeks,
        hsPrizeFor, HS_ERAS,
    };
}
