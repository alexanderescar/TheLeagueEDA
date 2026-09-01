const { gradeSeason, spearman, replacementLevels, normPos, letter } = require('../public/grades.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function near(a, b, tol = 1e-6) { return Math.abs(a - b) < tol; }

// ── Synthetic 12-team, 16-round draft ────────────────────────────────────────
// Talent decays with pick number; each team's skill shifts its players' value.
function makeSeason({ teams = 12, rounds = 16, seed = 1, skill = null } = {}) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const posCycle = ['RB', 'WR', 'QB', 'WR', 'RB', 'TE', 'WR', 'RB', 'QB', 'WR', 'RB', 'TE', 'WR', 'RB', 'D/ST', 'K'];
    const picks = [];
    let n = 0;
    for (let r = 0; r < rounds; r++) {
        const order = [...Array(teams).keys()];
        if (r % 2 === 1) order.reverse();                 // snake
        for (const t of order) {
            n++;
            const base = Math.max(0, 320 - n * 1.35);
            const bump = skill ? skill[t] * 12 : 0;
            const proj = base + bump + rnd() * 18;
            picks.push({
                teamId: t, pick: n, pos: posCycle[r], name: `P${n}`,
                proj: Math.round(proj * 10) / 10,
                act:  Math.round((proj + (rnd() - 0.5) * 90) * 10) / 10,
                keeper: r === 0 && t % 2 === 0,
            });
        }
    }
    return picks;
}

console.log('\nZERO-SUM INVARIANT  (scores are differentials, so they must cancel out)');
{
    const picks = makeSeason({ seed: 7 });
    const res = gradeSeason(picks, 12, null);
    const paper = res.rows.reduce((a, r) => a + r.paperScore, 0);
    const real  = res.rows.reduce((a, r) => a + r.realityScore, 0);
    ok('paper scores sum to zero', near(paper, 0, 0.6), 'sum=' + paper);
    ok('reality scores sum to zero', near(real, 0, 0.6), 'sum=' + real);
    ok('every team graded', res.rows.length === 12);
    ok('every pick assigned', res.rows.reduce((a, r) => a + r.picks.length, 0) === 192);
}

console.log('\nREPLACEMENT LEVEL  (must sit just past the last startable player)');
{
    const picks = makeSeason({ seed: 3 });
    const { levels, startersUsed } = replacementLevels(picks, 12, p => p.proj);
    ok('QB replacement uses 12 starters', startersUsed.QB === 12, JSON.stringify(startersUsed));
    ok('D/ST replacement uses 12 starters', startersUsed['D/ST'] === 12);
    ok('flex pushed RB/WR/TE past their base slots',
        (startersUsed.RB + startersUsed.WR + startersUsed.TE) === (2 + 2 + 1) * 12 + 2 * 12,
        `RB${startersUsed.RB} WR${startersUsed.WR} TE${startersUsed.TE}`);
    ok('every position has a replacement level', ['QB','RB','WR','TE','K','D/ST'].every(p => levels[p] != null));
}

console.log('\nSIGNAL  (a manager who genuinely drafted better must grade better)');
{
    // Team 0 gets a large talent bonus, team 11 a large penalty.
    const skill = [3,0,0,0,0,0,0,0,0,0,0,-3];
    const picks = makeSeason({ seed: 11, skill });
    const res = gradeSeason(picks, 12, null);
    const byPaper = res.rows.slice().sort((a, b) => b.paperScore - a.paperScore);
    ok('boosted team grades out on top', byPaper[0].teamId === 0, 'top=' + byPaper[0].teamId);
    ok('penalised team grades out last', byPaper[byPaper.length - 1].teamId === 11, 'last=' + byPaper[byPaper.length-1].teamId);
    ok('boosted team earns an A-range grade', /^A/.test(byPaper[0].paperGrade), byPaper[0].paperGrade);
}

console.log('\nCORRELATION  (Spearman must behave at the extremes)');
{
    ok('perfect agreement = +1',  near(spearman([1,2,3,4,5],[1,2,3,4,5]), 1));
    ok('perfect inversion = -1',  near(spearman([1,2,3,4,5],[5,4,3,2,1]), -1));
    ok('ties handled without NaN', spearman([1,1,2,2,3],[1,2,2,3,3]) != null);
    ok('too few points returns null', spearman([1,2],[2,1]) === null);
    ok('nulls are dropped, not counted', spearman([1,2,3,4,null],[1,2,3,4,9]) != null);
}

console.log('\nCORRELATION WIRING  (a season where the best drafters really did win)');
{
    const skill = [3,2,1.4,1,0.6,0.2,-0.2,-0.6,-1,-1.4,-2,-3];
    const picks = makeSeason({ seed: 5, skill });
    const finish = new Map(skill.map((_, i) => [i, i + 1]));   // team 0 finished 1st
    const res = gradeSeason(picks, 12, finish);
    ok('paper grade correlates strongly with finish', res.correlation > 0.7, 'r=' + res.correlation);
    ok('correlation is a real number in range', res.correlation >= -1 && res.correlation <= 1);
}

console.log('\nGRADE BANDS');
{
    ok('+2.0 sigma is A+', letter(2.0) === 'A+');
    ok(' 0.0 sigma is B/B-', ['B','B-'].includes(letter(0)), letter(0));
    ok('-2.0 sigma is F', letter(-2.0) === 'F');
    const picks = makeSeason({ seed: 21 });
    const res = gradeSeason(picks, 12, null);
    const grades = res.rows.map(r => r.paperGrade);
    ok('a normal season produces varied grades', new Set(grades).size >= 4, grades.join(','));
}

console.log('\nMISSING DATA  (undrafted-in-ESPN players must not poison the math)');
{
    const picks = makeSeason({ seed: 9 });
    picks.forEach((p, i) => { if (i % 7 === 0) { p.proj = null; p.act = null; } });
    const res = gradeSeason(picks, 12, null);
    ok('still returns all 12 teams', res.rows.length === 12);
    ok('scores remain finite', res.rows.every(r => isFinite(r.paperScore) && isFinite(r.realityScore)));
    ok('zero-sum still holds', near(res.rows.reduce((a,r)=>a+r.paperScore,0), 0, 0.6));
    ok('coverage is reported honestly', res.coverage.proj > 80 && res.coverage.proj < 90, 'proj=' + res.coverage.proj);
}

console.log('\nPICK-LEVEL STEALS AND BUSTS');
{
    const picks = makeSeason({ seed: 4 });
    const res = gradeSeason(picks, 12, null);
    const all = res.rows.flatMap(r => r.picks);
    ok('every pick has a delta', all.every(p => typeof p.delta === 'number'));
    ok('deltas cancel out across the board', near(all.reduce((a,p)=>a+p.delta,0), 0, 1e-6));
    ok('keepers are kept in the pool', all.some(p => p.keeper), 'no keepers found');
    const r0 = res.rows[0];
    ok('best pick beats worst pick', r0.bestPick.delta >= r0.worstPick.delta);
}

console.log('\nRANK FALLBACK  (2023: ESPN kept pre-draft ranks but dropped projections)');
{
    const picks = makeSeason({ seed: 13 });
    // Ranks track true value; then wipe the projections the way ESPN did for 2023.
    const order = picks.slice().sort((a, b) => b.proj - a.proj);
    order.forEach((p, i) => { p.rank = i + 1; });
    picks.forEach(p => { p.proj = null; });

    const res = gradeSeason(picks, 12, null);
    ok('falls back to rank mode', res.paperMode === 'rank', 'mode=' + res.paperMode);
    ok('zero-sum still holds in rank mode',
        near(res.rows.reduce((a, r) => a + r.paperScore, 0), 0, 0.6),
        'sum=' + res.rows.reduce((a, r) => a + r.paperScore, 0));
    ok('grades still vary', new Set(res.rows.map(r => r.paperGrade)).size >= 3);
    ok('reality grade unaffected by the projection gap',
        res.rows.every(r => isFinite(r.realityScore)));
    ok('coverage reports the gap honestly',
        res.coverage.proj === 0 && res.coverage.rank === 100,
        JSON.stringify(res.coverage));

    // A manager who reached on every pick must grade badly under rank mode.
    const reachPicks = makeSeason({ seed: 13 });
    const ord2 = reachPicks.slice().sort((a, b) => b.proj - a.proj);
    ord2.forEach((p, i) => { p.rank = i + 1; });
    // Team 5 takes the worst-ranked player available at each of his slots.
    reachPicks.filter(p => p.teamId === 5).forEach(p => { p.rank = 190; });
    reachPicks.forEach(p => { p.proj = null; });
    const res2 = gradeSeason(reachPicks, 12, null);
    const worst = res2.rows.slice().sort((a, b) => a.paperScore - b.paperScore)[0];
    ok('the manager who reached on everyone grades worst', worst.teamId === 5, 'worst=' + worst.teamId);
}

console.log('\nMODE SELECTION');
{
    const picks = makeSeason({ seed: 2 });
    ok('uses projections when they exist', gradeSeason(picks, 12, null).paperMode === 'proj');
    const none = makeSeason({ seed: 2 });
    none.forEach(p => { p.proj = null; });
    ok('no projections and no ranks = no paper grade possible',
        gradeSeason(none, 12, null).paperMode === null);
}

console.log('\nPOSITION NORMALISATION');
{
    ok('DST spelling variants collapse', normPos('DST') === 'D/ST' && normPos('D/ST') === 'D/ST');
    ok('kicker variants collapse', normPos('PK') === 'K' && normPos('K') === 'K');
    ok('unknown slots rejected', normPos('Slot23') === null && normPos('FLEX') === null);
    ok('null-safe', normPos(null) === null);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
