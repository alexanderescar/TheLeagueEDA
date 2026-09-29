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

/**
 * A mark per award and per notice category. Keyed on the label so a new award
 * degrades to no mark rather than the wrong one.
 */
var GZ_AWARD_ICON = {
    'Worst Start/Sit': '🤦', 'Most Left on the Bench': '🪑',
    'Player of the Week': '🔥', 'Goose Egg': '🥚',
    'Unluckiest Loss': '💔', 'Luckiest Win': '🍀',
    'Coach of the Week': '🧠', 'The Perfect Lineup': '💯',
    'Waiver Wire Steal': '🕵️', 'Draft Day Ghost': '👻',
    'One-Man Band': '🎺', 'The Nail-Biter': '😬',
    'The Beatdown': '🔨', 'Sacko Watch': '🚽',
};

var GZ_NOTICE_ICON = {
    'Help Wanted': '🆘', 'Public Notice': '📣', 'Legal Notice': '⚖️',
    'Apology': '🙇', 'Personals': '💌', 'Estate Sale': '🏷️',
    'For Sale': '💰', 'Lost': '🔍',
};

function gzAwardIcon(label) { return GZ_AWARD_ICON[label] || ''; }
function gzNoticeIcon(cat) { return GZ_NOTICE_ICON[cat] || ''; }

// ── Extra weekly awards ──────────────────────────────────────────────────────

/**
 * Awards that join the existing weekly set.
 *
 * The originals are all shame or luck — worst start/sit, most left on the bench,
 * goose egg, unluckiest loss. These add the two things that were missing:
 * competence (who actually managed their roster well) and consequence (who is
 * currently on the hook for the Sacko presentation).
 *
 * Returns cards in the same shape the existing awards use — { lab, name, sub,
 * bad } — so they render in one section rather than a competing one.
 *
 * `ctx`: { projOf, draftedAt, lastPlace, weeksLeft, allTeams }
 * Every award returns nothing rather than a weak entry when its trigger is unmet.
 */
function gzExtraAwards(teams, ctx) {
    ctx = ctx || {};
    var out = [];
    var withBox = (teams || []).filter(function (t) { return t && t.box; });
    if (!withBox.length) return out;

    var starters = gzStarters(teams, ctx.projOf);
    var drafted = ctx.draftedAt || {};

    // Coach of the Week — the counterweight to the Shame Table. Efficiency only
    // means something once there was a real lineup to get wrong.
    var eff = withBox.filter(function (t) { return t.box.optimal > 0; })
        .map(function (t) {
            return { t: t, pct: t.box.actual / t.box.optimal };
        }).sort(function (a, b) { return b.pct - a.pct; })[0];
    if (eff) {
        out.push({
            lab: 'Coach of the Week', name: eff.t.manager,
            sub: Math.round(eff.pct * 1000) / 10 + '% of his optimal lineup. Left '
               + eff.t.box.left + ' on the bench and scored ' + eff.t.box.actual + '.',
        });
    }

    // The Perfect Lineup — only when someone genuinely left nothing behind.
    var perfect = withBox.filter(function (t) { return t.box.left <= 0.05; });
    if (perfect.length) {
        out.push({
            lab: 'The Perfect Lineup',
            name: perfect.map(function (t) { return t.manager; }).join(' & '),
            sub: 'Played every right man. Nothing on the bench outscored anything in the lineup.',
        });
    }

    // Waiver Wire Steal — best score from a player nobody drafted.
    var undrafted = starters.filter(function (p) { return drafted[p.id] == null; })
        .sort(function (a, b) { return b.pts - a.pts; })[0];
    if (undrafted && undrafted.pts > 0) {
        out.push({
            lab: 'Waiver Wire Steal', name: undrafted.name,
            sub: undrafted.pts + ' at ' + undrafted.pos + ' for ' + undrafted.manager
               + '. Nobody spent a pick on him in August.',
        });
    }

    // Draft Day Ghost — worst return from an early pick. Three rounds in a
    // 12-team league is the top 36 selections.
    var early = starters.filter(function (p) {
        return drafted[p.id] != null && drafted[p.id] <= 36;
    }).sort(function (a, b) { return a.pts - b.pts; })[0];
    if (early) {
        var rd = Math.ceil(drafted[early.id] / 12);
        out.push({
            lab: 'Draft Day Ghost', name: early.name,
            sub: early.pts + ' for ' + early.manager + ', a round ' + rd + ' pick'
               + (early.proj != null ? ' projected for ' + early.proj + '.' : '.'),
            bad: true,
        });
    }

    // One-Man Band — how much of a team came from a single player.
    var solo = withBox.filter(function (t) { return t.box.hero && t.box.heroShare; })
        .sort(function (a, b) { return b.box.heroShare - a.box.heroShare; })[0];
    if (solo) {
        out.push({
            lab: 'One-Man Band', name: solo.manager,
            sub: solo.box.hero.name + '’s ' + solo.box.hero.pts + ' was '
               + solo.box.heroShare + '% of everything he scored.',
        });
    }

    // The week's extremes. Both read off the same margin list.
    var margins = withBox.filter(function (t) { return t.margin > 0; })
        .sort(function (a, b) { return a.margin - b.margin; });
    if (margins.length) {
        var closest = margins[0], widest = margins[margins.length - 1];
        out.push({
            lab: 'The Nail-Biter', name: closest.manager,
            sub: 'Won by ' + gzRound(closest.margin, 1) + '. The closest game of the week.',
        });
        if (widest !== closest) {
            out.push({
                lab: 'The Beatdown', name: widest.manager,
                sub: 'Won by ' + gzRound(widest.margin, 1) + '. Nothing was in doubt.',
            });
        }
    }

    // Sacko Watch — constitution 2.2. The only award with a consequence.
    if (ctx.lastPlace) {
        out.push({
            lab: 'Sacko Watch', name: ctx.lastPlace.manager,
            sub: 'Last at ' + ctx.lastPlace.record + '. Section 2.2 owes the league a '
               + 'presentation at the next draft explaining why'
               + (ctx.weeksLeft != null ? ' — ' + ctx.weeksLeft + ' weeks to write it.' : '.'),
            bad: true,
        });
    }

    return out;
}

// ── Classified ads ───────────────────────────────────────────────────────────

/**
 * The notices column.
 *
 * Eight categories, each with its own trigger. A quiet week produces three ads
 * and a brutal one produces eight — which is the point. Fixed slots would mean
 * inventing a story on a week that didn't have one, and that is exactly how this
 * kind of thing starts reading like filler.
 *
 * Several triggers reach across the season rather than the week, because the
 * funniest material is cumulative: a tight end who has started four times for
 * nine points is a better ad than anything one Sunday produces.
 *
 * `ctx`: { projOf, standings, seasonStarts, week }
 *   standings    [{ manager, wins, losses, allPlayW, allPlayL, streak }]
 *   seasonStarts { playerId: { name, pos, manager, starts, total } }
 */
function gzClassifieds(teams, ctx) {
    ctx = ctx || {};
    var ads = [];
    var withBox = (teams || []).filter(function (t) { return t && t.box; });
    if (!withBox.length) return ads;

    var push = function (cat, head, body, contact) {
        ads.push({ category: cat, head: head, body: body, contact: contact });
    };

    // HELP WANTED — a starter who has been reliably useless all season.
    var starts = ctx.seasonStarts || {};
    var worstRegular = Object.keys(starts).map(function (k) { return starts[k]; })
        .filter(function (p) { return p.starts >= 3; })
        .map(function (p) { return { p: p, perStart: p.total / p.starts }; })
        .sort(function (a, b) { return a.perStart - b.perStart; })[0];
    if (worstRegular && worstRegular.perStart < 6) {
        var w = worstRegular.p;
        push('Help Wanted',
            'EXPERIENCED ' + String(w.pos || 'PLAYER').toUpperCase() + ' SOUGHT',
            w.name + ' has started ' + w.starts + ' games for ' + w.manager
            + ' and produced ' + gzRound(w.total, 1) + ' points combined. '
            + 'No prior success necessary.',
            'Apply within');
    }

    // PUBLIC NOTICE — a losing streak the all-play record agrees with.
    var sinking = (ctx.standings || []).filter(function (r) {
        return r.losses >= 3 && r.wins === 0;
    })[0];
    if (sinking) {
        push('Public Notice', 'BE ADVISED',
            sinking.manager + ' has now lost ' + sinking.losses + ' straight'
            + (sinking.allPlayW != null
                ? ', going ' + sinking.allPlayW + '-' + sinking.allPlayL + ' against the league as a whole'
                : '') + '. The commissioner has been informed.',
            'No action required');
    }

    // LEGAL NOTICE — the widest gap between what was scored and what was available.
    var gap = withBox.slice().sort(function (a, b) {
        return (b.box.optimal - b.box.actual) - (a.box.optimal - a.box.actual);
    })[0];
    if (gap && gap.box.optimal - gap.box.actual > 20 && gap.box.blunder) {
        push('Legal Notice', 'NOTICE OF POINTS FORFEITED',
            gap.manager + ' is hereby served notice that ' + gap.box.blunder.benched.name
            + ' scored ' + gap.box.blunder.benched.pts + ' on his bench while '
            + gap.box.blunder.started.name + ' started for ' + gap.box.blunder.started.pts
            + '. Optimal lineup ' + gap.box.optimal + '. Actual ' + gap.box.actual + '.',
            'Served this day');
    }

    // APOLOGY — owed to the benched player, not the league.
    var owed = withBox.filter(function (t) { return t.box.blunder; })
        .sort(function (a, b) { return b.box.blunder.swing - a.box.blunder.swing; })[0];
    if (owed) {
        push('Apology', 'A CORRECTION IS OFFERED',
            owed.manager + ' wishes to apologise to ' + owed.box.blunder.benched.name
            + ' (' + owed.box.blunder.benched.pts + ', benched) for starting '
            + owed.box.blunder.started.name + ' (' + owed.box.blunder.started.pts
            + '). No apology is offered to anyone else.',
            'Sincerely');
    }

    // PERSONALS — winless, but not for want of scoring.
    var unlucky = (ctx.standings || []).filter(function (r) { return r.wins === 0 && r.losses >= 2; })
        .map(function (r) {
            var t = withBox.filter(function (x) { return x.manager === r.manager; })[0];
            return { r: r, scores: r.scores || [] };
        }).filter(function (x) { return x.scores.length; })
        .sort(function (a, b) {
            var av = a.scores.reduce(function (s, n) { return s + n; }, 0) / a.scores.length;
            var bv = b.scores.reduce(function (s, n) { return s + n; }, 0) / b.scores.length;
            return bv - av;
        })[0];
    if (unlucky) {
        push('Personals', '0-' + unlucky.r.losses + ' SEEKS ANYONE',
            unlucky.r.manager + ' has posted ' + unlucky.scores.slice().sort(function (a, b) { return b - a; })
                .map(function (n) { return gzRound(n, 1); }).join(', ')
            + ' and has nothing to show for it. Will travel.',
            'Discretion assured');
    }

    // ESTATE SALE — the week's biggest pile of unused points.
    var pile = withBox.slice().sort(function (a, b) { return b.box.left - a.box.left; })[0];
    if (pile && pile.box.left > 15) {
        push('Estate Sale', pile.box.left + ' POINTS, UNUSED, MUST GO',
            'The entire contents of ' + pile.manager + '’s bench. Never started, '
            + 'never appreciated. All reasonable offers considered.',
            'Viewing by appointment');
    }

    // FOR SALE — a repeat benching that finally paid off.
    var repeat = (ctx.repeatOffences || [])[0];
    if (repeat) {
        push('For Sale', 'ONE ' + String(repeat.pos || 'PLAYER').toUpperCase() + ', LIGHTLY BENCHED',
            repeat.player + ' sat out ' + gzRound(repeat.benchedTotal, 1) + ' points across '
            + repeat.weeks.length + ' weeks before ' + repeat.manager + ' activated him'
            + (repeat.payoff != null ? ' for ' + repeat.payoff + '.' : '.')
            + ' Seller now retaining.',
            'No longer available');
    }

    // LOST — the closest game of the week, from the losing side.
    var heartbreak = withBox.filter(function (t) { return t.margin < 0; })
        .sort(function (a, b) { return b.margin - a.margin; })[0];
    if (heartbreak && Math.abs(heartbreak.margin) <= 5) {
        push('Lost', 'ONE YARD LINE, SENTIMENTAL VALUE',
            heartbreak.manager + ' lost by ' + gzRound(Math.abs(heartbreak.margin), 1)
            + '. That one play would have changed everything.',
            'Return to ' + heartbreak.manager + ', no questions asked');
    }

    return ads;
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
        gzObituaries, gzExtraAwards, gzClassifieds, gzRecords, gzSpreads,
        gzOversUnders,
        gzStarters, gzWeeklyProj, gzPick, gzHash, gzRound,
        gzAwardIcon, gzNoticeIcon, GZ_AWARD_ICON, GZ_NOTICE_ICON,
        GZ_PROJ_GAMES, GZ_OBIT_MIN_PROJ,
        GZ_OBIT_OPENERS, GZ_OBIT_CLOSERS,
    };
}
