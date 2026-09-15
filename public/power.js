/**
 * power.js — weekly power rankings with commentary.
 *
 * The standings are the standings: they come straight from ESPN and are not
 * editorialised. This is the other question — who is actually good — recomputed
 * from scratch every week so the ranking moves as the season does.
 *
 * Four inputs, each z-scored across the league and then weighted:
 *
 *   Recent form (35%)   Scoring over the last three weeks, most recent weighted
 *                       heaviest. A team that has woken up should climb before
 *                       its record catches up.
 *   Season scoring (25%) Points per game across every week played. The long view,
 *                       so one big week can't carry a ranking.
 *   All-play (25%)      Record against the entire league every week. Strips out
 *                       schedule luck: beating the week's low scorer isn't the
 *                       same as beating its high scorer.
 *   Roster health (15%) Current roster strength with injured starters discounted.
 *                       The only forward-looking input.
 *
 * Quality of wins is folded into all-play rather than scored separately — beating
 * good teams is exactly what all-play already measures, and counting it twice would
 * double-weight the same evidence.
 *
 * ── On "which week is it" ────────────────────────────────────────────────────
 * ESPN's `status.currentMatchupPeriod` is the week currently IN PROGRESS, not the
 * last one finished. Treating it as the latter is what produced the bug where
 * every losing team was told it had led the league in scoring: the week's high
 * score was computed from an unplayed week, came back 0, and `pts >= 0` is true
 * for everybody. Always derive the week from the schedule — see
 * pwLastCompletedWeek — and never trust a caller's week number blindly.
 */

var PW_WEIGHTS = { form: 0.35, season: 0.25, allPlay: 0.25, health: 0.15 };
var PW_FORM_WEEKS = [0.5, 0.3, 0.2];      // most recent week first
var PW_HURT = { OUT: 1, INJURY_RESERVE: 1, DOUBTFUL: 0.75, QUESTIONABLE: 0.3, DAY_TO_DAY: 0.3 };
var PW_BENCH_SLOTS = { BE: 1, IR: 1, Bench: 1 };
var PW_MAX_FACTS = 3;                     // extra sentences after the game recap

function pwZ(vals) {
    var n = vals.length;
    if (!n) return [];
    var mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
    var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / n) || 1;
    return vals.map(function (v) { return (v - mean) / sd; });
}

function pwNum(n) { return (Math.round(n * 10) / 10).toFixed(1); }
function pwInt(n) { return String(Math.round(n)); }

/** 1st, 2nd, 3rd, 4th … — because "3th-best in the league" is not a sentence. */
function pwOrd(n) {
    var v = Math.round(n), rem100 = v % 100, rem10 = v % 10;
    if (rem100 >= 11 && rem100 <= 13) return v + 'th';
    if (rem10 === 1) return v + 'st';
    if (rem10 === 2) return v + 'nd';
    if (rem10 === 3) return v + 'rd';
    return v + 'th';
}

/** Is this matchup actually scored? */
function pwScored(m) {
    if (!m || !m.home || !m.away) return false;
    return (m.home.totalPoints || 0) > 0 || (m.away.totalPoints || 0) > 0;
}

/**
 * The last week that is genuinely finished.
 *
 * A week counts as complete only when every one of its matchups has a score, so a
 * mid-Sunday refresh doesn't promote a half-played week. If nothing qualifies but
 * some scores exist, fall back to the highest week with any scoring at all.
 */
function pwLastCompletedWeek(season) {
    var sched = (season && season.schedule) || [];
    var total = {}, scored = {};
    sched.forEach(function (m) {
        if (!m || !m.home || !m.away) return;
        var wk = m.matchupPeriodId;
        if (wk == null) return;
        total[wk] = (total[wk] || 0) + 1;
        if (pwScored(m)) scored[wk] = (scored[wk] || 0) + 1;
    });
    var complete = 0, any = 0;
    Object.keys(total).forEach(function (k) {
        var wk = Number(k);
        if (scored[wk]) { if (wk > any) any = wk; }
        if (scored[wk] === total[wk]) { if (wk > complete) complete = wk; }
    });
    return complete || any || 0;
}

/**
 * Resolve the week to rank through. Never ranks past what has been played, which
 * is the guard that keeps the league-high bug from coming back by another route.
 */
function pwResolveWeek(season, requested) {
    var last = pwLastCompletedWeek(season);
    if (requested == null) return last;
    if (requested < 0) return 0;
    return Math.min(requested, last);
}

/** High / low / average across a single week. */
function pwWeekStats(season, week) {
    var pts = [], byTeam = {};
    ((season && season.schedule) || []).forEach(function (m) {
        if (!pwScored(m) || m.matchupPeriodId !== week) return;
        var hp = m.home.totalPoints || 0, ap = m.away.totalPoints || 0;
        pts.push(hp, ap);
        byTeam[m.home.teamId] = hp;
        byTeam[m.away.teamId] = ap;
    });
    if (!pts.length) return { high: 0, low: 0, avg: 0, n: 0, byTeam: byTeam };
    var sum = pts.reduce(function (a, b) { return a + b; }, 0);
    return {
        high: Math.max.apply(null, pts),
        low: Math.min.apply(null, pts),
        avg: sum / pts.length,
        n: pts.length,
        byTeam: byTeam,
    };
}

/** Weekly scores per team, up to and including `throughWeek`. */
function pwWeeklyScores(schedule, throughWeek) {
    var byTeam = {};
    (schedule || []).forEach(function (m) {
        if (!m.home || !m.away) return;
        var wk = m.matchupPeriodId;
        if (throughWeek != null && wk > throughWeek) return;
        var hp = m.home.totalPoints || 0, ap = m.away.totalPoints || 0;
        if (hp <= 0 && ap <= 0) return;
        (byTeam[m.home.teamId] = byTeam[m.home.teamId] || []).push({ week: wk, pts: hp, opp: m.away.teamId, oppPts: ap });
        (byTeam[m.away.teamId] = byTeam[m.away.teamId] || []).push({ week: wk, pts: ap, opp: m.home.teamId, oppPts: hp });
    });
    Object.keys(byTeam).forEach(function (k) {
        byTeam[k].sort(function (a, b) { return a.week - b.week; });
    });
    return byTeam;
}

/** All-play: score against every other team, every week. */
function pwAllPlay(weekly, throughWeek) {
    var ids = Object.keys(weekly);
    var out = {};
    ids.forEach(function (id) { out[id] = { w: 0, l: 0, t: 0 }; });
    var weeks = {};
    ids.forEach(function (id) {
        weekly[id].forEach(function (g) {
            if (throughWeek != null && g.week > throughWeek) return;
            (weeks[g.week] = weeks[g.week] || []).push({ id: id, pts: g.pts });
        });
    });
    Object.keys(weeks).forEach(function (wk) {
        var rows = weeks[wk];
        rows.forEach(function (a) {
            rows.forEach(function (b) {
                if (a.id === b.id) return;
                if (a.pts > b.pts) out[a.id].w++;
                else if (a.pts < b.pts) out[a.id].l++;
                else out[a.id].t++;
            });
        });
    });
    ids.forEach(function (id) {
        var r = out[id], g = r.w + r.l + r.t;
        r.pct = g ? (r.w + r.t / 2) / g : 0;
    });
    return out;
}

/**
 * Roster strength with injured players discounted.
 *
 * Out players carry their projection and lineup slot so the commentary can tell
 * a missing WR1 from a missing handcuff instead of treating every injury alike.
 */
function pwHealth(roster, projByPlayer) {
    if (!roster || !roster.length) return { score: null, out: [], questionable: [], lost: 0, total: 0 };
    var outList = [], qList = [];
    var total = 0, lost = 0;
    roster.forEach(function (p) {
        var proj = projByPlayer && projByPlayer[p.playerId] != null ? projByPlayer[p.playerId] : null;
        var hurt = PW_HURT[p.status] || 0;
        var weight = 1 - hurt;
        var entry = {
            playerId: p.playerId, name: p.name, position: p.position,
            slot: p.slot, status: p.status, proj: proj,
            starter: !PW_BENCH_SLOTS[p.slot],
        };
        if (hurt >= 0.75) outList.push(entry);
        else if (hurt > 0) qList.push(entry);
        if (proj != null) {
            total += proj * weight;
            lost += proj * hurt;
        }
    });
    var byProj = function (a, b) { return (b.proj || 0) - (a.proj || 0); };
    outList.sort(byProj); qList.sort(byProj);

    // "Is this a real loss or a bench body?" — judged on projected points relative
    // to the rest of the roster, not on lineup slot. ESPN often shuffles an injured
    // starter to the bench, which would otherwise make every injury look survivable.
    var ranked = roster.map(function (p) {
        return projByPlayer && projByPlayer[p.playerId] != null ? projByPlayer[p.playerId] : -1;
    }).filter(function (v) { return v >= 0; }).sort(function (a, b) { return b - a; });
    var rankOf = function (proj) {
        if (proj == null) return null;
        for (var i = 0; i < ranked.length; i++) if (ranked[i] <= proj) return i + 1;
        return ranked.length + 1;
    };
    [outList, qList].forEach(function (list) {
        list.forEach(function (p) {
            p.projRank = rankOf(p.proj);
            // Top half of a ~16-man roster by projection counts as a real loss.
            // Tighter than this and genuine starters get written off as depth.
            p.significant = p.starter || (p.projRank != null && p.projRank <= 8);
        });
    });

    return {
        score: Math.round(total * 10) / 10,
        out: outList, questionable: qList,
        lost: Math.round(lost * 10) / 10,
        total: Math.round((total + lost) * 10) / 10,
    };
}

/**
 * Compute the power ranking as of a given week.
 * Returns rows sorted best-first.
 */
function powerRankings(season, throughWeek, projByPlayer) {
    var teams = (season.teams || []);
    if (!teams.length) return null;
    var wk = pwResolveWeek(season, throughWeek);
    var weekly = pwWeeklyScores(season.schedule, wk);
    var played = Object.keys(weekly).length > 0;
    var allPlay = played ? pwAllPlay(weekly, wk) : {};

    var rows = teams.map(function (t) {
        var games = weekly[t.id] || [];
        var recent = games.slice(-3).reverse();     // most recent first
        var formNum = 0, formDen = 0;
        recent.forEach(function (g, i) {
            var w = PW_FORM_WEEKS[i] != null ? PW_FORM_WEEKS[i] : 0.1;
            formNum += g.pts * w; formDen += w;
        });
        var ppg = games.length ? games.reduce(function (a, g) { return a + g.pts; }, 0) / games.length : 0;
        var health = pwHealth((season.rosters || {})[t.id], projByPlayer);
        var ap = allPlay[t.id] || { w: 0, l: 0, t: 0, pct: 0 };
        var wins = games.filter(function (g) { return g.pts > g.oppPts; }).length;
        var losses = games.filter(function (g) { return g.pts < g.oppPts; }).length;
        return {
            teamId: t.id, team: t,
            games: games, played: games.length,
            form: formDen ? formNum / formDen : 0,
            ppg: ppg,
            allPlay: ap,
            health: health,
            wins: wins, losses: losses,
            lastGame: games.length ? games[games.length - 1] : null,
        };
    });

    // z-score each component; fall back to roster health alone before any games.
    var zForm   = pwZ(rows.map(function (r) { return r.form; }));
    var zPpg    = pwZ(rows.map(function (r) { return r.ppg; }));
    var zAp     = pwZ(rows.map(function (r) { return r.allPlay.pct; }));
    var healthVals = rows.map(function (r) { return r.health.score != null ? r.health.score : 0; });
    var zHealth = pwZ(healthVals);

    rows.forEach(function (r, i) {
        r.zForm = zForm[i]; r.zPpg = zPpg[i]; r.zAllPlay = zAp[i]; r.zHealth = zHealth[i];
        if (!played) {
            r.score = zHealth[i];            // preseason: roster is all we have
        } else {
            r.score = zForm[i] * PW_WEIGHTS.form
                    + zPpg[i] * PW_WEIGHTS.season
                    + zAp[i]  * PW_WEIGHTS.allPlay
                    + zHealth[i] * PW_WEIGHTS.health;
        }
    });

    // League-relative ranks the commentary leans on.
    var order = function (key) {
        var sorted = rows.slice().sort(function (a, b) { return b[key] - a[key]; });
        var rank = {};
        sorted.forEach(function (r, i) { rank[r.teamId] = i + 1; });
        return rank;
    };
    var ppgRank = order('ppg'), formRank = order('form'), apRank = order('allPlay');
    var apPctRank = {};
    rows.slice().sort(function (a, b) { return b.allPlay.pct - a.allPlay.pct; })
        .forEach(function (r, i) { apPctRank[r.teamId] = i + 1; });
    rows.forEach(function (r) {
        r.ppgRank = ppgRank[r.teamId];
        r.formRank = formRank[r.teamId];
        r.allPlayRank = apPctRank[r.teamId];
        r.teamCount = rows.length;
    });

    rows.sort(function (a, b) { return b.score - a.score; });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return { rows: rows, played: played, throughWeek: wk };
}

/** Movement vs the previous week's ranking. */
function powerWithMovement(season, throughWeek, projByPlayer) {
    var now = powerRankings(season, throughWeek, projByPlayer);
    if (!now) return null;
    var wk = now.throughWeek;
    var prev = wk > 1 ? powerRankings(season, wk - 1, projByPlayer) : null;
    var prevRank = {};
    if (prev) prev.rows.forEach(function (r) { prevRank[r.teamId] = r.rank; });
    now.rows.forEach(function (r) {
        r.prevRank = prevRank[r.teamId] != null ? prevRank[r.teamId] : null;
        r.move = r.prevRank == null ? 0 : r.prevRank - r.rank;
    });
    return now;
}

// ── League history ───────────────────────────────────────────────────────────
// Managers persist across seasons even as team names change, so everything here
// is keyed on the ESPN owner GUID rather than teamId (which gets reused).

function pwOwnerKey(t) {
    if (!t) return null;
    return t.primaryOwner || t.managerName || (t.id != null ? 'id:' + t.id : null);
}

var PW_HIST_CACHE = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

/**
 * Index every scored team-week across every season so the commentary can say
 * "highest Week 1 score since 2021" and mean it.
 */
function pwHistory(allSeasons) {
    if (!allSeasons || !allSeasons.length) return null;
    if (PW_HIST_CACHE && PW_HIST_CACHE.has(allSeasons)) return PW_HIST_CACHE.get(allSeasons);

    var hist = { byOwner: {}, weekSeasonHigh: {}, seasons: [] };

    allSeasons.forEach(function (s) {
        var sched = (s && s.schedule) || [];
        if (!sched.length) return;
        hist.seasons.push(s.season);
        var ownerOf = {};
        (s.teams || []).forEach(function (t) { ownerOf[t.id] = pwOwnerKey(t); });

        sched.forEach(function (m) {
            if (!pwScored(m)) return;
            var wk = m.matchupPeriodId;
            var sides = [
                { id: m.home.teamId, pts: m.home.totalPoints || 0, opp: m.away.teamId, oppPts: m.away.totalPoints || 0 },
                { id: m.away.teamId, pts: m.away.totalPoints || 0, opp: m.home.teamId, oppPts: m.home.totalPoints || 0 },
            ];
            sides.forEach(function (side) {
                var key = ownerOf[side.id];
                if (!key) return;
                var o = hist.byOwner[key] || (hist.byOwner[key] = { scores: [], h2h: {}, starts: [] });
                var rec = { season: s.season, week: wk, pts: side.pts, oppPts: side.oppPts, won: side.pts > side.oppPts };
                o.scores.push(rec);
                var oppKey = ownerOf[side.opp];
                if (oppKey && oppKey !== key) {
                    var h = o.h2h[oppKey] || (o.h2h[oppKey] = { w: 0, l: 0 });
                    if (side.pts > side.oppPts) h.w++; else if (side.pts < side.oppPts) h.l++;
                }
                if (wk === 1) o.starts.push({ season: s.season, won: rec.won });
            });

            var wsh = hist.weekSeasonHigh[wk] || (hist.weekSeasonHigh[wk] = {});
            var top = Math.max(m.home.totalPoints || 0, m.away.totalPoints || 0);
            if (!(wsh[s.season] >= top)) wsh[s.season] = top;
        });
    });

    Object.keys(hist.byOwner).forEach(function (k) {
        var o = hist.byOwner[k];
        o.best = o.scores.reduce(function (a, b) { return (!a || b.pts > a.pts) ? b : a; }, null);
        o.worst = o.scores.reduce(function (a, b) { return (!a || b.pts < a.pts) ? b : a; }, null);
    });
    hist.seasons.sort(function (a, b) { return b - a; });

    if (PW_HIST_CACHE) PW_HIST_CACHE.set(allSeasons, hist);
    return hist;
}

/**
 * Most recent prior season in which somebody matched this score in this week.
 * Returns null when it has never been done — i.e. an outright league record.
 */
function pwWeekHighSince(hist, week, pts, currentSeason) {
    if (!hist || !hist.weekSeasonHigh[week]) return undefined;
    var byS = hist.weekSeasonHigh[week];
    var prior = Object.keys(byS).map(Number)
        .filter(function (s) { return s < currentSeason; })
        .sort(function (a, b) { return b - a; });
    if (!prior.length) return undefined;
    for (var i = 0; i < prior.length; i++) {
        if (byS[prior[i]] >= pts - 0.01) return prior[i];
    }
    return null;
}

/** Expected points-to-date for a draft pick, pro-rated over the regular season. */
function pwDraftPace(season, picks, week) {
    if (!picks || !picks.length || !week) return null;
    var weeks = 14;
    try {
        var mc = season.settings.scheduleSettings.matchupPeriodCount;
        if (mc) weeks = mc;
    } catch (e) { /* default */ }
    var best = null, worst = null;
    picks.forEach(function (p) {
        if (p.projPoints == null || p.actualPoints == null || p.projPoints <= 0) return;
        var expected = p.projPoints * (week / weeks);
        if (expected <= 0) return;
        var ratio = p.actualPoints / expected;
        var rec = {
            name: p.playerName, position: p.playerPosition, round: p.roundId,
            overall: p.overallPickNumber, proj: p.projPoints, actual: p.actualPoints,
            expected: expected, ratio: ratio,
        };
        if (!best || ratio > best.ratio) best = rec;
        if (!worst || ratio < worst.ratio) worst = rec;
    });
    return { best: best, worst: worst, weeks: weeks };
}

// ── Commentary ───────────────────────────────────────────────────────────────
// Lines are picked from pools keyed to what actually happened, and seeded by team
// and week so the same team never gets the same line twice running.
function pwPick(pool, seed) {
    if (!pool || !pool.length) return '';
    var h = 0;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return pool[h % pool.length];
}

/**
 * Build the shared per-week context once, rather than recomputing the week's
 * high score twelve times. Callers pass the result into pwBlurb along with the
 * team-specific bits.
 */
function pwContext(season, allSeasons, throughWeek) {
    var wk = pwResolveWeek(season, throughWeek);
    var stats = pwWeekStats(season, wk);
    var picks = ((season && season.draftDetail) || {}).picks || [];
    var byTeam = {};
    picks.forEach(function (p) {
        if (p.teamId == null) return;
        (byTeam[p.teamId] = byTeam[p.teamId] || []).push(p);
    });
    return {
        week: wk,
        played: wk > 0 && stats.n > 0,
        weekHigh: stats.high,
        weekLow: stats.low,
        weekAvg: stats.avg,
        season: season,
        seasonYear: season && season.season,
        history: pwHistory(allSeasons),
        draftByTeam: byTeam,
    };
}

/**
 * Everything true and interesting about one team this week, each with a weight.
 * pwBlurb takes the heaviest few — so a league record beats a routine injury
 * note, and no team gets the same filler sentence as its eleven neighbours.
 */
function pwFacts(r, ctx) {
    var name = ctx.name;
    var facts = [];
    var add = function (id, cat, w, pool) { facts.push({ id: id, cat: cat, w: w, pool: pool }); };
    var g = r.lastGame;
    var oppName = ctx.oppName || 'their opponent';
    var high = ctx.weekHigh > 0 ? ctx.weekHigh : null;
    var low = ctx.weekLow > 0 ? ctx.weekLow : null;

    // ── Opening: what just happened. Always present, always first. ──
    if (!ctx.played || !g) {
        add('game', 'game', Infinity, [
            name + ' hasn\'t played a snap yet, so this is pure roster projection and vibes.',
            'Nothing to judge ' + name + ' on but the draft board so far.',
            'Week 1 will tell us more about ' + name + ' than any projection can.',
            'A ranking built entirely on paper. ' + name + ' gets to prove it or not.',
        ]);
    } else {
        var margin = Math.abs(g.pts - g.oppPts);
        var won = g.pts > g.oppPts;
        var isHigh = high != null && g.pts >= high - 0.01;
        var isLow = low != null && g.pts <= low + 0.01;

        if (won && isHigh) {
            add('game', 'game', Infinity, [
                name + ' put up the most points in the league and beat ' + oppName + ' doing it. No notes.',
                'League-best ' + pwNum(g.pts) + ' and a win over ' + oppName + '. That\'s the whole package.',
                'Nobody scored more than ' + name + ' this week, and ' + oppName + ' was standing in the way of it.',
            ]);
        } else if (!won && isHigh) {
            add('game', 'game', Infinity, [
                name + ' scored the most points in the league and lost. That\'s the schedule for you.',
                'Led the week in scoring with ' + pwNum(g.pts) + ' and still took the L. Brutal.',
                name + ' put up a league-best ' + pwNum(g.pts) + ' and got nothing for it.',
            ]);
        } else if (isLow && !won) {
            add('game', 'game', Infinity, [
                'Nobody in the league scored less than ' + name + '\'s ' + pwNum(g.pts) + '. ' + oppName + ' barely had to show up.',
                name + ' managed a league-worst ' + pwNum(g.pts) + '. The bye weeks are not going to explain this one away.',
                'Last in the league in scoring and beaten by ' + oppName + '. A complete week for ' + name + '.',
            ]);
        } else if (won && margin >= 40) {
            add('game', 'game', Infinity, [
                name + ' didn\'t beat ' + oppName + ' so much as file a police report — ' + pwNum(g.pts) + ' to ' + pwNum(g.oppPts) + '.',
                'A ' + pwInt(margin) + '-point win over ' + oppName + '. ' + name + ' was never in danger.',
                name + ' put up ' + pwNum(g.pts) + ' and turned ' + oppName + ' into a rounding error.',
                oppName + ' has been asked not to describe what ' + name + ' did to them, ' + pwNum(g.pts) + '–' + pwNum(g.oppPts) + '.',
            ]);
        } else if (won && margin <= 5) {
            add('game', 'game', Infinity, [
                name + ' escaped ' + oppName + ' by ' + pwNum(margin) + '. A win is a win, but that one needed a shower.',
                'Survived. ' + name + ' beat ' + oppName + ' by ' + pwNum(margin) + ' and shouldn\'t look too closely at how.',
                name + ' won by ' + pwNum(margin) + '. Somewhere ' + oppName + ' is still staring at the bench.',
                pwNum(margin) + ' points of daylight. ' + name + ' will take it and never speak of it again.',
            ]);
        } else if (won) {
            add('game', 'game', Infinity, [
                name + ' handled ' + oppName + ', ' + pwNum(g.pts) + '–' + pwNum(g.oppPts) + '.',
                'Business as usual: ' + name + ' over ' + oppName + ' by ' + pwNum(margin) + '.',
                name + ' took care of ' + oppName + ' without much drama.',
                'No theatrics required — ' + name + ' by ' + pwNum(margin) + ' over ' + oppName + '.',
            ]);
        } else if (margin <= 5) {
            add('game', 'game', Infinity, [
                name + ' lost to ' + oppName + ' by ' + pwNum(margin) + '. That one will sting all week.',
                pwNum(margin) + ' points short against ' + oppName + '. Every bench decision is now a war crime.',
                name + ' came up ' + pwNum(margin) + ' short. Painful.',
                'Decided by ' + pwNum(margin) + '. ' + name + ' will be re-reading that lineup until Sunday.',
            ]);
        } else if (margin >= 40) {
            add('game', 'game', Infinity, [
                name + ' got run off the field by ' + oppName + ', losing by ' + pwInt(margin) + '.',
                'Nothing worked. ' + name + ' managed ' + pwNum(g.pts) + ' against ' + oppName + '.',
                name + ' was never in this one — down ' + pwInt(margin) + ' to ' + oppName + '.',
                oppName + ' beat ' + name + ' by ' + pwInt(margin) + '. That is not a loss, that is a weather event.',
            ]);
        } else {
            add('game', 'game', Infinity, [
                name + ' fell to ' + oppName + ', ' + pwNum(g.oppPts) + '–' + pwNum(g.pts) + '.',
                'A quiet loss to ' + oppName + ' for ' + name + '.',
                name + ' didn\'t have enough against ' + oppName + '.',
            ]);
        }
    }

    // ── League history: the rarest material, so it outweighs almost everything ──
    var hist = ctx.history;
    var ownerKey = pwOwnerKey(r.team);
    if (hist && g && ctx.played && ownerKey) {
        var since = pwWeekHighSince(hist, g.week, g.pts, ctx.seasonYear);
        var isHighNow = high != null && g.pts >= high - 0.01;
        if (isHighNow && since === null) {
            add('hist-record', 'history', 95, [
                'That is the highest Week ' + g.week + ' score in the history of this league. Sixteen years of it.',
                'No one has ever scored that much in a Week ' + g.week + '. ' + name + ' owns the record now.',
            ]);
        } else if (isHighNow && typeof since === 'number') {
            add('hist-since', 'history', 72, [
                'Nobody has posted a Week ' + g.week + ' number like that since ' + since + '.',
                pwNum(g.pts) + ' is the biggest Week ' + g.week + ' score the league has seen since ' + since + '.',
            ]);
        }

        var o = hist.byOwner[ownerKey];
        if (o && o.best && g.pts >= o.best.pts - 0.01 && o.scores.length > 20) {
            add('hist-personal', 'history', 88, [
                'It is also the most ' + name + ' has ever scored in a week. Career game.',
                name + ' has never had a bigger week, going back through every season on record.',
            ]);
        } else if (o && o.worst && g.pts <= o.worst.pts + 0.01 && o.scores.length > 20) {
            add('hist-personal', 'history', 85, [
                'It is the worst single week ' + name + ' has ever put up. A franchise low.',
                'No week in ' + name + '\'s history has been worse than that one.',
            ]);
        }

        // Head-to-head, when the sample is big enough to be a real pattern.
        var oppKey = ctx.oppTeam ? pwOwnerKey(ctx.oppTeam) : null;
        if (o && oppKey && o.h2h[oppKey]) {
            var h = o.h2h[oppKey], n = h.w + h.l;
            if (n >= 5 && h.w / n >= 0.7) {
                add('hist-h2h', 'history', 44, [
                    name + ' is now ' + h.w + '–' + h.l + ' lifetime against ' + oppName + '. It is starting to look personal.',
                    'That matchup is ' + h.w + '–' + h.l + ' all-time in ' + name + '\'s favour.',
                ]);
            } else if (n >= 5 && h.w / n <= 0.3) {
                add('hist-h2h', 'history', 44, [
                    name + ' falls to ' + h.w + '–' + h.l + ' lifetime against ' + oppName + '. Some matchups are just cursed.',
                    oppName + ' owns this one historically — ' + h.l + '–' + h.w + ' across the years.',
                ]);
            }
        }

        // Week 1 only: how this manager usually starts.
        if (g.week === 1 && o && o.starts.length >= 6) {
            var prior = o.starts.filter(function (x) { return x.season < ctx.seasonYear; });
            var wonStarts = prior.filter(function (x) { return x.won; }).length;
            if (prior.length >= 6 && wonStarts / prior.length >= 0.7) {
                add('hist-start', 'history', 34, [
                    name + ' has now won ' + wonStarts + ' of their last ' + prior.length + ' openers. Fast starts are the brand.',
                ]);
            } else if (prior.length >= 6 && wonStarts / prior.length <= 0.3) {
                add('hist-start', 'history', 34, [
                    name + ' has dropped most of their Week 1s over the years — ' + wonStarts + ' wins in ' + prior.length + ' tries.',
                ]);
            }
        }
    }

    // ── The gap between record and quality ──
    if (ctx.played && r.played >= 2) {
        var apPct = r.allPlay.pct;
        var winPct = r.played ? r.wins / r.played : 0;
        var gap = apPct - winPct;
        if (gap > 0.18) {
            add('luck', 'luck', 30 + 70 * Math.min(1, gap / 0.5), [
                'The all-play record says ' + name + ' is much better than ' + r.wins + '–' + r.losses + ' suggests; they\'ve just kept drawing the wrong week.',
                'Against the whole league they\'d be ' + r.allPlay.w + '–' + r.allPlay.l + '. The schedule is doing them dirty.',
                'Genuinely unlucky. ' + name + ' scores like a contender and has the record of a bystander.',
                r.wins + '–' + r.losses + ' undersells it badly — ' + r.allPlay.w + '–' + r.allPlay.l + ' against the field is the honest number.',
            ]);
        } else if (gap < -0.18) {
            add('luck', 'luck', 30 + 70 * Math.min(1, -gap / 0.5), [
                'Fair warning: ' + name + ' is ' + r.wins + '–' + r.losses + ' but only ' + r.allPlay.w + '–' + r.allPlay.l + ' against the field. That record is on loan.',
                'The record flatters them. ' + name + ' has been beating whoever happened to be worse that week.',
                'Regression is coming for ' + name + '. The scoring doesn\'t match the win column.',
                'A ' + r.wins + '–' + r.losses + ' record built on a soft schedule — the all-play says ' + r.allPlay.w + '–' + r.allPlay.l + '.',
            ]);
        }
    }

    // ── Where their scoring sits in the league ──
    // Needs two games before "per week" means anything; after one, points-per-game
    // is just the game, and saying it twice in one blurb reads as padding.
    if (ctx.played && r.played >= 2 && r.ppgRank) {
        var n2 = r.teamCount || 12;
        if (r.ppgRank === 1) {
            add('scoring', 'scoring', 52, [
                'Nobody in the league is scoring more per week than ' + name + ' right now.',
                'Most points per game in the league. The engine is real.',
                'The best scoring offence in the league, week in and week out.',
                pwNum(r.ppg) + ' a week leads everyone. That is not a fluke any more.',
            ]);
        } else if (r.ppgRank === n2) {
            add('scoring', 'scoring', 50, [
                'Dead last in points per game. ' + name + ' needs more than a schedule change.',
                'The lowest-scoring team in the league. That is the whole problem in one number.',
                'Nobody is scoring less. No amount of matchup luck fixes ' + pwNum(r.ppg) + ' a week.',
                'Twelfth in scoring. The roster, not the schedule, is the issue.',
            ]);
        } else if (r.ppgRank <= 3) {
            add('scoring', 'scoring', 34, [
                pwNum(r.ppg) + ' a week, ' + pwOrd(r.ppgRank) + '-best in the league.',
                'Top-three scoring at ' + pwNum(r.ppg) + ' a game.',
                'Only ' + (r.ppgRank - 1) + ' team' + (r.ppgRank === 2 ? '' : 's') + ' in the league are scoring more.',
            ]);
        }
    }

    // ── Trend over the last three weeks ──
    if (ctx.played && r.played >= 3) {
        var last3 = r.games.slice(-3).map(function (x) { return x.pts; });
        var rising = last3[2] > last3[1] && last3[1] > last3[0];
        var falling = last3[2] < last3[1] && last3[1] < last3[0];
        if (rising) {
            add('form', 'form', 46, [
                'Three straight weeks of scoring more than the last — ' + last3.map(pwNum).join(' to ') + '. Something is clicking.',
                'The arrow has been pointing up for three weeks running.',
            ]);
        } else if (falling) {
            add('form', 'form', 46, [
                'Three weeks of scoring less each time out — ' + last3.map(pwNum).join(' down to ') + '. That is a trend, not a blip.',
                'The scoring has gone backwards three weeks in a row.',
            ]);
        }
    }

    // ── Why the model has them where it does (carries the early weeks) ──
    if (r.zForm != null) {
        var comps = [
            { k: 'form', v: r.zForm * PW_WEIGHTS.form },
            { k: 'season', v: r.zPpg * PW_WEIGHTS.season },
            { k: 'allPlay', v: r.zAllPlay * PW_WEIGHTS.allPlay },
            { k: 'health', v: r.zHealth * PW_WEIGHTS.health },
        ].sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
        var top = comps[0];
        if (Math.abs(top.v) > 0.18) {
            var pos = top.v > 0;
            var pools = {
                form: pos ? [
                    'The ranking is mostly recent form — lately they have been the better version of themselves.',
                    'This spot is bought with recent scoring, not the season as a whole.',
                    'Whatever changed a few weeks ago is still working.',
                    'The last three weeks are carrying this ranking.',
                ] : [
                    'Recent form is what is dragging this ranking down.',
                    'The last few weeks are the worst thing on their résumé right now.',
                    'The model is docking them for how they have looked lately, not how they started.',
                    'Nothing in the recent scoring argues for a higher spot.',
                ],
                season: pos ? [
                    'The season-long scoring is what holds this spot up.',
                    'Ranked here on the long view — the body of work is real.',
                    'A full season of scoring says this is who they are.',
                ] : [
                    'The season-long scoring is the anchor here, and not in a good way.',
                    'The cumulative numbers are what keep them this low.',
                    'One good week would not move this — the season average is the problem.',
                ],
                allPlay: pos ? [
                    'Ranked this high largely on all-play: ' + r.allPlay.w + '–' + r.allPlay.l + ' against the field.',
                    'Against the whole league they are ' + r.allPlay.w + '–' + r.allPlay.l + ', and that is what the model trusts.',
                    'All-play is doing the heavy lifting: ' + r.allPlay.w + '–' + r.allPlay.l + '.',
                ] : [
                    'All-play is unkind to them — ' + r.allPlay.w + '–' + r.allPlay.l + ' against the field.',
                    'A ' + r.allPlay.w + '–' + r.allPlay.l + ' all-play record is what caps this ranking.',
                    'Measured against everyone rather than one opponent a week, it gets ugly.',
                ],
                health: pos ? [
                    'A healthy roster is doing some of the work in this ranking.',
                    'Nothing on the injury report, which counts for more than people think.',
                    'The cleanest bill of health in this part of the table.',
                ] : [
                    'The roster health score is what is holding this ranking back.',
                    'The model is pricing in who is unavailable, and it is not flattering.',
                    'Injuries are the single biggest reason they sit here.',
                ],
            };
            if (!ctx.played) {
                pools.health = [
                    'On projected roster strength alone, this is roughly where ' + name + ' belongs.',
                    'Nothing but draft capital to go on, and that puts them about here.',
                    'The projections like this roster about this much. We will see.',
                ];
            }
            add('driver', 'driver', ctx.played ? 26 : 60, pools[top.k]);
        }
    }

    // ── Injuries, weighted by what the missing player was actually worth ──
    var out = r.health.out || [];
    if (out.length) {
        var lostShare = r.health.total > 0 ? r.health.lost / r.health.total : 0;
        var weight = 24 + 46 * Math.min(1, lostShare / 0.25);
        var star = out[0];
        if (out.length >= 3) {
            add('health', 'health', weight + 8, [
                'The medical staff has ' + out.length + ' names on the board, starting with ' + star.name + '. Depth is no longer a luxury.',
                out.length + ' players out. At some point this stops being bad luck and starts being the roster.',
                'Injuries to ' + out.length + ' players, ' + star.name + ' chief among them. The waiver wire is now a second job.',
                star.name + ' headlines a ' + out.length + '-man injury list. Somebody is starting a kicker they have never heard of.',
            ]);
        } else if (out.length === 2) {
            add('health', 'health', weight, [
                'The medical staff is busy — ' + out[0].name + ' and ' + out[1].name + ' are both out.',
                'Losing ' + out[0].name + ' and ' + out[1].name + ' in the same week is a rough way to find out how deep you are.',
                'Two out: ' + out[0].name + ' and ' + out[1].name + '. Neither replacement is going to thrill anyone.',
                'No ' + out[0].name + ', no ' + out[1].name + '. That is a lot of production in street clothes.',
            ]);
        } else if (star.proj == null) {
            // Acquired by trade or waiver, so there is no draft projection to judge
            // him by. Report the injury without pretending to know what it costs.
            add('health-' + star.name, 'health', weight - 4, [
                star.name + ' is out.',
                'No ' + star.name + ' this week.',
                star.name + ' is on the injury report and unavailable.',
                'They are without ' + star.name + '.',
            ]);
        } else if (star.significant) {
            add('health-' + star.name, 'health', weight, [
                'Losing ' + star.name + ' is the hole that actually matters here.',
                star.name + ' is out, and there is no version of this lineup that replaces him cleanly.',
                'No ' + star.name + '. That is a starter-sized problem, not a depth one.',
                'The ' + star.name + ' injury is the one to watch — that is real production gone.',
                'Without ' + star.name + ' this roster gets noticeably thinner in a hurry.',
                star.name + ' being out changes what this team can realistically put up.',
            ]);
        } else {
            add('health-' + star.name, 'health', weight - 10, [
                star.name + ' is out, though the lineup absorbs that one better than most.',
                'Down ' + star.name + ', which is survivable.',
                star.name + ' is unavailable, and honestly nobody will notice.',
                'The only injury is ' + star.name + ' — a depth problem, not a real one.',
                'Losing ' + star.name + ' costs them very little.',
                star.name + ' is on the shelf. The starting lineup does not blink.',
            ]);
        }
    }

    // ── Draft picks running hot or cold against their own projection ──
    // Not before Week 4: over one or two games a bye week or a single dud makes a
    // fine player look like a bust, and calling that a failed pick is just wrong.
    if (ctx.played && ctx.draftByTeam && ctx.week >= 4) {
        var pace = pwDraftPace(ctx.season, ctx.draftByTeam[r.teamId], ctx.week);
        if (pace && pace.best && pace.best.ratio >= 1.6 && pace.best.round <= 8) {
            add('draft-hit', 'draft', 38, [
                pace.best.name + ' is running at ' + pwInt(pace.best.ratio * 100) + '% of his projected pace. That round-' + pace.best.round + ' pick is paying rent.',
                'The ' + pace.best.name + ' pick looks better every week — ' + pwNum(pace.best.actual) + ' points against a pace of ' + pwNum(pace.best.expected) + '.',
            ]);
        }
        if (pace && pace.worst && pace.worst.ratio <= 0.5 && pace.worst.round <= 4) {
            add('draft-miss', 'draft', 40, [
                pace.worst.name + ' was a round-' + pace.worst.round + ' pick and is at ' + pwInt(pace.worst.ratio * 100) + '% of his expected pace. That one hurts.',
                'The ' + pace.worst.name + ' pick is not working — ' + pwNum(pace.worst.actual) + ' points where the projection wanted ' + pwNum(pace.worst.expected) + '.',
            ]);
        }
    }

    // ── Last resort ──
    // Weighted low on purpose: it only surfaces for a team with nothing else
    // interesting going on, which otherwise gets a one-sentence blurb.
    if (ctx.played && g && ctx.weekAvg > 0) {
        var vsAvg = g.pts - ctx.weekAvg;
        if (Math.abs(vsAvg) < 5) {
            add('vs-avg', 'context', 9, [
                'That is almost exactly the league average for the week, for whatever comfort that is worth.',
                'A thoroughly average score in a week that averaged ' + pwNum(ctx.weekAvg) + '.',
                'Dead-on league average. Nothing about that week was a statement.',
            ]);
        } else {
            add('vs-avg', 'context', 9, vsAvg > 0 ? [
                'That was ' + pwNum(vsAvg) + ' above the league average for the week.',
                'The week averaged ' + pwNum(ctx.weekAvg) + '. They cleared it comfortably.',
                'An above-average week in a week where that was worth something.',
            ] : [
                'That is ' + pwNum(-vsAvg) + ' below what the average team managed this week.',
                'The league averaged ' + pwNum(ctx.weekAvg) + '. They did not get close.',
                'Below the league average, which is the polite way to put it.',
            ]);
        }
    }

    // ── Movement ──
    if (r.move >= 2) {
        add('move', 'move', 18 + 7 * r.move, [
            'Up ' + r.move + ' spots this week.',
            'Climbing ' + r.move + '. The model is coming around.',
            r.move + ' places better than last week, and earned.',
        ]);
    } else if (r.move <= -2) {
        add('move', 'move', 18 + 7 * Math.abs(r.move), [
            'Down ' + Math.abs(r.move) + ' — the arrow is pointing the wrong way.',
            'Slid ' + Math.abs(r.move) + ' spots. Time to make a move.',
            'Off ' + Math.abs(r.move) + ' places. It has been a week.',
        ]);
    }

    return facts;
}

/**
 * Assemble the blurb: the game recap, then the heaviest few remaining facts, one
 * per category so nobody gets two injury sentences and eleven teams don't share
 * the same filler.
 */
function pwBlurb(r, ctx) {
    ctx = ctx || {};
    var seed = String(r.teamId) + ':' + (ctx.week || 0);
    var facts = pwFacts(r, ctx);
    var opening = null, rest = [];
    facts.forEach(function (f) {
        if (f.cat === 'game' && !opening) opening = f; else rest.push(f);
    });
    rest.sort(function (a, b) { return b.w - a.w; });

    var limit = ctx.maxFacts != null ? ctx.maxFacts : PW_MAX_FACTS;
    var used = {}, chosen = [];
    rest.forEach(function (f) {
        if (chosen.length >= limit || used[f.cat]) return;
        used[f.cat] = true;
        chosen.push(f);
    });

    var lines = [];
    if (opening) lines.push(pwPick(opening.pool, seed + opening.id));
    chosen.forEach(function (f) { lines.push(pwPick(f.pool, seed + f.id)); });
    return lines.filter(Boolean).join(' ');
}

if (typeof module !== 'undefined') {
    module.exports = {
        powerRankings, powerWithMovement, pwWeeklyScores, pwAllPlay, pwHealth,
        pwBlurb, pwFacts, pwZ, pwContext, pwHistory, pwOwnerKey, pwOrd,
        pwLastCompletedWeek, pwResolveWeek, pwWeekStats, pwWeekHighSince, pwDraftPace,
        PW_WEIGHTS, PW_HURT,
    };
}
