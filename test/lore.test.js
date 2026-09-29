const L = require('../lore.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/** Seasons where `finals` maps managerKey -> rankCalculatedFinal. */
function season(year, finals) {
    return {
        season: year,
        teams: Object.keys(finals).map((k, i) => ({
            id: i + 1, managerKey: k, managerNick: k.toUpperCase(),
            rankCalculatedFinal: finals[k],
        })),
    };
}

console.log('\nHONOURS  (titles are playoff wins, not regular-season finishes)');
{
    const seasons = [
        season(2024, { gabe: 1, alex: 2, nick: 3, diego: 4 }),
        season(2025, { alex: 1, gabe: 2, diego: 3, nick: 4 }),
        season(2026, { gabe: 1, nick: 2, alex: 3, diego: 4 }),
    ];
    const h = L.honours(seasons);
    const by = {}; h.forEach(x => { by[x.manager] = x; });

    ok('titles counted', by.GABE.titleCount === 2, String(by.GABE.titleCount));
    ok('title years recorded', JSON.stringify(by.GABE.titles) === '[2024,2026]');
    ok('most titles sorts first', h[0].manager === 'GABE');
    ok('runner-up finishes tracked', JSON.stringify(by.ALEX.runnerUps) === '[2024]');
    ok('never-won is flagged', by.DIEGO.neverWon === true);
    ok('a winner is not flagged', by.GABE.neverWon === false);
    ok('last title recorded', by.GABE.lastTitle === 2026);
    ok('someone with no title has none', by.DIEGO.lastTitle === null);
    ok('seasons played counted', by.DIEGO.seasonsPlayed === 3);

    // Worst final rank each year is the Sacko. Diego finished 4th in 2024 and 2026,
    // but only 3rd in 2025 — Nick was last that year, so Diego gets two, not three.
    ok('the Sacko is the worst final rank that season',
        JSON.stringify(by.DIEGO.sackos) === '[2024,2026]', JSON.stringify(by.DIEGO.sackos));
    ok('and the year he escaped it goes to whoever was actually last',
        JSON.stringify(by.NICK.sackos) === '[2025]', JSON.stringify(by.NICK.sackos));
    ok('the champion is never the Sacko', by.GABE.sackos.length === 0);
}

console.log('\nHONOURS EDGE CASES');
{
    ok('no seasons is safe', L.honours([]).length === 0);
    ok('null is safe', L.honours(null).length === 0);
    ok('a season with no teams is skipped', L.honours([{ season: 2020, teams: [] }]).length === 0);

    // A team with no managerKey still gets an identity rather than colliding.
    const anon = L.honours([{
        season: 2020,
        teams: [{ id: 1, name: 'Team A', rankCalculatedFinal: 1 },
                { id: 2, name: 'Team B', rankCalculatedFinal: 2 }],
    }]);
    ok('teams without a manager key stay distinct', anon.length === 2, String(anon.length));

    // Missing final ranks must not invent a Sacko.
    const noRank = L.honours([{
        season: 2021,
        teams: [{ id: 1, managerKey: 'a' }, { id: 2, managerKey: 'b' }],
    }]);
    ok('no ranks means no Sacko', noRank.every(r => r.sackos.length === 0));
    ok('and no titles', noRank.every(r => r.titleCount === 0));
    // A nameless team used to leave `manager` undefined, which reached the sort
    // comparator and threw — taking the whole brief down with it.
    ok('a team with no nickname AND no name still sorts',
        noRank.every(r => typeof r.manager === 'string' && r.manager.length > 0),
        JSON.stringify(noRank.map(r => r.manager)));
}

console.log('\nSTAKES  (read from the real constitution on disk)');
{
    const s = L.readStakes();
    ok('champion prize found', s.champion === 1750, String(s.champion));
    ok('runner-up prize found', s.runnerUp === 300, String(s.runnerUp));
    ok('weekly high prize found', s.weeklyHigh === 25, String(s.weeklyHigh));
    ok('the Sacko is described', /presentation/i.test(s.sacko));
}

console.log('\nNAMED RULES');
{
    const names = L.NAMED_RULES.map(r => r.name);
    ok('three rules named after people', L.NAMED_RULES.length === 3);
    ok('Brad Johnson included', names.some(n => /Brad Johnson/.test(n)));
    ok('Robert Meachum included', names.some(n => /Meachum/.test(n)));
    ok('the Peter Rule included', names.some(n => /Peter/.test(n)));
    ok('each carries a section', L.NAMED_RULES.every(r => !!r.section));
    ok('each explains itself rather than pointing at a number',
        L.NAMED_RULES.every(r => r.gist && r.gist.length > 40));
    ok('the Peter Rule notes it is dormant',
        /dormant/i.test(L.NAMED_RULES.filter(r => /Peter/.test(r.name))[0].gist));
}

console.log('\nNOTABLE VOTES');
{
    const store = {
        votes: [
            { category: 'rule',  result: 'passed', date: '2026-08-01', title: 'A', tally: '12-0', outcome: 'x' },
            { category: 'rule',  result: 'failed', date: '2026-08-02', title: 'B', tally: '5-7' },
            { category: 'trade', result: 'upheld', date: '2026-08-03', title: 'C', tally: '6-4' },
            { category: 'money', result: 'disputed', date: '2019-08-01', title: 'D', tally: '11-1' },
        ],
    };
    const n = L.notableVotes(store);
    ok('passed votes are included', n.some(v => v.title === 'A'));
    ok('failed votes are excluded', !n.some(v => v.title === 'B'));
    ok('trades are excluded — they are not league lore', !n.some(v => v.title === 'C'));
    ok('disputed votes are included', n.some(v => v.title === 'D'));
    ok('the list is capped', L.notableVotes(store, 1).length === 1);
    ok('no store is safe', L.notableVotes(null).length === 0);
}

console.log('\nBUILD  (the packet the brief carries)');
{
    // Three seasons, because a drought under three is not a drought.
    const seasons = [
        season(2024, { gabe: 1, alex: 2, nick: 3 }),
        season(2025, { gabe: 1, alex: 2, nick: 3 }),
        season(2026, { alex: 1, gabe: 2, nick: 3 }),
    ];
    const standings = [
        { managerKey: 'gabe', manager: 'Gabe', wins: 3, losses: 0, pointsFor: 495 },
        { managerKey: 'nick', manager: 'Nick', wins: 0, losses: 3, pointsFor: 285 },
        { managerKey: 'alex', manager: 'Alex', wins: 1, losses: 2, pointsFor: 342 },
    ];
    const lore = L.buildLore(seasons, standings);

    ok('stakes present', lore.stakes && lore.stakes.champion === 1750);
    ok('named rules present', lore.namedRules.length === 3);
    ok('honours present', lore.honours.length === 3);
    ok('the Sacko race names the team in last', lore.sackoRace.manager === 'Nick', lore.sackoRace.manager);
    ok('with their record', lore.sackoRace.record === '0-3');
    ok('and their history of it', Array.isArray(lore.sackoRace.previousSackos));
    ok('droughts listed for the winless', lore.neverWon.some(d => d.manager === 'NICK'),
        JSON.stringify(lore.neverWon));
    ok('a champion is not in the drought list', !lore.neverWon.some(d => d.manager === 'GABE'));
    ok('a two-season newcomer is not called a drought',
        L.buildLore([season(2025, { gabe: 1, newguy: 2 }), season(2026, { gabe: 1, newguy: 2 })], [])
            .neverWon.length === 0);
    ok('the note warns against reciting it', /Do not recite/i.test(lore.note));

    const bare = L.buildLore(seasons, null);
    ok('no standings means no Sacko race rather than a crash', bare.sackoRace === null);
    ok('but the rest still builds', bare.namedRules.length === 3 && bare.honours.length === 3);
    ok('empty everything is safe', L.buildLore([], []).honours.length === 0);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
