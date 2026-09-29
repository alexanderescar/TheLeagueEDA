/**
 * gazette.js — the parts of The Week that exist to be read, not audited.
 *
 * Named awards, obituaries, classified ads, a fraud watch, a stamped record book
 * and next week's lines. Every one is derived from data already on hand; none of it
 * needs the weekly writer, so the page is never blank while it waits for prose.
 *
 * ── Why templates and not AI ─────────────────────────────────────────────────
 * The objection to template copy is that it reads the same every week. The fix is
 * not necessarily a language model — it is having enough genuinely different facts
 * to point at, plus a phrasing pool so the framing rotates. Which obituary runs is
 * decided by the data; how it is worded is decided by a week-seeded index into a
 * list. Same week always renders identically, consecutive weeks rarely rhyme.
 *
 * ── The awards are named from this league's own constitution ─────────────────
 * The Brad Johnson Rule (5.3), the Robert Meachum Rule (5.2) and the Sacko (2.2)
 * are real sections of the document these twelve people voted on. Naming the awards
 * after them means the canon is already shared, which is the entire trick — an
 * in-joke nobody has to be told.
 */

/** Season projections are full-NFL-season totals; weekly expectation is /17. */
var GZ_PROJ_GAMES = 17;

/** Below this projected total a player is a non-story; kickers dominate otherwise. */
var GZ_OBIT_MIN_PROJ = 6;

function gzRound(n, d) {
    var m = Math.pow(10, d == null ? 1 : d);
    return Math.round(n * m) / m;
}

/** Stable small hash, so a given week always picks the same phrasing. */
function gzHash(str) {
    var h = 2166136261;
    String(str).split('').forEach(function (c) {
        h ^= c.charCodeAt(0);
        h = (h * 16777619) >>> 0;
    });
    return h >>> 0;
}

/** Deterministic choice from a pool. */
function gzPick(pool, seed) {
    if (!pool || !pool.length) return '';
    return pool[gzHash(seed) % pool.length];
}

/** A player's expected points for one week, or null when unprojected. */
function gzWeeklyProj(playerId, projOf) {
    if (!projOf) return null;
    var p = projOf[playerId];
    if (p == null || !isFinite(p)) return null;
    return gzRound(p / GZ_PROJ_GAMES, 1);
}

/**
 * Flatten every started player in the week, with projection attached where we
 * have one. `teams` is [{ teamId, manager, box, margin, won }].
 */
function gzStarters(teams, projOf) {
    var out = [];
    (teams || []).forEach(function (t) {
        if (!t || !t.box) return;
        (t.box.starters || []).forEach(function (p) {
            var proj = gzWeeklyProj(p.id, projOf);
            out.push({
                id: p.id, name: p.name, pos: p.pos, pts: p.pts,
                manager: t.manager, teamId: t.teamId,
                proj: proj,
                vsProj: proj == null ? null : gzRound(p.pts - proj, 1),
            });
        });
    });
    return out;
}

// ── Obituaries ───────────────────────────────────────────────────────────────

var GZ_OBIT_OPENERS = [
    'We gather today for {name}.',
    'Say a few words for {name}.',
    'The league mourns {name}.',
    'Lights out for {name}.',
    '{name} is survived by a lineup that needed him.',
    'A moment, please, for {name}.',
];

var GZ_OBIT_CLOSERS = [
    'Survived by {mgr}, who had options.',
    'Survived by {mgr}, who started this on purpose.',
    'Survived by {mgr} and a lineup that never recovered.',
    'Survived by {mgr}, who saw the projection and believed it.',
    'Survived by {mgr}. No flowers; send waiver claims.',
    'Survived by {mgr}, who will do this again next week.',
];

/**
 * The week's biggest disappointments among STARTERS, measured against projection.
 *
 * Only projected players are eligible: without a number to miss there is no joke,
 * and a waiver pickup scoring 2 is not news. Low-projection players are excluded
 * so the list isn't three kickers.
 */
function gzObituaries(teams, projOf, week, limit) {
    var cands = gzStarters(teams, projOf).filter(function (p) {
        return p.proj != null && p.proj >= GZ_OBIT_MIN_PROJ && p.vsProj < 0;
    });
    cands.sort(function (a, b) { return a.vsProj - b.vsProj; });
    return cands.slice(0, limit || 4).map(function (p, i) {
        var seed = 'obit|' + week + '|' + p.id + '|' + i;
        return {
            name: p.name, pos: p.pos, manager: p.manager,
            proj: p.proj, pts: p.pts, missedBy: Math.abs(p.vsProj),
            opener: gzPick(GZ_OBIT_OPENERS, seed).replace('{name}', p.name),
            closer: gzPick(GZ_OBIT_CLOSERS, seed + '|c').replace('{mgr}', p.manager),
        };
    });
}

/**
 * The week's biggest beats and misses against projection.
 *
 * The obituaries are prose about four busts; this is the scannable version, and
 * the only place in the app that shows a projection next to what actually
 * happened. Unprojected players are excluded — there is nothing to compare.
 */
function gzOversUnders(teams, projOf, n) {
    var pool = gzStarters(teams, projOf).filter(function (p) { return p.vsProj != null; });
    var byDiff = pool.slice().sort(function (a, b) { return b.vsProj - a.vsProj; });
    var take = n || 5;
    return {
        overs:  byDiff.filter(function (p) { return p.vsProj > 0; }).slice(0, take),
        unders: byDiff.filter(function (p) { return p.vsProj < 0; }).slice(-take).reverse(),
    };
}

// ── Named awards ─────────────────────────────────────────────────────────────

/**
 * Awards with canon. `extra` carries league-state facts the box scores don't hold:
 * { lastPlace: {manager, record}, weeksToDraft: n }.
 */
function gzAwards(teams, projOf, week, extra) {
    extra = extra || {};
    var starters = gzStarters(teams, projOf);
    var out = [];

    // The Brad Johnson Award — constitution 5.3, the man who threw to himself.
    var top = starters.slice().sort(function (a, b) { return b.pts - a.pts; })[0];
    if (top) {
        out.push({
            key: 'bradJohnson',
            name: 'The Brad Johnson Award',
            canon: 'Section 5.3 exists because a quarterback once threw a touchdown pass '
                 + 'to himself, and this league decided that was worth 13.4 points. For the '
                 + 'biggest single performance of the week.',
            winner: top.name,
            detail: top.pts + ' at ' + top.pos + ' for ' + top.manager
                  + (top.proj != null ? ' on a projection of ' + top.proj + '.' : '.'),
        });
    }

    // The Meachum — constitution 5.2, points from a play nobody was watching for.
    //
    // The week's top scorer is usually also the biggest overperformer, which would
    // hand the same man both awards and make the page look automated. He already has
    // one; this goes to the next name down. On a week where only one player beat his
    // projection at all, the award simply doesn't run.
    var over = starters.filter(function (p) {
        return p.vsProj != null && !(top && p.id === top.id);
    }).sort(function (a, b) { return b.vsProj - a.vsProj; })[0];
    if (over && over.vsProj > 0) {
        out.push({
            key: 'meachum',
            name: 'The Meachum',
            canon: 'Rule 5.2 awards points for a play nobody was watching for, and puts the '
                 + 'burden on owners to notice. For the starter who beat his projection by most.',
            winner: over.name,
            detail: over.pts + ' against a projected ' + over.proj + ' for ' + over.manager
                  + ' — ' + gzRound(over.vsProj, 1) + ' more than anyone asked of him.',
        });
    }

    // The Sacko Watch — constitution 2.2, the presentation at next year's draft.
    if (extra.lastPlace) {
        out.push({
            key: 'sacko',
            name: 'The Sacko Watch',
            canon: 'Section 2.2: whoever finishes last delivers a presentation at the next '
                 + 'draft explaining why his team was the worst in the league.',
            winner: extra.lastPlace.manager,
            detail: 'Currently last at ' + extra.lastPlace.record + '. Time remaining to '
                  + 'prepare the slides: ' + (extra.weeksLeft != null ? extra.weeksLeft + ' weeks.' : 'all of it.'),
            bad: true,
        });
    }

    return out;
}

// ── Classified ads ───────────────────────────────────────────────────────────

/**
 * Small ads written from the week's worst moments. Each is keyed to a real fact,
 * so an empty week produces fewer ads rather than invented ones.
 */
function gzClassifieds(teams, projOf, week) {
    var ads = [];
    var withBox = (teams || []).filter(function (t) { return t && t.box; });

    // Worst start/sit of the week.
    var blunders = withBox.filter(function (t) { return t.box.blunder; })
        .sort(function (a, b) { return b.box.blunder.swing - a.box.blunder.swing; });
    if (blunders.length) {
        var b = blunders[0];
        ads.push({
            head: 'FOR SALE: ' + b.box.blunder.swing + ' POINTS, NEVER USED',
            body: b.manager + ' started ' + b.box.blunder.started.name + ' ('
                + b.box.blunder.started.pts + ') over ' + b.box.blunder.benched.name + ' ('
                + b.box.blunder.benched.pts + ').',
            contact: 'Enquire with ' + b.manager,
        });
    }

    // Most points abandoned on the bench.
    var left = withBox.slice().sort(function (a, b) { return b.box.left - a.box.left; })[0];
    if (left && left.box.left > 0) {
        ads.push({
            head: 'WANTED: SOMEONE TO READ THE PROJECTIONS',
            body: left.manager + ' left ' + left.box.left + ' on the bench. The optimal lineup '
                + 'scored ' + left.box.optimal + ' against the ' + left.box.actual + ' actually posted.',
            contact: 'No experience necessary',
        });
    }

    // A starter who scored nothing.
    var zeros = [];
    withBox.forEach(function (t) {
        (t.box.zeros || []).forEach(function (z) { zeros.push({ z: z, mgr: t.manager }); });
    });
    if (zeros.length) {
        ads.push({
            head: 'LOST: ONE ' + String(zeros[0].z.pos || 'PLAYER').toUpperCase() + ', LAST SEEN SUNDAY',
            body: zeros[0].z.name + ' was started by ' + zeros[0].mgr + ' and returned nothing at all.',
            contact: 'Reward offered',
        });
    }

    // Highest score in a loss.
    var robbed = withBox.filter(function (t) { return t.margin < 0; })
        .sort(function (a, b) { return b.box.actual - a.box.actual; })[0];
    if (robbed) {
        ads.push({
            head: 'FOUND: ' + robbed.box.actual + ' POINTS, NO WIN ATTACHED',
            body: robbed.manager + ' scored more than most of the league and lost by '
                + Math.abs(gzRound(robbed.margin, 1)) + '.',
            contact: 'Owner may collect at the commissioner\'s desk',
        });
    }

    return ads.slice(0, 4);
}

// ── Fraud watch ──────────────────────────────────────────────────────────────

var GZ_FRAUD_OPENERS = [
    'The paper is opening a formal inquiry into {mgr}.',
    'Questions are being asked about {mgr}.',
    'This paper is not accusing {mgr} of anything. This paper is simply noting the following.',
    'An investigation into {mgr} is ongoing.',
];

/**
 * Who does the record flatter most?
 *
 * All-play is the honest measure — your record against the entire league every
 * week. A team several games better in the standings than in all-play has been
 * beating whoever happened to be in front of them. `rows` is
 * [{ manager, wins, losses, allPlayW, allPlayL, ppg }].
 */
function gzFraudWatch(rows, week) {
    if (!rows || rows.length < 3) return null;
    var scored = rows.map(function (r) {
        var games = r.wins + r.losses;
        var apGames = r.allPlayW + r.allPlayL;
        if (!games || !apGames) return null;
        var winPct = r.wins / games;
        var apPct  = r.allPlayW / apGames;
        return { r: r, gap: winPct - apPct, winPct: winPct, apPct: apPct };
    }).filter(Boolean);
    if (!scored.length) return null;

    scored.sort(function (a, b) { return b.gap - a.gap; });
    var best = scored[0];
    // A gap under ~20 points of win rate is ordinary schedule noise, not a story.
    if (best.gap < 0.2) return null;

    return {
        manager: best.r.manager,
        record: best.r.wins + '-' + best.r.losses,
        allPlay: best.r.allPlayW + '-' + best.r.allPlayL,
        gap: gzRound(best.gap * 100, 0),
        opener: gzPick(GZ_FRAUD_OPENERS, 'fraud|' + week + '|' + best.r.manager)
            .replace('{mgr}', best.r.manager),
        body: best.r.manager + ' is ' + best.r.wins + '-' + best.r.losses
            + ' while going ' + best.r.allPlayW + '-' + best.r.allPlayL
            + ' against the league as a whole. The record and the performance are not '
            + 'telling the same story, and only one of them counts.',
    };
}

// ── Record book, with stamps ─────────────────────────────────────────────────

/**
 * Season records, flagged when they were set in the given week.
 *
 * `games` is every completed team-week this season:
 * [{ week, manager, pts, oppPts, oppManager }].
 */
function gzRecords(games, week) {
    if (!games || !games.length) return null;
    var byPts = games.slice().sort(function (a, b) { return b.pts - a.pts; });
    var margins = games.map(function (g) {
        return { g: g, margin: gzRound(g.pts - g.oppPts, 1) };
    });
    var wins = margins.filter(function (m) { return m.margin > 0; });

    var rec = function (label, g, value, sub) {
        if (!g) return null;
        return {
            label: label, value: value, manager: g.manager, week: g.week,
            sub: sub, isNew: Number(g.week) === Number(week),
        };
    };

    var biggest = wins.slice().sort(function (a, b) { return b.margin - a.margin; })[0];
    var closest = wins.slice().sort(function (a, b) { return a.margin - b.margin; })[0];
    var bestLoss = games.filter(function (g) { return g.pts < g.oppPts; })
        .sort(function (a, b) { return b.pts - a.pts; })[0];

    return [
        rec('Highest score', byPts[0], byPts[0] && byPts[0].pts,
            byPts[0] && ('vs ' + byPts[0].oppManager)),
        rec('Lowest score', byPts[byPts.length - 1], byPts[byPts.length - 1] && byPts[byPts.length - 1].pts,
            byPts[byPts.length - 1] && ('vs ' + byPts[byPts.length - 1].oppManager)),
        rec('Biggest blowout', biggest && biggest.g, biggest && ('+' + biggest.margin),
            biggest && ('over ' + biggest.g.oppManager)),
        rec('Closest game', closest && closest.g, closest && ('+' + closest.margin),
            closest && ('over ' + closest.g.oppManager)),
        rec('Most points in a loss', bestLoss, bestLoss && bestLoss.pts,
            bestLoss && ('to ' + bestLoss.oppManager)),
    ].filter(Boolean);
}

// ── Next week's lines ────────────────────────────────────────────────────────

/**
 * Spreads from projected team strength. Explicitly not betting advice — the
 * underlying projections predict weekly scoring at about r = 0.07, which is why
 * the app shrinks them everywhere else. These are a talking point.
 *
 * `means` is { teamId: expectedPointsPerWeek }, `games` is [{home, away}].
 */
function gzSpreads(means, games, nameOf) {
    if (!means || !games) return [];
    return games.map(function (g) {
        var h = means[g.home], a = means[g.away];
        if (h == null || a == null) return null;
        var margin = gzRound(h - a, 1);
        var favId = margin >= 0 ? g.home : g.away;
        return {
            home: nameOf ? nameOf(g.home) : g.home,
            away: nameOf ? nameOf(g.away) : g.away,
            homeProj: gzRound(h, 1),
            awayProj: gzRound(a, 1),
            favourite: nameOf ? nameOf(favId) : favId,
            spread: gzRound(Math.abs(margin), 1),
            total: gzRound(h + a, 0),
            pickem: Math.abs(margin) < 1.5,
        };
    }).filter(Boolean);
}

if (typeof module !== 'undefined') {
    module.exports = {
        gzObituaries, gzAwards, gzClassifieds, gzFraudWatch, gzRecords, gzSpreads,
        gzOversUnders,
        gzStarters, gzWeeklyProj, gzPick, gzHash, gzRound,
        GZ_PROJ_GAMES, GZ_OBIT_MIN_PROJ,
        GZ_OBIT_OPENERS, GZ_OBIT_CLOSERS, GZ_FRAUD_OPENERS,
    };
}
