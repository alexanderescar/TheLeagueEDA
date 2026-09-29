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

console.log('\nEXTRA AWARDS  (competence and consequence)');
{
    const proj = {}, drafted = {};
    const star   = pl('Star', 'RB', 30);   proj[star.id] = 17 * 14; drafted[star.id] = 3;
    const ghost  = pl('Ghost', 'WR', 2);   proj[ghost.id] = 17 * 16; drafted[ghost.id] = 8;   // rd 1
    const waiver = pl('Waiver', 'QB', 26);                                                    // undrafted
    const late   = pl('Late', 'TE', 4);    drafted[late.id] = 150;                            // not early

    const efficient = team('Peddie', [star, waiver], { left: 3.4, optimal: 59.4, margin: 22 });
    efficient.box.hero = { name: 'Star', pts: 30 }; efficient.box.heroShare = 53.6;
    const sloppy = team('Albert', [ghost, late], { left: 49.3, optimal: 55.3, margin: -33 });
    sloppy.box.hero = { name: 'Late', pts: 4 }; sloppy.box.heroShare = 66.7;

    const aw = G.gzExtraAwards([efficient, sloppy], {
        projOf: proj, draftedAt: drafted,
        lastPlace: { manager: 'Nick', record: '0-3' }, weeksLeft: 11,
    });
    const by = {}; aw.forEach(a => { by[a.lab] = a; });

    ok('Coach of the Week is the most efficient lineup',
        by['Coach of the Week'].name === 'Peddie', by['Coach of the Week'].name);
    ok('and quotes the percentage', /%/.test(by['Coach of the Week'].sub));
    ok('Waiver Wire Steal finds the undrafted man',
        by['Waiver Wire Steal'].name === 'Waiver');
    ok('Draft Day Ghost finds the early pick who did nothing',
        by['Draft Day Ghost'].name === 'Ghost', by['Draft Day Ghost'].name);
    ok('and names the round', /round 1/.test(by['Draft Day Ghost'].sub), by['Draft Day Ghost'].sub);
    ok('Draft Day Ghost is flagged bad', by['Draft Day Ghost'].bad === true);
    ok('a late pick is not a Draft Day Ghost', by['Draft Day Ghost'].name !== 'Late');
    ok('One-Man Band takes the highest hero share',
        by['One-Man Band'].name === 'Albert', by['One-Man Band'].name);
    ok('Sacko Watch survived the migration', by['Sacko Watch'].name === 'Nick');
    ok('and carries the deadline', /11 weeks/.test(by['Sacko Watch'].sub));
    ok('Sacko Watch is flagged bad', by['Sacko Watch'].bad === true);
    ok('no Perfect Lineup when points were left', !by['The Perfect Lineup']);
    ok('cards use the existing award shape',
        aw.every(a => a.lab && a.name && a.sub));

    const perfect = team('Clean', [star], { left: 0, optimal: 30, margin: 5 });
    ok('a perfect lineup is celebrated',
        G.gzExtraAwards([perfect], { projOf: proj, draftedAt: drafted })
            .some(a => a.lab === 'The Perfect Lineup'));

    ok('no last place means no Sacko Watch',
        !G.gzExtraAwards([efficient, sloppy], { projOf: proj, draftedAt: drafted })
            .some(a => a.lab === 'Sacko Watch'));
    ok('no teams is safe', G.gzExtraAwards([], {}).length === 0);
    ok('no context is safe', G.gzExtraAwards([efficient], {}).length > 0);
}

console.log('\nNAIL-BITER AND BEATDOWN');
{
    const a = team('A', [pl('x', 'RB', 10)], { margin: 0.5 });
    const b = team('B', [pl('y', 'RB', 10)], { margin: 43.4 });
    const c = team('C', [pl('z', 'RB', 10)], { margin: -0.5 });
    const aw = G.gzExtraAwards([a, b, c], {});
    const by = {}; aw.forEach(x => { by[x.lab] = x; });
    ok('the closest win is the Nail-Biter', by['The Nail-Biter'].name === 'A');
    ok('the widest win is the Beatdown', by['The Beatdown'].name === 'B');
    ok('losers are not eligible for either',
        by['The Nail-Biter'].name !== 'C' && by['The Beatdown'].name !== 'C');

    const solo = G.gzExtraAwards([a], {});
    ok('one winner means a Nail-Biter but no Beatdown',
        solo.some(x => x.lab === 'The Nail-Biter') && !solo.some(x => x.lab === 'The Beatdown'));
}

console.log('\nCLASSIFIEDS  (eight categories, each on its own trigger)');
{
    const blunder = { benched: { name: 'Benched Guy', pts: 22 }, started: { name: 'Started Guy', pts: 1.4 }, swing: 20.6 };
    const bad  = team('Albert', [pl('a', 'WR', 5), pl('b', 'TE', 0)],
        { left: 49.3, optimal: 130.7, margin: -33.7, blunder });
    const close = team('Nick', [pl('c', 'RB', 12)], { left: 8, margin: -0.5 });
    const ctx = {
        week: 3,
        standings: [
            { manager: 'Nick', wins: 0, losses: 3, allPlayW: 5, allPlayL: 28, scores: [74.5, 111.7, 98.9] },
            { manager: 'Albert', wins: 1, losses: 2, allPlayW: 16, allPlayL: 17, scores: [146.1, 121.2, 81.4] },
        ],
        seasonStarts: {
            99: { name: 'Kyle Pitts', pos: 'TE', manager: 'Jaime', starts: 3, total: 3.0 },
            98: { name: 'Fine Player', pos: 'RB', manager: 'Gabe', starts: 3, total: 45 },
        },
        repeatOffences: [
            { player: 'Brock Purdy', pos: 'QB', manager: 'Diego', weeks: [1, 2], benchedTotal: 59.58, payoff: 41.28 },
        ],
    };
    const ads = G.gzClassifieds([bad, close], ctx);
    const cats = ads.map(a => a.category);

    ok('Help Wanted fires on a season-long dud', cats.indexOf('Help Wanted') > -1);
    ok('and names the player and his total',
        ads.some(a => /Kyle Pitts/.test(a.body) && /3 games/.test(a.body)));
    ok('a productive starter does not trigger Help Wanted',
        !ads.some(a => /Fine Player/.test(a.body)));
    ok('Public Notice fires on a winless run', cats.indexOf('Public Notice') > -1);
    ok('and quotes all-play', ads.some(a => /5-28/.test(a.body)));
    ok('Legal Notice fires on the biggest gap', cats.indexOf('Legal Notice') > -1);
    ok('Apology fires on the worst start/sit', cats.indexOf('Apology') > -1);
    ok('and is addressed to the benched player',
        ads.some(a => a.category === 'Apology' && /Benched Guy/.test(a.body)));
    ok('Personals fires for the winless', cats.indexOf('Personals') > -1);
    ok('Estate Sale fires on the big bench pile', cats.indexOf('Estate Sale') > -1);
    ok('For Sale fires on the repeat benching that paid off', cats.indexOf('For Sale') > -1);
    ok('and cites the cost and the payoff',
        ads.some(a => /59\.6/.test(a.body) && /41\.28/.test(a.body)));
    ok('Lost fires on a game decided by under five', cats.indexOf('Lost') > -1);
    ok('every ad carries a category', ads.every(a => !!a.category));
    ok('categories are not duplicated', new Set(cats).size === cats.length);

    // A quiet week should produce fewer ads, not invented ones.
    const calm = team('Q', [pl('q', 'RB', 15)], { left: 2, optimal: 17, margin: 25 });
    const quiet = G.gzClassifieds([calm], { week: 3, standings: [], seasonStarts: {}, repeatOffences: [] });
    ok('a clean week produces far fewer notices', quiet.length < ads.length,
        quiet.length + ' vs ' + ads.length);
    ok('no Public Notice without a losing run',
        !quiet.some(a => a.category === 'Public Notice'));
    ok('no Estate Sale over a tidy bench',
        !quiet.some(a => a.category === 'Estate Sale'));
    ok('no teams is safe', G.gzClassifieds([], {}).length === 0);
    ok('no context is safe', G.gzClassifieds([bad], {}).length >= 0);
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
