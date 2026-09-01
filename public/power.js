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
 */

var PW_WEIGHTS = { form: 0.35, season: 0.25, allPlay: 0.25, health: 0.15 };
var PW_FORM_WEEKS = [0.5, 0.3, 0.2];      // most recent week first
var PW_HURT = { OUT: 1, INJURY_RESERVE: 1, DOUBTFUL: 0.75, QUESTIONABLE: 0.3, DAY_TO_DAY: 0.3 };

function pwZ(vals) {
    var n = vals.length;
    if (!n) return [];
    var mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
    var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / n) || 1;
    return vals.map(function (v) { return (v - mean) / sd; });
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

/** Roster strength with injured players discounted. */
function pwHealth(roster, projByPlayer) {
    if (!roster || !roster.length) return { score: null, out: [], questionable: [] };
    var outList = [], qList = [];
    var total = 0;
    roster.forEach(function (p) {
        var proj = projByPlayer && projByPlayer[p.playerId] != null ? projByPlayer[p.playerId] : null;
        var weight = 1 - (PW_HURT[p.status] || 0);
        if (PW_HURT[p.status] >= 0.75) outList.push(p);
        else if (PW_HURT[p.status] > 0) qList.push(p);
        if (proj != null) total += proj * weight;
    });
    return { score: Math.round(total * 10) / 10, out: outList, questionable: qList };
}

/**
 * Compute the power ranking as of a given week.
 * Returns rows sorted best-first.
 */
function powerRankings(season, throughWeek, projByPlayer) {
    var teams = (season.teams || []);
    if (!teams.length) return null;
    var weekly = pwWeeklyScores(season.schedule, throughWeek);
    var played = Object.keys(weekly).length > 0;
    var allPlay = played ? pwAllPlay(weekly, throughWeek) : {};

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

    rows.sort(function (a, b) { return b.score - a.score; });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return { rows: rows, played: played, throughWeek: throughWeek };
}

/** Movement vs the previous week's ranking. */
function powerWithMovement(season, throughWeek, projByPlayer) {
    var now = powerRankings(season, throughWeek, projByPlayer);
    if (!now) return null;
    var prev = throughWeek > 1 ? powerRankings(season, throughWeek - 1, projByPlayer) : null;
    var prevRank = {};
    if (prev) prev.rows.forEach(function (r) { prevRank[r.teamId] = r.rank; });
    now.rows.forEach(function (r) {
        r.prevRank = prevRank[r.teamId] != null ? prevRank[r.teamId] : null;
        r.move = r.prevRank == null ? 0 : r.prevRank - r.rank;
    });
    return now;
}

// ── Commentary ───────────────────────────────────────────────────────────────
// Lines are picked from pools keyed to what actually happened, and seeded by team
// and week so the same team never gets the same line twice running.
function pwPick(pool, seed) {
    if (!pool.length) return '';
    var h = 0;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return pool[h % pool.length];
}

function pwBlurb(r, ctx) {
    var name = ctx.name;
    var seed = String(r.teamId) + ':' + (ctx.week || 0);
    var g = r.lastGame;
    var lines = [];

    // ── Opening: what just happened ──
    if (!ctx.played) {
        lines.push(pwPick([
            name + ' hasn\'t played a snap yet, so this is pure roster projection and vibes.',
            'Nothing to judge ' + name + ' on but the draft board so far.',
            'Week 1 will tell us more about ' + name + ' than any projection can.',
        ], seed));
    } else if (g) {
        var margin = Math.abs(g.pts - g.oppPts);
        var won = g.pts > g.oppPts;
        var oppName = ctx.oppName || 'their opponent';
        if (won && margin >= 40) {
            lines.push(pwPick([
                name + ' didn\'t beat ' + oppName + ' so much as file a police report — ' + g.pts.toFixed(1) + ' to ' + g.oppPts.toFixed(1) + '.',
                'A ' + margin.toFixed(0) + '-point win over ' + oppName + '. ' + name + ' was never in danger.',
                name + ' put up ' + g.pts.toFixed(1) + ' and turned ' + oppName + ' into a rounding error.',
            ], seed));
        } else if (won && margin <= 5) {
            lines.push(pwPick([
                name + ' escaped ' + oppName + ' by ' + margin.toFixed(1) + '. A win is a win, but that one needed a shower.',
                'Survived. ' + name + ' beat ' + oppName + ' by ' + margin.toFixed(1) + ' and shouldn\'t look too closely at how.',
                name + ' won by ' + margin.toFixed(1) + '. Somewhere ' + oppName + ' is still staring at the bench.',
            ], seed));
        } else if (won) {
            lines.push(pwPick([
                name + ' handled ' + oppName + ', ' + g.pts.toFixed(1) + '–' + g.oppPts.toFixed(1) + '.',
                'Business as usual: ' + name + ' over ' + oppName + ' by ' + margin.toFixed(1) + '.',
                name + ' took care of ' + oppName + ' without much drama.',
            ], seed));
        } else if (!won && g.pts >= ctx.weekHigh - 0.01) {
            lines.push(pwPick([
                name + ' scored the most points in the league and lost. That\'s the schedule for you.',
                'Led the week in scoring with ' + g.pts.toFixed(1) + ' and still took the L. Brutal.',
                name + ' put up a league-best ' + g.pts.toFixed(1) + ' and got nothing for it.',
            ], seed));
        } else if (!won && margin <= 5) {
            lines.push(pwPick([
                name + ' lost to ' + oppName + ' by ' + margin.toFixed(1) + '. That one will sting all week.',
                margin.toFixed(1) + ' points short against ' + oppName + '. Every bench decision is now a war crime.',
                name + ' came up ' + margin.toFixed(1) + ' short. Painful.',
            ], seed));
        } else if (!won && margin >= 40) {
            lines.push(pwPick([
                name + ' got run off the field by ' + oppName + ', losing by ' + margin.toFixed(0) + '.',
                'Nothing worked. ' + name + ' managed ' + g.pts.toFixed(1) + ' against ' + oppName + '.',
                name + ' was never in this one — down ' + margin.toFixed(0) + ' to ' + oppName + '.',
            ], seed));
        } else {
            lines.push(pwPick([
                name + ' fell to ' + oppName + ', ' + g.oppPts.toFixed(1) + '–' + g.pts.toFixed(1) + '.',
                'A quiet loss to ' + oppName + ' for ' + name + '.',
                name + ' didn\'t have enough against ' + oppName + '.',
            ], seed));
        }
    }

    // ── The gap between record and quality ──
    if (ctx.played && r.played >= 3) {
        var apPct = r.allPlay.pct;
        var winPct = r.played ? r.wins / r.played : 0;
        if (apPct - winPct > 0.18) {
            lines.push(pwPick([
                'The all-play record says ' + name + ' is much better than ' + r.wins + '–' + r.losses + ' suggests; they\'ve just kept drawing the wrong week.',
                'Against the whole league they\'d be ' + r.allPlay.w + '–' + r.allPlay.l + '. The schedule is doing them dirty.',
                'Genuinely unlucky. ' + name + ' scores like a contender and has the record of a bystander.',
            ], seed + 'a'));
        } else if (winPct - apPct > 0.18) {
            lines.push(pwPick([
                'Fair warning: ' + name + ' is ' + r.wins + '–' + r.losses + ' but only ' + r.allPlay.w + '–' + r.allPlay.l + ' against the field. That record is on loan.',
                'The record flatters them. ' + name + ' has been beating whoever happened to be worse that week.',
                'Regression is coming for ' + name + '. The scoring doesn\'t match the win column.',
            ], seed + 'a'));
        }
    }

    // ── Injuries ──
    var out = r.health.out || [];
    if (out.length >= 2) {
        lines.push(pwPick([
            'The medical staff is busy — ' + out.slice(0, 2).map(function (p) { return p.name; }).join(' and ') + ' are out.',
            out.length + ' players sidelined, including ' + out[0].name + '. Depth is about to get tested.',
        ], seed + 'i'));
    } else if (out.length === 1) {
        lines.push(out[0].name + ' being out is the obvious hole to patch.');
    }

    // ── Movement ──
    if (r.move >= 3) {
        lines.push(pwPick([
            'Up ' + r.move + ' spots this week.',
            'Biggest riser in the room, climbing ' + r.move + '.',
        ], seed + 'm'));
    } else if (r.move <= -3) {
        lines.push(pwPick([
            'Down ' + Math.abs(r.move) + ' — the arrow is pointing the wrong way.',
            'Slid ' + Math.abs(r.move) + ' spots. Time to make a move.',
        ], seed + 'm'));
    }

    return lines.join(' ');
}

if (typeof module !== 'undefined') {
    module.exports = {
        powerRankings, powerWithMovement, pwWeeklyScores, pwAllPlay, pwHealth,
        pwBlurb, pwZ, PW_WEIGHTS, PW_HURT,
    };
}
