/**
 * grades.js — draft grading model for The League.
 *
 * Answers: does drafting well actually predict where you finish?
 *
 * Method
 * ------
 * 1. VALUE OVER REPLACEMENT. Raw points can't be compared across positions — a QB's
 *    300 points is ordinary, an RB's 300 is elite. Each player is scored above the
 *    "replacement" player at his position: the best guy you could have had for free
 *    once every starting slot in the league is filled. FLEX slots are allocated
 *    greedily to whichever RB/WR/TE actually deserve them.
 *
 * 2. EXPECTED VALUE BY DRAFT SLOT. Sort every drafted player by value; the 1st pick
 *    "should" land the best, the 50th the 50th-best. That curve is built from the
 *    league's own draft board each year, so it needs no external ADP and adapts to
 *    each season's player pool.
 *
 * 3. TWO GRADES. Paper Grade uses preseason projections (what you should have known
 *    on draft day). Reality Grade uses actual season points (what those picks did).
 *    Same picks, same slots — only the outcome measure changes. The gap between them
 *    separates "drafted badly" from "drafted fine, players got hurt".
 *
 * Keepers ARE included — a keeper was drafted by that manager at some point.
 *
 * Every score is a differential against the board, so across a season the twelve
 * team scores necessarily sum to zero. That invariant is the model's own unit test.
 */

// Starting lineup, from the league's roster settings (unchanged 2018-2025).
const LINEUP = { QB: 1, RB: 2, WR: 2, TE: 1, 'D/ST': 1, K: 1 };
const FLEX_SLOTS = 2;                       // per team
const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

function normPos(p) {
    if (!p) return null;
    const s = String(p).toUpperCase().replace(/\s/g, '');
    if (s === 'DST' || s === 'D/ST' || s === 'DEF') return 'D/ST';
    if (s === 'PK') return 'K';
    return ['QB', 'RB', 'WR', 'TE', 'K'].includes(s) ? s : null;
}

/**
 * Replacement level per position: the points of the best player who would go
 * unstarted if every team filled its lineup optimally.
 */
function replacementLevels(players, teamCount, valueOf) {
    const byPos = {};
    for (const p of players) {
        const pos = normPos(p.pos);
        if (!pos) continue;
        const v = valueOf(p);
        if (v == null) continue;
        (byPos[pos] = byPos[pos] || []).push(v);
    }
    for (const pos of Object.keys(byPos)) byPos[pos].sort((a, b) => b - a);

    // Base starters, then hand out FLEX slots to the best remaining RB/WR/TE.
    const used = {};
    for (const pos of Object.keys(LINEUP)) used[pos] = LINEUP[pos] * teamCount;

    let flexLeft = FLEX_SLOTS * teamCount;
    while (flexLeft > 0) {
        let bestPos = null, bestVal = -Infinity;
        for (const pos of FLEX_ELIGIBLE) {
            const pool = byPos[pos];
            if (!pool) continue;
            const next = pool[used[pos]];        // next unstarted player at this position
            if (next != null && next > bestVal) { bestVal = next; bestPos = pos; }
        }
        if (!bestPos) break;                     // pool exhausted
        used[bestPos]++;
        flexLeft--;
    }

    const levels = {};
    for (const pos of Object.keys(byPos)) {
        const pool = byPos[pos];
        const idx = used[pos] != null ? used[pos] : pool.length;
        // Replacement = the best player left undrafted-into-a-lineup at that position.
        levels[pos] = pool[idx] != null ? pool[idx] : (pool[pool.length - 1] || 0);
    }
    return { levels, startersUsed: used };
}

/** Value over replacement, floored at zero: a bad bench pick costs you nothing. */
function vorFor(players, teamCount, valueOf) {
    const { levels, startersUsed } = replacementLevels(players, teamCount, valueOf);
    const vor = new Map();
    for (const p of players) {
        const pos = normPos(p.pos);
        const v = valueOf(p);
        if (pos == null || v == null) { vor.set(p, null); continue; }
        vor.set(p, Math.max(0, v - (levels[pos] || 0)));
    }
    return { vor, levels, startersUsed };
}

/**
 * Score one season.
 * picks: [{ teamId, pick (overall #), pos, proj, act, name, keeper }]
 * finish: Map teamId -> final rank (1 = champion)
 */
function gradeSeason(picks, teamCount, finish) {
    const usable = picks.filter(p => p.pick != null && p.teamId != null);
    if (!usable.length) return null;

    const hasProj = usable.filter(p => p.proj != null).length / usable.length;
    const hasAct  = usable.filter(p => p.act  != null).length / usable.length;

    const projVor = vorFor(usable, teamCount, p => p.proj);
    const actVor  = vorFor(usable, teamCount, p => p.act);

    // Expected value at each draft slot: the sorted value curve of this year's board.
    const curve = (vorMap) => usable
        .map(p => vorMap.get(p) || 0)
        .sort((a, b) => b - a);
    const projCurve = curve(projVor.vor);
    const actCurve  = curve(actVor.vor);

    // Rank every player by what he actually returned, to grade individual picks.
    const byActual = usable.slice().sort((a, b) => (actVor.vor.get(b) || 0) - (actVor.vor.get(a) || 0));
    const actualRank = new Map();
    byActual.forEach((p, i) => actualRank.set(p, i + 1));

    const teams = new Map();
    for (const p of usable) {
        if (!teams.has(p.teamId)) {
            teams.set(p.teamId, { teamId: p.teamId, picks: [], projGot: 0, projExp: 0, actGot: 0, actExp: 0 });
        }
        const t = teams.get(p.teamId);
        const pv = projVor.vor.get(p) || 0;
        const av = actVor.vor.get(p) || 0;
        const slot = p.pick - 1;
        t.projGot += pv;
        t.actGot  += av;
        t.projExp += projCurve[slot] != null ? projCurve[slot] : 0;
        t.actExp  += actCurve[slot]  != null ? actCurve[slot]  : 0;
        t.picks.push({
            name: p.name, pos: normPos(p.pos), pick: p.pick, keeper: !!p.keeper,
            proj: p.proj, act: p.act, projVor: round(pv), actVor: round(av),
            actualRank: actualRank.get(p),
            // Positive = returned better than the slot he was taken at.
            delta: p.pick - actualRank.get(p),
        });
    }

    const rows = [...teams.values()].map(t => ({
        teamId: t.teamId,
        paperScore:   round(t.projGot - t.projExp),
        realityScore: round(t.actGot  - t.actExp),
        projTotal: round(t.projGot),
        actTotal:  round(t.actGot),
        finish: finish ? finish.get(t.teamId) : null,
        picks: t.picks.sort((a, b) => a.pick - b.pick),
    }));

    addGrades(rows, 'paperScore',   'paperGrade');
    addGrades(rows, 'realityScore', 'realityGrade');
    for (const r of rows) {
        const best  = r.picks.slice().sort((a, b) => b.delta - a.delta)[0];
        const worst = r.picks.slice().sort((a, b) => a.delta - b.delta)[0];
        r.bestPick  = best;
        r.worstPick = worst;
        r.verdict   = verdictFor(r, rows.length);
    }

    return {
        rows,
        coverage: { proj: round(hasProj * 100), act: round(hasAct * 100) },
        replacement: { proj: projVor.levels, act: actVor.levels },
        correlation: spearman(
            rows.map(r => -r.paperScore),          // negate: better score -> better (lower) rank
            rows.map(r => r.finish)
        ),
        realityCorrelation: spearman(
            rows.map(r => -r.realityScore),
            rows.map(r => r.finish)
        ),
    };
}

/** Z-score within the season, then letter. Grades are relative to that year's league. */
function addGrades(rows, field, out) {
    const vals = rows.map(r => r[field]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    for (const r of rows) {
        const z = (r[field] - mean) / sd;
        r[out + 'Z'] = round(z);
        r[out] = letter(z);
    }
}

const GRADE_BANDS = [
    [1.45, 'A+'], [1.05, 'A'], [0.75, 'A-'], [0.45, 'B+'], [0.15, 'B'],
    [-0.15, 'B-'], [-0.45, 'C+'], [-0.75, 'C'], [-1.05, 'C-'], [-1.45, 'D'],
];
function letter(z) {
    for (const [cut, g] of GRADE_BANDS) if (z >= cut) return g;
    return 'F';
}

function verdictFor(row, n) {
    if (row.finish == null) return null;
    const goodDraft = row.paperGradeZ > 0.25;
    const badDraft  = row.paperGradeZ < -0.25;
    const goodYear  = row.finish <= Math.ceil(n / 3);
    const badYear   = row.finish >  Math.ceil((2 * n) / 3);
    if (goodDraft && goodYear) return 'Delivered';
    if (goodDraft && badYear)  return 'Wasted a great draft';
    if (badDraft  && goodYear) return 'Bad draft, good year';
    if (badDraft  && badYear)  return 'Never had a chance';
    return 'About as expected';
}

/** Spearman rank correlation, average-rank tie handling. */
function spearman(xs, ys) {
    const pairs = xs.map((x, i) => [x, ys[i]]).filter(p => p[0] != null && p[1] != null);
    const n = pairs.length;
    if (n < 3) return null;
    const rank = (vals) => {
        const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
        const r = new Array(vals.length);
        let i = 0;
        while (i < idx.length) {
            let j = i;
            while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
            const avg = (i + j) / 2 + 1;
            for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
            i = j + 1;
        }
        return r;
    };
    const rx = rank(pairs.map(p => p[0]));
    const ry = rank(pairs.map(p => p[1]));
    const mx = rx.reduce((a, b) => a + b, 0) / n;
    const my = ry.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        num += (rx[i] - mx) * (ry[i] - my);
        dx  += (rx[i] - mx) ** 2;
        dy  += (ry[i] - my) ** 2;
    }
    if (!dx || !dy) return null;
    return round(num / Math.sqrt(dx * dy), 3);
}

function round(v, d = 1) {
    if (v == null || !isFinite(v)) return v;
    const m = Math.pow(10, d);
    return Math.round(v * m) / m;
}

if (typeof module !== 'undefined') {
    module.exports = { gradeSeason, spearman, replacementLevels, vorFor, normPos, letter, LINEUP };
}
