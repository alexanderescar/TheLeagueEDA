const T = require('../public/trade.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

let nextId = 1;
function P(pos, opts) {
    opts = opts || {};
    return {
        playerId: opts.id != null ? opts.id : nextId++,
        name: opts.name || (pos + '-' + nextId),
        position: pos,
        status: opts.status || 'ACTIVE',
        onIr: !!opts.onIr,
        proj: opts.proj != null ? opts.proj : null,
        actuals: opts.actuals || [],
    };
}

/**
 * A legal 16-man active roster: 2 QB, 5 RB, 5 WR, 2 TE, 1 K, 1 D/ST.
 *
 * 16 is the real cap — verified against the live league, where every team carries
 * 10 starters plus 5-6 bench plus 0-1 IR. The first version of this fixture had 17
 * active players and every roster-size assertion failed, which was the fixture
 * being illegal rather than the code being wrong.
 */
function roster(seed) {
    const mk = (pos, n, base) => Array.from({ length: n }, (_, i) =>
        P(pos, { name: pos + (i + 1) + '-' + seed, proj: base - i * 12, actuals: [] }));
    return [].concat(
        mk('QB', 2, 300), mk('RB', 5, 240), mk('WR', 5, 220),
        mk('TE', 2, 150), mk('K', 1, 130), mk('D/ST', 1, 120)
    );
}

console.log('\nVALUATION  (blend of projection and actuals)');
{
    // 255 projected over 17 games = 15/game.
    const projOnly = T.trPlayerValue(P('RB', { proj: 255 }));
    ok('projection alone converts to per-game', projOnly.value === 15, JSON.stringify(projOnly));
    ok('and is labelled as such', projOnly.basis === 'projection');

    const actOnly = T.trPlayerValue(P('WR', { actuals: [20, 10, 12] }));
    ok('actuals alone average per game', actOnly.value === 14, JSON.stringify(actOnly));
    ok('a waiver pickup with no projection still gets a value', actOnly.basis === 'actuals');

    // 3 games, prior 5 -> weight 0.375 on actuals.
    const blend = T.trPlayerValue(P('RB', { proj: 170, actuals: [30, 30, 30] }));
    const expected = Math.round((0.375 * 30 + 0.625 * 10) * 100) / 100;
    ok('blend weights actuals by games/(games+prior)', blend.value === expected,
        blend.value + ' vs ' + expected);
    ok('weight is reported', blend.weightOnActuals === 0.375, String(blend.weightOnActuals));
    ok('a hot start moves value but does not define it',
        blend.value > 10 && blend.value < 30, String(blend.value));

    ok('no data at all yields null', T.trPlayerValue(P('TE')) === null);
    ok('null player is safe', T.trPlayerValue(null) === null);
    ok('garbage actuals are ignored',
        T.trPlayerValue(P('RB', { proj: 170, actuals: [NaN, null, 'x'] })).basis === 'projection');
}

console.log('\nREAL-DATA EDGE CASES  (all observed in the live league)');
{
    // Isiah Pacheco is projected 0, not null. Zero is a real projection and must not
    // be confused with missing data.
    const zero = T.trPlayerValue(P('RB', { proj: 0, actuals: [0, 0, 0] }));
    ok('a projection of zero is a projection, not a gap', zero !== null && zero.value === 0,
        JSON.stringify(zero));
    ok('and it is not treated as actuals-only', zero.basis === 'blend');

    // Kyler Murray went for -0.38; defenses go negative regularly.
    const neg = T.trPlayerValue(P('QB', { proj: 277.7, actuals: [-0.38, 12.42] }));
    ok('negative weekly scores are kept, not dropped', neg.games === 2, String(neg.games));
    ok('and drag the value down', neg.value < 277.7 / 17, String(neg.value));

    // D/ST carry negative ESPN player ids (-16025). They must survive id handling.
    const dst = P('D/ST', { id: -16025, name: '49ers D/ST', actuals: [10, 2] });
    ok('a negative player id is a valid id', T.trPlayerValue(dst).value === 6);
    const rosterWithDst = roster('dst').concat([dst]);
    const shape = T.trRosterShape(rosterWithDst);
    ok('and counts against the D/ST cap', shape.byPos['D/ST'] === 2, String(shape.byPos['D/ST']));

    // Jonah Coleman is INJURY_RESERVE by status but sits on the bench, not in the IR
    // slot. Eligibility and current placement are different things.
    const benchedHurt = P('RB', { status: 'INJURY_RESERVE', onIr: false, actuals: [0, 13.3, 0] });
    ok('IR eligibility is independent of current placement', T.trIrEligible(benchedHurt));
    const r = roster('j');
    const moved = T.trApplySide(r, [r[2]], [benchedHurt]);
    ok('an eligible player is seated on IR when a slot is free', moved.shape.ir === 1);

    // Tyler Shough and several others have exactly one game played.
    const one = T.trPlayerValue(P('QB', { proj: 272.1, actuals: [31.8] }));
    ok('a single game still blends', one.basis === 'blend' && one.games === 1);
    ok('but barely moves the projection', Math.abs(one.value - 272.1 / 17) < 3,
        one.value + ' vs ' + (272.1 / 17).toFixed(2));
}

console.log('\nSHRINKAGE MOVES WITH THE SEASON');
{
    const early = T.trPlayerValue(P('RB', { proj: 170, actuals: [30] }));
    const late  = T.trPlayerValue(P('RB', { proj: 170, actuals: Array(12).fill(30) }));
    ok('more games means more weight on actuals', late.value > early.value,
        early.value + ' -> ' + late.value);
    ok('by week 12 actuals dominate', late.weightOnActuals > 0.7, String(late.weightOnActuals));
    ok('in week 1 the projection dominates', early.weightOnActuals < 0.2, String(early.weightOnActuals));
}

console.log('\nBEST LINEUP  (10 slots: QB/2RB/2WR/TE/DST/K + 2 FLEX)');
{
    const players = [].concat(
        [P('QB', { proj: 340 })],
        Array.from({ length: 4 }, (_, i) => P('RB', { proj: 255 - i * 17 })),
        Array.from({ length: 4 }, (_, i) => P('WR', { proj: 238 - i * 17 })),
        [P('TE', { proj: 170 }), P('K', { proj: 136 }), P('D/ST', { proj: 119 })]
    ).map(p => Object.assign(p, { value: T.trPlayerValue(p).value }));

    const lu = T.trBestLineup(players);
    ok('fills all ten slots', lu.filled === 10, String(lu.filled));
    ok('flex is credited separately', lu.byPos.FLEX > 0);
    const starterIds = lu.starters.map(s => s.playerId);
    ok('no player starts twice', new Set(starterIds).size === starterIds.length);
    ok('the best QB starts', lu.starters.some(s => s.position === 'QB'));

    // A roster missing a kicker simply fills nine slots rather than throwing.
    const noK = players.filter(p => p.position !== 'K');
    ok('a missing position degrades gracefully', T.trBestLineup(noK).filled === 9);
    ok('empty roster is safe', T.trBestLineup([]).total === 0);
}

console.log('\nPROPOSAL SHAPE  (1-5 per side)');
{
    const a = [P('RB'), P('WR')], b = [P('QB')];
    ok('2-for-1 is fine', T.trValidateProposal(a, b).length === 0);
    ok('0 on a side is rejected', T.trValidateProposal([], b).some(e => e.rule === 'minPlayers'));
    ok('6 on a side is rejected',
        T.trValidateProposal(Array.from({ length: 6 }, () => P('RB')), b).some(e => e.rule === 'maxPlayers'));
    ok('exactly 5 is allowed',
        T.trValidateProposal(Array.from({ length: 5 }, () => P('RB')), b).length === 0);
    const dup = P('RB', { id: 999 });
    ok('the same player on both sides is caught',
        T.trValidateProposal([dup], [dup]).some(e => e.rule === 'duplicate'));
}

console.log('\nROSTER SIZE  (16 active + 1 IR)');
{
    const r = roster('x');                       // 16 active, none on IR
    ok('the fixture is a full active roster', r.length === 16);

    // Sending 1 and receiving 1 keeps size constant — always legal.
    const even = T.trApplySide(r, [r[2]], [P('RB', { proj: 200 })]);
    ok('1-for-1 keeps the roster legal', even.violations.length === 0,
        JSON.stringify(even.violations));

    // Sending 1 and receiving 3 grows the roster by 2 — over the cap.
    const grow = T.trApplySide(r, [r[2]], [P('QB', { proj: 100 }), P('QB', { proj: 90 }), P('K', { proj: 80 })]);
    ok('receiving more than you send can overflow the roster',
        grow.violations.some(v => v.rule === 'rosterSize'), JSON.stringify(grow.violations));

    // Sending 3 for 1 shrinks it — legal, you can fill from waivers.
    const shrink = T.trApplySide(r, [r[2], r[3], r[4]], [P('RB', { proj: 200 })]);
    ok('sending more than you receive is legal',
        !shrink.violations.some(v => v.rule === 'rosterSize'));
    ok('and the roster is genuinely smaller', shrink.shape.total === 14, String(shrink.shape.total));
}

console.log('\nPOSITION CAPS  (QB3 RB7 WR7 TE3 K3 DST3)');
{
    const r = roster('y');  // 2 QB, 5 RB, 5 WR, 2 TE, 1 K, 2 D/ST
    // Take on 2 more QBs for 2 RBs -> 4 QBs, over the cap of 3.
    const over = T.trApplySide(r, [r[2], r[3]], [P('QB', { proj: 200 }), P('QB', { proj: 190 })]);
    const v = over.violations.filter(x => x.rule === 'positionCap' && x.pos === 'QB')[0];
    ok('exceeding the QB cap is caught', !!v, JSON.stringify(over.violations));
    ok('the message says by how much', v && v.over === 1, v && String(v.over));

    // Exactly at the cap is fine.
    const atCap = T.trApplySide(r, [r[2]], [P('QB', { proj: 200 })]);
    ok('landing exactly on the cap is legal',
        !atCap.violations.some(x => x.rule === 'positionCap'), JSON.stringify(atCap.violations));

    // RB cap is 7; the fixture has 5, so +2 is the limit.
    const rbOk = T.trApplySide(r, [r[0]], [P('RB', { proj: 150 }), P('RB', { proj: 140 })]);
    ok('two extra RBs stays under the RB cap of 7',
        !rbOk.violations.some(x => x.rule === 'positionCap' && x.pos === 'RB'));

    ok('every violation is reported, not just the first',
        T.trApplySide(r, [r[2]], [
            P('QB', { proj: 200 }), P('QB', { proj: 190 }), P('TE', { proj: 100 }), P('TE', { proj: 90 }),
        ]).violations.length >= 2);
}

console.log('\nIR HANDLING');
{
    const r = roster('z');
    ok('an OUT player is IR eligible', T.trIrEligible(P('RB', { status: 'OUT' })));
    ok('an active player is not', !T.trIrEligible(P('RB', { status: 'ACTIVE' })));

    // The IR slot is a genuine extra spot, so the ladder below is 1-for-1, then
    // 1-for-2, then 1-for-3, and only the last one should break.
    const hurt = P('RB', { status: 'INJURY_RESERVE', proj: 200 });
    const res = T.trApplySide(r, [r[2]], [hurt]);
    ok('an injured incoming player is seated on IR', res.shape.ir === 1, String(res.shape.ir));
    ok('which frees an active spot', res.shape.active === 15, String(res.shape.active));
    ok('and the roster is legal', res.violations.length === 0, JSON.stringify(res.violations));

    // 1-for-2 with one injured: 16 active + 1 IR, exactly at the cap.
    const res2 = T.trApplySide(r, [r[2]], [hurt, P('WR', { proj: 180 })]);
    ok('IR lets a team sit exactly at the active cap',
        res2.shape.active === 16 && res2.shape.ir === 1,
        res2.shape.active + ' active / ' + res2.shape.ir + ' IR');
    ok('which is still legal', res2.violations.length === 0, JSON.stringify(res2.violations));

    // Two injured players but only one IR slot: the second takes an active spot.
    const res3 = T.trApplySide(r, [r[2]],
        [hurt, P('WR', { status: 'OUT', proj: 180 }), P('TE', { proj: 100 })]);
    ok('only one player can sit on IR', res3.shape.ir === 1, String(res3.shape.ir));
    ok('the surplus injured player counts against the active roster',
        res3.shape.active === 17, String(res3.shape.active));
    ok('and that overflow is flagged',
        res3.violations.some(v => v.rule === 'rosterSize'), JSON.stringify(res3.violations));
}

console.log('\nEVALUATION IS SYMMETRIC AND ZERO-SUM IN PLAYERS');
{
    const rosters = { '1': roster('a'), '2': roster('b') };
    const give = [rosters['1'][2].playerId];
    const get  = [rosters['2'][7].playerId];
    const ev = T.trEvaluate(rosters, '1', '2', give, get);

    ok('a legal swap reports legal', ev.legal === true, JSON.stringify(ev.proposalErrors));
    ok('what A gives is what B gets',
        JSON.stringify(ev.sides.a.gives) === JSON.stringify(ev.sides.b.gets));
    ok('what B gives is what A gets',
        JSON.stringify(ev.sides.b.gives) === JSON.stringify(ev.sides.a.gets));
    ok('both rosters stay the same size',
        ev.sides.a.shape.total === 16 && ev.sides.b.shape.total === 16);
    ok('lineup deltas are reported for both sides',
        typeof ev.sides.a.lineupDelta === 'number' && typeof ev.sides.b.lineupDelta === 'number');

    // Trading a player for himself is a no-op in strength terms.
    const same = T.trEvaluate({ '1': roster('c'), '2': roster('d') }, '1', '2', [], []);
    ok('an empty proposal is rejected rather than evaluated',
        same.legal === false && same.proposalErrors.some(e => e.rule === 'minPlayers'));

    const bogus = T.trEvaluate(rosters, '1', '2', [999999], get);
    ok('selecting a player who is not on that roster is caught',
        bogus.proposalErrors.some(e => e.rule === 'notOnRoster'));
}

console.log('\nPLAYOFF ODDS USE A PAIRED SIMULATION');
{
    const rosters = { '1': roster('e'), '2': roster('f'), '3': roster('g') };
    // A deterministic stand-in: odds proportional to lineup strength. The point of
    // this test is the wiring, not the Monte Carlo.
    let calls = 0;
    const simFn = (means) => {
        calls++;
        const out = {};
        const tot = Object.values(means).reduce((a, b) => a + b, 0);
        Object.keys(means).forEach(id => {
            out[id] = { playoffPct: Math.round(means[id] / tot * 1000) / 10, titlePct: 0 };
        });
        return out;
    };

    // Like for like, so positional scarcity isn't a confound: A's worst RB (192
    // projected) for B's best (240).
    const rbA = rosters['1'].filter(p => p.position === 'RB');
    const rbB = rosters['2'].filter(p => p.position === 'RB');
    const weak = rbA[rbA.length - 1], strong = rbB[0];
    const res = T.trTradeImpact(rosters, '1', '2', [weak.playerId], [strong.playerId], simFn);

    ok('the simulator runs exactly twice', calls === 2, String(calls));
    ok('odds are attached to both sides', res.sides.a.odds && res.sides.b.odds);
    ok('a delta is computed', typeof res.sides.a.odds.delta === 'number');
    ok('upgrading a starter helps side A', res.sides.a.odds.delta > 0,
        String(res.sides.a.odds.delta));
    ok('and the other side moves the other way', res.sides.b.odds.delta < 0,
        String(res.sides.b.odds.delta));
    ok('untouched teams are still simulated', res.oddsAll.before['3'] != null);

    // The same trade evaluated twice must give identical numbers.
    const again = T.trTradeImpact(rosters, '1', '2', [weak.playerId], [strong.playerId], simFn);
    ok('evaluation is deterministic',
        again.sides.a.odds.delta === res.sides.a.odds.delta,
        res.sides.a.odds.delta + ' vs ' + again.sides.a.odds.delta);

    ok('without a simulator it still returns the lineup analysis',
        T.trTradeImpact(rosters, '1', '2', [weak.playerId], [strong.playerId], null).sides.a.lineupDelta != null);
}

console.log('\nPOSITIONAL SCARCITY  (raw points are not the same as lineup value)');
{
    // This case caught a naive assumption while writing these tests. Trading away a
    // team's ONLY kicker for a redundant sixth running back looks like a clear
    // upgrade on raw projected points — the RB outscores the kicker nearly two to
    // one — but it empties a starting slot that cannot be refilled, while the RB
    // only displaces whoever was already in the FLEX. The model has to see that.
    const rosters = { '1': roster('h'), '2': roster('i') };
    const onlyK  = rosters['1'].filter(p => p.position === 'K')[0];
    const spareRb = rosters['2'].filter(p => p.position === 'RB')[0];

    const ev = T.trEvaluate(rosters, '1', '2', [onlyK.playerId], [spareRb.playerId]);
    ok('the kicker outscores the RB on raw projection nowhere near evenly',
        spareRb.proj > onlyK.proj, spareRb.proj + ' vs ' + onlyK.proj);
    ok('yet giving up the only kicker weakens the lineup', ev.sides.a.lineupDelta < 0,
        'delta ' + ev.sides.a.lineupDelta);
    ok('the K slot goes unfilled afterwards',
        T.trBestLineup(ev.sides.a.roster.map(p => Object.assign({}, p,
            { value: (T.trPlayerValue(p) || {}).value }))).filled === 9);
    ok('and the side receiving the kicker is not penalised for depth',
        ev.sides.b.byPosDelta.K >= 0, JSON.stringify(ev.sides.b.byPosDelta));
}

console.log('\nVERDICTS ARE HEDGED  (no letter grades anywhere)');
{
    ok('a big gain reads as a clear win',
        T.trVerdict({ odds: { delta: 8 }, lineupDelta: 6 }) === 'Clear win');
    ok('a small move is a coin flip',
        T.trVerdict({ odds: { delta: 1.2 }, lineupDelta: 0.4 }) === 'Too close to call');
    ok('a small negative move is also a coin flip',
        T.trVerdict({ odds: { delta: -1.2 }, lineupDelta: -0.4 }) === 'Too close to call');
    ok('a big loss reads as a clear loss',
        T.trVerdict({ odds: { delta: -9 }, lineupDelta: -7 }) === 'Clear loss');
    ok('with no odds it falls back to lineup strength',
        T.trVerdict({ lineupDelta: 4 }) === 'Stronger lineup');
    ok('no verdict string is a letter grade',
        [8, 3, 0, -3, -8].every(d => !/^[A-F][+-]?$/.test(T.trVerdict({ odds: { delta: d }, lineupDelta: d }))));
}

console.log('\nSETTINGS MATCH THE LEAGUE');
{
    ok('ten starting slots', Object.values(T.TR_LINEUP).reduce((a, b) => a + b, 0) + T.TR_FLEX_COUNT === 10);
    ok('16 active + 1 IR = 17', T.TR_ACTIVE_MAX === 16 && T.TR_ROSTER_MAX === 17);
    ok('position caps match ESPN settings',
        T.TR_POSITION_CAPS.QB === 3 && T.TR_POSITION_CAPS.RB === 7 &&
        T.TR_POSITION_CAPS.WR === 7 && T.TR_POSITION_CAPS.TE === 3 &&
        T.TR_POSITION_CAPS.K === 3 && T.TR_POSITION_CAPS['D/ST'] === 3);
    ok('1 to 5 players per side', T.TR_MIN_PER_SIDE === 1 && T.TR_MAX_PER_SIDE === 5);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
