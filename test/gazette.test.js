const G = require('../public/gazette.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

let pid = 1;
const pl = (name, pos, pts) => ({ id: pid++, name, pos, pts, started: true });

function team(manager, starters, opts) {
    opts = opts || {};
    const actual = starters.reduce((a, p) => a + p.pts, 0);
    return {
        teamId: opts.teamId || manager,
        manager,
        margin: opts.margin == null ? 10 : opts.margin,
        won: (opts.margin == null ? 10 : opts.margin) > 0,
        box: {
            starters, bench: opts.bench || [],
            actual: Math.round(actual * 10) / 10,
            optimal: opts.optimal == null ? Math.round(actual * 10) / 10 : opts.optimal,
            left: opts.left == null ? 0 : opts.left,
            blunder: opts.blunder || null,
            zeros: starters.filter(p => p.pts <= 0).map(p => ({ name: p.name, pos: p.pos })),
        },
    };
}

console.log('\nDETERMINISM  (same week reads the same; different weeks rarely rhyme)');
{
    ok('the same seed always picks the same phrase',
        G.gzPick(G.GZ_OBIT_OPENERS, 'x|3') === G.gzPick(G.GZ_OBIT_OPENERS, 'x|3'));
    const picks = [1, 2, 3, 4, 5, 6, 7, 8].map(w => G.gzPick(G.GZ_OBIT_OPENERS, 'obit|' + w + '|99|0'));
    ok('eight weeks produce more than one phrasing', new Set(picks).size > 1,
        String(new Set(picks).size));
    ok('an empty pool is safe', G.gzPick([], 'x') === '');
    ok('hash is stable across calls', G.gzHash('abc') === G.gzHash('abc'));
}

console.log('\nWEEKLY PROJECTION');
{
    ok('season total converts to a weekly number', G.gzWeeklyProj(1, { 1: 170 }) === 10);
    ok('an unprojected player returns null', G.gzWeeklyProj(2, { 1: 170 }) === null);
    ok('a missing map is safe', G.gzWeeklyProj(1, null) === null);
    ok('a zero projection is real, not missing', G.gzWeeklyProj(1, { 1: 0 }) === 0);
}

console.log('\nOBITUARIES  (starters who missed, worst first)');
{
    const proj = {};
    const bust  = pl('Big Bust', 'WR', 2);   proj[bust.id] = 17 * 18;   // projected 18
    const mild  = pl('Mild Miss', 'RB', 9);  proj[mild.id] = 17 * 12;   // projected 12
    const hero  = pl('Hero', 'QB', 32);      proj[hero.id] = 17 * 20;
    const kicker = pl('Kicker', 'K', 1);     proj[kicker.id] = 17 * 4;  // below the floor
    const waiver = pl('Waiver Guy', 'WR', 1);                           // no projection

    const teams = [team('Alex', [bust, mild, hero, kicker, waiver])];
    const obits = G.gzObituaries(teams, proj, 3);

    ok('the worst miss leads', obits[0].name === 'Big Bust', obits[0] && obits[0].name);
    ok('a smaller miss follows', obits[1] && obits[1].name === 'Mild Miss');
    ok('an overperformer is not eulogised', !obits.some(o => o.name === 'Hero'));
    ok('a low-projection kicker is excluded', !obits.some(o => o.name === 'Kicker'));
    ok('an unprojected player is excluded', !obits.some(o => o.name === 'Waiver Guy'));
    ok('the miss is quantified', obits[0].missedBy === 16, String(obits[0].missedBy));
    ok('projection and score are both carried', obits[0].proj === 18 && obits[0].pts === 2);
    ok('the opener names the player', obits[0].opener.indexOf('Big Bust') > -1, obits[0].opener);
    ok('the closer names the manager', obits[0].closer.indexOf('Alex') > -1, obits[0].closer);
    ok('the list is capped', G.gzObituaries(teams, proj, 3, 1).length === 1);
    ok('a clean week yields no obituaries',
        G.gzObituaries([team('B', [hero])], proj, 3).length === 0);
    ok('no data is safe', G.gzObituaries([], {}, 3).length === 0);
}

console.log('\nAWARDS  (named from this league\'s own constitution)');
{
    const proj = {};
    const big  = pl('Star', 'RB', 40);  proj[big.id] = 17 * 20;   // +20 over
    const solid = pl('Solid', 'WR', 14); proj[solid.id] = 17 * 13;
    const teams = [team('Gabe', [big, solid])];

    const aw = G.gzAwards(teams, proj, 3, {
        lastPlace: { manager: 'Nick', record: '0-3' }, weeksLeft: 11,
    });
    const byKey = {}; aw.forEach(a => { byKey[a.key] = a; });

    ok('the Brad Johnson Award goes to the top score',
        byKey.bradJohnson && byKey.bradJohnson.winner === 'Star');
    ok('and cites section 5.3', byKey.bradJohnson.canon.indexOf('5.3') > -1);
    // Star is both top scorer and biggest overperformer here, so the Meachum skips
    // him and goes to Solid — the behaviour locked in further down.
    ok('the Meachum goes to the best overperformer who is not the top scorer',
        byKey.meachum && byKey.meachum.winner === 'Solid',
        byKey.meachum && byKey.meachum.winner);
    ok('and cites rule 5.2', byKey.meachum.canon.indexOf('5.2') > -1);
    ok('the Sacko Watch names the team in last',
        byKey.sacko && byKey.sacko.winner === 'Nick');
    ok('and cites section 2.2', byKey.sacko.canon.indexOf('2.2') > -1);
    ok('the Sacko is flagged as bad news', byKey.sacko.bad === true);

    ok('no last place means no Sacko award',
        !G.gzAwards(teams, proj, 3, {}).some(a => a.key === 'sacko'));
    ok('unprojected players cannot win the Meachum',
        !G.gzAwards([team('X', [pl('NoProj', 'WR', 30)])], {}, 3, {})
            .some(a => a.key === 'meachum'));
    ok('an all-underperforming week has no Meachum',
        !G.gzAwards([team('X', [Object.assign(pl('Under', 'WR', 2), {})])],
            (() => { const m = {}; m[pid - 1] = 17 * 15; return m; })(), 3, {})
            .some(a => a.key === 'meachum'));

    // Observed on real Week 3 data: Brock Purdy was both the top scorer and the
    // biggest overperformer, so without this the same man collected both awards.
    ok('the top scorer cannot also win the Meachum',
        byKey.meachum == null || byKey.meachum.winner !== byKey.bradJohnson.winner,
        byKey.bradJohnson.winner + ' / ' + (byKey.meachum && byKey.meachum.winner));

    {
        const p2 = {};
        const dominant = pl('Dominant', 'QB', 45); p2[dominant.id] = 17 * 15;  // +30
        const second   = pl('Second', 'RB', 22);   p2[second.id]   = 17 * 12;  // +10
        const aw2 = G.gzAwards([team('T', [dominant, second])], p2, 4, {});
        const k2 = {}; aw2.forEach(a => { k2[a.key] = a; });
        ok('the Brad Johnson still goes to the biggest score', k2.bradJohnson.winner === 'Dominant');
        ok('and the Meachum falls to the next man down', k2.meachum.winner === 'Second',
            k2.meachum && k2.meachum.winner);
    }
    {
        // Only one player beat his projection, and he took the other award.
        const p3 = {};
        const only = pl('Only', 'QB', 40); p3[only.id] = 17 * 10;
        const miss = pl('Miss', 'RB', 3);  p3[miss.id] = 17 * 14;
        const aw3 = G.gzAwards([team('T', [only, miss])], p3, 5, {});
        ok('with nobody else above projection the Meachum does not run',
            !aw3.some(a => a.key === 'meachum'),
            JSON.stringify(aw3.map(a => a.key)));
    }
}

console.log('\nOVERS AND UNDERS  (the only place a projection sits next to the result)');
{
    const proj = {};
    const a = pl('Way Over', 'RB', 40);  proj[a.id] = 17 * 15;   // +25
    const b = pl('Bit Over', 'WR', 16);  proj[b.id] = 17 * 13;   // +3
    const c = pl('Bit Under', 'TE', 8);  proj[c.id] = 17 * 11;   // -3
    const d = pl('Way Under', 'QB', 3);  proj[d.id] = 17 * 22;   // -19
    const e = pl('No Proj', 'WR', 25);                            // excluded
    const ou = G.gzOversUnders([team('T', [a, b, c, d, e])], proj);

    ok('the biggest beat leads the overs', ou.overs[0].name === 'Way Over');
    ok('overs are sorted downward', ou.overs[1].name === 'Bit Over');
    ok('the biggest miss leads the unders', ou.unders[0].name === 'Way Under', ou.unders[0].name);
    ok('unders are sorted by severity', ou.unders[1].name === 'Bit Under');
    ok('overs contain only positives', ou.overs.every(p => p.vsProj > 0));
    ok('unders contain only negatives', ou.unders.every(p => p.vsProj < 0));
    ok('an unprojected player appears in neither',
        !ou.overs.concat(ou.unders).some(p => p.name === 'No Proj'));
    ok('projection is carried for display', ou.overs[0].proj === 15 && ou.overs[0].pts === 40);
    ok('the list is capped', G.gzOversUnders([team('T', [a, b, c, d])], proj, 1).overs.length === 1);
    ok('no data is safe',
        G.gzOversUnders([], {}).overs.length === 0 && G.gzOversUnders([], {}).unders.length === 0);
}

console.log('\nCLASSIFIEDS  (every ad is pinned to a real fact)');
{
    const a = team('Manny', [pl('Guy', 'WR', 10), pl('Ghost', 'TE', 0)], {
        left: 29.5, optimal: 128.9, margin: 0.5,
        blunder: { benched: { name: 'Benched Guy', pts: 20.4 }, started: { name: 'Started Guy', pts: 2.8 }, swing: 17.6 },
    });
    const b = team('Nick', [pl('Other', 'RB', 12)], { left: 8.8, margin: -0.5 });
    const ads = G.gzClassifieds([a, b], {}, 3);

    ok('the worst start/sit becomes an ad', ads.some(x => /FOR SALE/.test(x.head)));
    ok('and carries the swing', ads.some(x => /17\.6/.test(x.head)));
    ok('the biggest bench waste becomes an ad', ads.some(x => /WANTED/.test(x.head)));
    ok('a started zero becomes an ad', ads.some(x => /LOST/.test(x.head) && /Ghost/.test(x.body)));
    ok('the best score in a loss becomes an ad', ads.some(x => /FOUND/.test(x.head) && /Nick/.test(x.body)));
    ok('ads are capped at four', ads.length <= 4, String(ads.length));

    const quiet = G.gzClassifieds([team('Q', [pl('Fine', 'RB', 15)], { left: 0, margin: 8 })], {}, 3);
    ok('a clean week produces fewer ads, not invented ones',
        !quiet.some(x => /FOR SALE/.test(x.head)) && !quiet.some(x => /LOST/.test(x.head)),
        JSON.stringify(quiet.map(x => x.head)));
    ok('no teams is safe', G.gzClassifieds([], {}, 3).length === 0);
}

console.log('\nFRAUD WATCH  (record vs all-play)');
{
    const rows = [
        { manager: 'Lucky',  wins: 3, losses: 0, allPlayW: 12, allPlayL: 21, ppg: 100 },
        { manager: 'Honest', wins: 2, losses: 1, allPlayW: 22, allPlayL: 11, ppg: 130 },
        { manager: 'Unlucky', wins: 0, losses: 3, allPlayW: 18, allPlayL: 15, ppg: 120 },
    ];
    const f = G.gzFraudWatch(rows, 3);
    ok('the flattered team is named', f && f.manager === 'Lucky', f && f.manager);
    ok('both records are quoted', f.record === '3-0' && f.allPlay === '12-21');
    ok('the opener names them', f.opener.indexOf('Lucky') > -1, f.opener);
    ok('the body explains the gap', /not\s+telling the same story/.test(f.body));

    const fair = [
        { manager: 'A', wins: 2, losses: 1, allPlayW: 22, allPlayL: 11, ppg: 130 },
        { manager: 'B', wins: 1, losses: 2, allPlayW: 11, allPlayL: 22, ppg: 100 },
        { manager: 'C', wins: 2, losses: 1, allPlayW: 18, allPlayL: 15, ppg: 118 },
    ];
    ok('an honest league gets no inquiry', G.gzFraudWatch(fair, 3) === null);
    ok('too few teams is safe', G.gzFraudWatch([rows[0]], 3) === null);
    ok('no rows is safe', G.gzFraudWatch(null, 3) === null);
    ok('zero games played is safe',
        G.gzFraudWatch([
            { manager: 'A', wins: 0, losses: 0, allPlayW: 0, allPlayL: 0 },
            { manager: 'B', wins: 0, losses: 0, allPlayW: 0, allPlayL: 0 },
            { manager: 'C', wins: 0, losses: 0, allPlayW: 0, allPlayL: 0 },
        ], 1) === null);
}

console.log('\nRECORD BOOK  (stamped the week it falls)');
{
    const games = [
        { week: 1, manager: 'Gabe',  pts: 172.8, oppPts: 120.0, oppManager: 'Rob' },
        { week: 2, manager: 'Gabe',  pts: 176.6, oppPts: 111.7, oppManager: 'Nick' },
        { week: 1, manager: 'Nick',  pts: 74.5,  oppPts: 99.5,  oppManager: 'Peter' },
        { week: 3, manager: 'Manny', pts: 99.4,  oppPts: 98.9,  oppManager: 'Nick' },
        { week: 3, manager: 'Alex',  pts: 141.8, oppPts: 146.4, oppManager: 'Gabe' },
    ];
    const r = G.gzRecords(games, 3);
    const by = {}; r.forEach(x => { by[x.label] = x; });

    ok('highest score found', by['Highest score'].value === 176.6);
    ok('and is not stamped new in week 3', by['Highest score'].isNew === false);
    ok('lowest score found', by['Lowest score'].value === 74.5);
    ok('closest game found', by['Closest game'].value === '+0.5', by['Closest game'].value);
    ok('and IS stamped new, having happened this week', by['Closest game'].isNew === true);
    ok('most points in a loss found', by['Most points in a loss'].value === 141.8);
    ok('that one is new too', by['Most points in a loss'].isNew === true);
    ok('biggest blowout found', by['Biggest blowout'].value === '+64.9', by['Biggest blowout'].value);
    ok('no games is safe', G.gzRecords([], 3) === null);
}

console.log('\nSPREADS');
{
    const means = { '1': 130, '2': 110, '3': 120.5, '4': 120 };
    const games = [{ home: '1', away: '2' }, { home: '3', away: '4' }];
    const s = G.gzSpreads(means, games, id => 'T' + id);

    ok('one line per game', s.length === 2);
    ok('the favourite is the stronger team', s[0].favourite === 'T1');
    ok('the spread is the gap', s[0].spread === 20, String(s[0].spread));
    ok('the total is the sum', s[0].total === 240, String(s[0].total));
    ok('a near-tie is a pick-em', s[1].pickem === true, String(s[1].spread));
    ok('a clear favourite is not', s[0].pickem === false);
    ok('a game with an unknown team is dropped',
        G.gzSpreads(means, [{ home: '1', away: '99' }], id => id).length === 0);
    ok('no input is safe', G.gzSpreads(null, null).length === 0);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
