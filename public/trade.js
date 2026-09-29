/**
 * trade.js — the Trade Machine, for hypothetical trades only.
 *
 * Answers one question: if these players changed hands right now, what happens to
 * each side's chance of making the playoffs?
 *
 * ── Why there is no letter grade ─────────────────────────────────────────────
 * The draft work measured how well preseason projections predict what a roster
 * actually scores: r = 0.07. That is why the playoff simulator shrinks projected
 * roster strength by 90% (PROJECTION_RELIABILITY = 0.10 in recap.js). A trade that
 * looks lopsided on paper therefore moves real playoff odds by single digits, and a
 * letter grade would imply a confidence the data does not support. So this reports
 * three things that are all defensible — the odds delta, the change in expected
 * points per week from the best legal lineup, and which positions moved — and lets
 * the reader draw the conclusion.
 *
 * ── Valuation ────────────────────────────────────────────────────────────────
 * Two sources, neither sufficient alone:
 *   preseason projection   full-season total, but only exists for drafted players
 *                          (85% of current rosters) and knows nothing about the
 *                          season actually in progress
 *   actual points to date  every rostered player has these, but three games is a
 *                          tiny sample and says nothing about a player whose role
 *                          just changed
 *
 * So they are blended with standard shrinkage: weight on actuals is
 * gamesPlayed / (gamesPlayed + PRIOR_GAMES). Early in the season the projection
 * dominates; by week 10 the actuals do. A player with no projection falls back to
 * actuals alone, which is exactly right for a waiver pickup.
 *
 * ── Roster rules ─────────────────────────────────────────────────────────────
 * Read from the league's own ESPN settings rather than assumed. Verified against
 * settings.rosterSettings on 2026-09-29.
 */

/** Starting lineup: 10 spots. Matches rosterSettings.lineupSlotCounts. */
var TR_LINEUP     = { QB: 1, RB: 2, WR: 2, TE: 1, 'D/ST': 1, K: 1 };
var TR_FLEX_COUNT = 2;
var TR_FLEX_POS   = ['RB', 'WR', 'TE'];

var TR_BENCH      = 6;                      // lineupSlotCounts["20"]
var TR_IR_SLOTS   = 1;                      // lineupSlotCounts["21"]
var TR_ACTIVE_MAX = 10 + TR_BENCH;          // 16 players not on IR
var TR_ROSTER_MAX = TR_ACTIVE_MAX + TR_IR_SLOTS;

/** rosterSettings.positionLimits, by position. -1 means no cap. */
var TR_POSITION_CAPS = { QB: 3, RB: 7, WR: 7, TE: 3, K: 3, 'D/ST': 3 };

var TR_MIN_PER_SIDE = 1;
var TR_MAX_PER_SIDE = 5;

/** ESPN season projections are full-NFL-season totals. */
var TR_PROJ_GAMES = 17;

/**
 * Shrinkage prior, in games. With 3 games played, weight on actuals is 3/(3+5) =
 * 0.375. Chosen so a hot three-week start moves a player's value but does not
 * define it — which is the same reason the simulator distrusts projections.
 */
var TR_PRIOR_GAMES = 5;

/** IR is only legal for players ESPN marks as out or on injured reserve. */
var TR_IR_ELIGIBLE = ['INJURY_RESERVE', 'OUT'];

function trNormPos(p) {
    if (!p) return null;
    var s = String(p).toUpperCase().replace(/\s/g, '');
    if (s === 'DST' || s === 'D/ST' || s === 'DEF') return 'D/ST';
    if (s === 'PK') return 'K';
    return ['QB', 'RB', 'WR', 'TE', 'K'].indexOf(s) > -1 ? s : null;
}

function trRound(n, d) {
    var m = Math.pow(10, d == null ? 1 : d);
    return Math.round(n * m) / m;
}

/**
 * Per-week value for one player.
 *
 * `proj` is a full-season total or null; `actuals` is an array of weekly scores
 * from games where the player was on a roster. Returns null only when we have
 * neither, which should not happen for a rostered player.
 */
function trPlayerValue(p) {
    if (!p) return null;
    var acts = (p.actuals || []).filter(function (x) { return typeof x === 'number' && isFinite(x); });
    var games = acts.length;
    var projPerGame = (p.proj != null && isFinite(p.proj)) ? (p.proj / TR_PROJ_GAMES) : null;
    var actPerGame  = games ? acts.reduce(function (a, b) { return a + b; }, 0) / games : null;

    if (projPerGame == null && actPerGame == null) return null;
    if (projPerGame == null) return { value: trRound(actPerGame, 2), basis: 'actuals', games: games };
    if (actPerGame  == null) return { value: trRound(projPerGame, 2), basis: 'projection', games: 0 };

    var w = games / (games + TR_PRIOR_GAMES);
    return {
        value: trRound(w * actPerGame + (1 - w) * projPerGame, 2),
        basis: 'blend',
        games: games,
        weightOnActuals: trRound(w, 3),
    };
}

/**
 * Best legal starting lineup by value, with greedy FLEX allocation.
 *
 * Deliberately the same shape as bestLineup() in recap.js. Duplicated rather than
 * imported because that one keys on `proj` and this one keys on `value`, and a
 * shared helper taking a field name would make both harder to read than this is.
 */
function trBestLineup(players) {
    var by = { QB: [], RB: [], WR: [], TE: [], K: [], 'D/ST': [] };
    players.forEach(function (p) {
        var q = trNormPos(p.pos || p.position);
        if (q && p.value != null) by[q].push(p);
    });
    Object.keys(by).forEach(function (k) {
        by[k].sort(function (a, b) { return b.value - a.value; });
    });

    var used = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, 'D/ST': 0 };
    var starters = [], total = 0, byPos = {};

    Object.keys(TR_LINEUP).forEach(function (k) {
        byPos[k] = 0;
        for (var i = 0; i < TR_LINEUP[k]; i++) {
            var p = by[k][used[k]];
            if (p) { starters.push(p); total += p.value; byPos[k] += p.value; used[k]++; }
        }
    });
    byPos.FLEX = 0;
    for (var f = 0; f < TR_FLEX_COUNT; f++) {
        var bestPos = null, bestVal = -Infinity;
        TR_FLEX_POS.forEach(function (k) {
            var p = by[k][used[k]];
            if (p && p.value > bestVal) { bestVal = p.value; bestPos = k; }
        });
        if (bestPos) {
            starters.push(by[bestPos][used[bestPos]]);
            total += bestVal; byPos.FLEX += bestVal; used[bestPos]++;
        }
    }
    return {
        starters: starters,
        total: trRound(total, 2),
        byPos: byPos,
        filled: starters.length,
        slots: 10,
    };
}

/** Count a roster by position, splitting IR out of the active count. */
function trRosterShape(players) {
    var active = 0, ir = 0, byPos = {};
    players.forEach(function (p) {
        var q = trNormPos(p.pos || p.position);
        if (q) byPos[q] = (byPos[q] || 0) + 1;
        if (p.onIr) ir++; else active++;
    });
    return { active: active, ir: ir, total: players.length, byPos: byPos };
}

function trIrEligible(p) {
    return TR_IR_ELIGIBLE.indexOf(String(p.status || '').toUpperCase()) > -1;
}

/**
 * Apply a proposed swap and report what it does to roster legality.
 *
 * `send` and `receive` are arrays of player objects already on the respective
 * rosters. Returns the resulting roster plus every rule this would break — all of
 * them, not just the first, because a manager fixing one violation wants to know
 * about the other two now rather than after another click.
 */
function trApplySide(roster, send, receive) {
    var sendIds = {};
    send.forEach(function (p) { sendIds[p.playerId] = true; });
    var kept = roster.filter(function (p) { return !sendIds[p.playerId]; });
    var after = kept.concat(receive.map(function (p) {
        // An incoming player keeps an IR designation only if the new team has a free
        // IR slot and ESPN considers them eligible; otherwise they take a real spot.
        return Object.assign({}, p, { onIr: false });
    }));

    // Re-seat IR: eligible players fill the IR slot first, best use of the space.
    var irEligible = after.filter(trIrEligible);
    var irUsed = Math.min(TR_IR_SLOTS, irEligible.length);
    var irIds = {};
    irEligible.slice(0, irUsed).forEach(function (p) { irIds[p.playerId] = true; });
    after = after.map(function (p) {
        return Object.assign({}, p, { onIr: !!irIds[p.playerId] });
    });

    var shape = trRosterShape(after);
    var violations = [];

    if (shape.active > TR_ACTIVE_MAX) {
        violations.push({
            rule: 'rosterSize',
            message: 'Roster would hold ' + shape.active + ' active players; the limit is '
                   + TR_ACTIVE_MAX + ' (plus ' + TR_IR_SLOTS + ' IR).',
            over: shape.active - TR_ACTIVE_MAX,
        });
    }
    if (shape.ir > TR_IR_SLOTS) {
        violations.push({
            rule: 'ir',
            message: 'Roster would need ' + shape.ir + ' IR slots; the league has ' + TR_IR_SLOTS + '.',
            over: shape.ir - TR_IR_SLOTS,
        });
    }
    Object.keys(TR_POSITION_CAPS).forEach(function (pos) {
        var cap = TR_POSITION_CAPS[pos];
        if (cap < 0) return;
        var have = shape.byPos[pos] || 0;
        if (have > cap) {
            violations.push({
                rule: 'positionCap',
                pos: pos,
                message: 'Roster would hold ' + have + ' ' + pos + 's; the limit is ' + cap + '.',
                over: have - cap,
            });
        }
    });

    return { roster: after, shape: shape, violations: violations };
}

/** Validate the shape of the proposal itself, before touching rosters. */
function trValidateProposal(sendA, sendB) {
    var errs = [];
    var a = sendA || [], b = sendB || [];
    if (a.length < TR_MIN_PER_SIDE || b.length < TR_MIN_PER_SIDE) {
        errs.push({ rule: 'minPlayers', message: 'Each side has to send at least ' + TR_MIN_PER_SIDE + ' player.' });
    }
    if (a.length > TR_MAX_PER_SIDE || b.length > TR_MAX_PER_SIDE) {
        errs.push({ rule: 'maxPlayers', message: 'Each side can send at most ' + TR_MAX_PER_SIDE + ' players.' });
    }
    var ids = {}, dupe = false;
    a.concat(b).forEach(function (p) {
        if (ids[p.playerId]) dupe = true;
        ids[p.playerId] = true;
    });
    if (dupe) errs.push({ rule: 'duplicate', message: 'The same player appears twice in this trade.' });
    return errs;
}

/**
 * Evaluate a hypothetical trade.
 *
 * rosters:    { teamId: [ {playerId, name, position, status, onIr, proj, actuals} ] }
 * teamIdA/B:  the two teams
 * sendA/sendB: arrays of playerIds each side gives up
 *
 * sim(teamMeans) must return { teamId: { playoffPct, ... } } and MUST be called
 * with an identical seed for both runs — see the note in trTradeImpact.
 */
function trEvaluate(rosters, teamIdA, teamIdB, sendAIds, sendBIds) {
    var rA = (rosters[teamIdA] || []).slice();
    var rB = (rosters[teamIdB] || []).slice();

    var pick = function (roster, ids) {
        return (ids || []).map(function (id) {
            return roster.filter(function (p) { return String(p.playerId) === String(id); })[0];
        }).filter(Boolean);
    };
    var sendA = pick(rA, sendAIds);
    var sendB = pick(rB, sendBIds);

    var proposalErrors = trValidateProposal(sendA, sendB);
    var missing = (sendAIds || []).length - sendA.length + ((sendBIds || []).length - sendB.length);
    if (missing > 0) {
        proposalErrors.push({ rule: 'notOnRoster', message: missing + ' selected player(s) are not on that roster.' });
    }

    var sideA = trApplySide(rA, sendA, sendB);
    var sideB = trApplySide(rB, sendB, sendA);

    var valued = function (list) {
        return list.map(function (p) {
            var v = trPlayerValue(p);
            return Object.assign({}, p, { value: v ? v.value : null, valueBasis: v ? v.basis : null });
        });
    };

    var beforeA = trBestLineup(valued(rA)), afterA = trBestLineup(valued(sideA.roster));
    var beforeB = trBestLineup(valued(rB)), afterB = trBestLineup(valued(sideB.roster));

    var posDelta = function (before, after) {
        var out = {};
        Object.keys(after.byPos).forEach(function (k) {
            out[k] = trRound((after.byPos[k] || 0) - (before.byPos[k] || 0), 2);
        });
        return out;
    };

    return {
        legal: proposalErrors.length === 0 && !sideA.violations.length && !sideB.violations.length,
        proposalErrors: proposalErrors,
        sides: {
            a: {
                teamId: teamIdA,
                gives: sendA.map(function (p) { return p.name; }),
                gets:  sendB.map(function (p) { return p.name; }),
                violations: sideA.violations,
                shape: sideA.shape,
                lineupBefore: beforeA.total,
                lineupAfter: afterA.total,
                lineupDelta: trRound(afterA.total - beforeA.total, 2),
                byPosDelta: posDelta(beforeA, afterA),
                roster: sideA.roster,
            },
            b: {
                teamId: teamIdB,
                gives: sendB.map(function (p) { return p.name; }),
                gets:  sendA.map(function (p) { return p.name; }),
                violations: sideB.violations,
                shape: sideB.shape,
                lineupBefore: beforeB.total,
                lineupAfter: afterB.total,
                lineupDelta: trRound(afterB.total - beforeB.total, 2),
                byPosDelta: posDelta(beforeB, afterB),
                roster: sideB.roster,
            },
        },
    };
}

/**
 * Full impact including playoff odds.
 *
 * `simFn(meansById)` runs the simulation. It is injected so this module stays
 * testable without pulling in 10,000 Monte Carlo iterations.
 *
 * The two runs MUST share a seed. With 10k iterations each run carries roughly a
 * point of noise; an unpaired before/after comparison would manufacture deltas the
 * same size as the effect being measured. Pairing the random draws makes the
 * difference attributable to the trade and nothing else.
 */
function trTradeImpact(rosters, teamIdA, teamIdB, sendAIds, sendBIds, simFn) {
    var evaln = trEvaluate(rosters, teamIdA, teamIdB, sendAIds, sendBIds);
    if (!simFn) return evaln;

    var valueOfRoster = function (list) {
        return trBestLineup(list.map(function (p) {
            var v = trPlayerValue(p);
            return Object.assign({}, p, { value: v ? v.value : null });
        })).total;
    };

    var meansBefore = {}, meansAfter = {};
    Object.keys(rosters).forEach(function (tid) {
        var v = valueOfRoster(rosters[tid]);
        meansBefore[tid] = v;
        meansAfter[tid]  = v;
    });
    meansAfter[teamIdA] = valueOfRoster(evaln.sides.a.roster);
    meansAfter[teamIdB] = valueOfRoster(evaln.sides.b.roster);

    var before = simFn(meansBefore);
    var after  = simFn(meansAfter);

    [['a', teamIdA], ['b', teamIdB]].forEach(function (pair) {
        var key = pair[0], tid = pair[1];
        var b = (before && before[tid]) || null;
        var a = (after && after[tid]) || null;
        evaln.sides[key].odds = {
            before: b ? b.playoffPct : null,
            after:  a ? a.playoffPct : null,
            delta:  (b && a) ? trRound(a.playoffPct - b.playoffPct, 1) : null,
            titleBefore: b ? b.titlePct : null,
            titleAfter:  a ? a.titlePct : null,
        };
    });
    evaln.oddsAll = { before: before, after: after };
    return evaln;
}

/**
 * Plain-language read on the result. Deliberately hedged: see the header note on
 * why no letter grade appears anywhere in this file.
 */
function trVerdict(side) {
    var d = side.odds && side.odds.delta;
    var l = side.lineupDelta;
    if (d == null) {
        if (l > 1.5)  return 'Stronger lineup';
        if (l < -1.5) return 'Weaker lineup';
        return 'Roughly even';
    }
    if (d >= 5)  return 'Clear win';
    if (d >= 2)  return 'Helps';
    if (d > -2)  return 'Too close to call';
    if (d > -5)  return 'Hurts';
    return 'Clear loss';
}

if (typeof module !== 'undefined') {
    module.exports = {
        trPlayerValue, trBestLineup, trRosterShape, trApplySide, trValidateProposal,
        trEvaluate, trTradeImpact, trVerdict, trNormPos, trIrEligible,
        TR_LINEUP, TR_FLEX_COUNT, TR_FLEX_POS, TR_BENCH, TR_IR_SLOTS,
        TR_ACTIVE_MAX, TR_ROSTER_MAX, TR_POSITION_CAPS,
        TR_MIN_PER_SIDE, TR_MAX_PER_SIDE, TR_PRIOR_GAMES, TR_PROJ_GAMES,
    };
}
