const S = require('../stats.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/** A season from a list of [homeKey, homePts, awayKey, awayPts] per week. */
function season(year, games, finals, reg) {
    const keys = {};
    games.forEach(g => { keys[g[0]] = true; keys[g[2]] = true; });
    const teams = Object.keys(keys).map((k, i) => ({
        id: i + 1, managerKey: k, managerNick: k.toUpperCase(),
        rankCalculatedFinal: (finals || {})[k] || null,
    }));
    const idOf = {}; teams.forEach(t => { idOf[t.managerKey] = t.id; });
    return {
        season: year, teams,
        settings: { scheduleSettings: { matchupPeriodCount: reg == null ? 13 : reg } },
        schedule: games.map((g, i) => ({
            matchupPeriodId: g[4] == null ? i + 1 : g[4],
            home: { teamId: idOf[g[0]], totalPoints: g[1] },
            away: { teamId: idOf[g[2]], totalPoints: g[3] },
        })),
    };
}

console.log('\nFLATTEN  (one row per team per completed game)');
{
    const s = season(2026, [['a', 120, 'b', 100], ['a', 90, 'b', 95]]);
    const rows = S.flatten([s]);
    ok('two games become four rows', rows.length === 4);
    ok('a win and a loss are both recorded',
        rows.filter(r => r.win).length === 2 && rows.filter(r => r.loss).length === 2);
    ok('points against are carried', rows[0].pa === 100);
    ok('unplayed games are skipped',
        S.flatten([season(2026, [['a', 0, 'b', 0]])]).length === 0);
    ok('a tie counts as neither win nor loss',
        S.flatten([season(2026, [['a', 100, 'b', 100]])]).every(r => !r.win && !r.loss));
    ok('playoff weeks are marked',
        S.flatten([season(2026, [['a', 1, 'b', 2, 14]], {}, 13)]).every(r => r.playoff));
    ok('no seasons is safe', S.flatten([]).length === 0);
}

console.log('\nCAREERS  (all-play and luck are the point)');
{
    // 'lucky' wins its games while scoring poorly; 'strong' scores highly and loses.
    // All-play should disagree with the standings.
    //
    // The week numbers matter: all-play compares you against everyone who played
    // THAT week. The first version of this fixture gave every game its own week, so
    // each team had exactly one opponent to be measured against and all-play came
    // out as either 100% or 0%. Four teams, two weeks.
    const s = season(2026, [
        ['lucky', 100, 'weak', 90, 1],
        ['strong', 150, 'best', 160, 1],
        ['lucky', 101, 'weak', 95, 2],
        ['strong', 155, 'best', 158, 2],
    ]);
    const car = S.careers(S.flatten([s]));
    const by = {}; car.forEach(c => { by[c.name] = c; });

    ok('records are counted', by.LUCKY.w === 2 && by.LUCKY.l === 0);
    ok('ppg is averaged', Math.abs(by.LUCKY.ppg - 100.5) < 0.01, String(by.LUCKY.ppg));
    ok('best and worst tracked', by.STRONG.best === 155 && by.STRONG.worst === 150);

    ok('all-play punishes the lucky winner', by.LUCKY.apPct < 0.6, String(by.LUCKY.apPct));
    ok('all-play rewards the strong loser', by.STRONG.apPct > 0.5, String(by.STRONG.apPct));
    ok('luck is positive for the flattered team', by.LUCKY.luck > 0.3, String(by.LUCKY.luck));
    ok('luck is negative for the unlucky team', by.STRONG.luck < 0, String(by.STRONG.luck));
    ok('luck is win% minus all-play%',
        Math.abs(by.LUCKY.luck - (by.LUCKY.winPct - by.LUCKY.apPct)) < 1e-9);

    ok('150+ games counted', by.BEST.over150 === 2, String(by.BEST.over150));
    ok('losing while scoring 130+ counted', by.STRONG.lostOver130 === 2, String(by.STRONG.lostOver130));
    ok('winning under 90 counted', S.careers(S.flatten([season(2026, [['x', 85, 'y', 80]])]))
        .filter(c => c.name === 'X')[0].wonUnder90 === 1);
    ok('season count is distinct seasons',
        S.careers(S.flatten([season(2025, [['a', 1, 'b', 2]]), season(2026, [['a', 1, 'b', 2]])]))
            .every(c => c.seasons === 2));
}

console.log('\nREGULAR SEASON VS PLAYOFF SPLITS  (the 2018 case)');
{
    // Nick 2018: 13-0 regular at 148.4 ppg, then two playoff wins. Asked for the
    // regular season alone, the old sheet had nothing and the model guessed the
    // schedule was 14 weeks. It was 13.
    const teams = [
        { id: 1, managerKey: 'n', managerNick: 'Nick', rankCalculatedFinal: 1 },
        { id: 2, managerKey: 'f', managerNick: 'Foil', rankCalculatedFinal: 12 },
    ];
    const sched = [];
    for (let w = 1; w <= 13; w++) {
        sched.push({ matchupPeriodId: w, home: { teamId: 1, totalPoints: 148.4 }, away: { teamId: 2, totalPoints: 100 } });
    }
    [14, 15].forEach(w => sched.push({ matchupPeriodId: w, home: { teamId: 1, totalPoints: 146.38 }, away: { teamId: 2, totalPoints: 90 } }));
    const s = { season: 2018, teams, schedule: sched, settings: { scheduleSettings: { matchupPeriodCount: 13 } } };
    const rows = S.flatten([s]);

    const line = S.seasonLines([s], rows).filter(l => /Nick/.test(l))[0];
    ok('the regular-season record is stated', /regular season 13-0/.test(line), line);
    ok('with its own ppg', /148\.4 ppg/.test(line), line);
    ok('the playoff record is separate', /playoffs 2-0/.test(line), line);
    ok('the combined record is still there', /overall 15-0/.test(line), line);
    ok('and its ppg differs from the regular season', /148\.1 ppg/.test(line), line);
    ok('the real schedule length is stated', /13-week regular season/.test(line), line);
    ok('the finish is kept', /finished 1/.test(line), line);

    const c = S.careers(rows).filter(x => x.name === 'Nick')[0];
    ok('career regular-season record split out', c.rw === 13 && c.rl === 0);
    ok('career playoff record split out', c.pw === 2 && c.pl === 0);
    ok('career combined record unchanged', c.w === 15 && c.l === 0);
    ok('regular-season ppg excludes playoffs', Math.abs(c.rppg - 148.4) < 0.05, String(c.rppg));
    ok('combined ppg differs', Math.abs(c.ppg - 148.1) < 0.1, String(c.ppg));

    const sheet = S.buildSheet({ seasons: [s] });
    ok('the sheet explains the three records', /regular-season record first/.test(sheet));
    ok('and tells the reader to say which was used', /say which you used/.test(sheet));
}

console.log('\nSEASONS WITH NO PLAYOFF GAMES');
{
    const teams = [{ id: 1, managerKey: 'a', managerNick: 'A' }, { id: 2, managerKey: 'b', managerNick: 'B' }];
    const sched = [{ matchupPeriodId: 1, home: { teamId: 1, totalPoints: 120 }, away: { teamId: 2, totalPoints: 100 } }];
    const s = { season: 2026, teams, schedule: sched, settings: { scheduleSettings: { matchupPeriodCount: 14 } } };
    const line = S.seasonLines([s], S.flatten([s])).filter(l => /\bA\b/.test(l))[0];
    ok('says so rather than printing 0-0', /no playoff games/.test(line), line);
    ok('regular season still reported', /regular season 1-0/.test(line), line);
    ok('overall matches the regular season', /overall 1-0/.test(line), line);
}

console.log('\nRIVALRIES');
{
    const rows = S.flatten([season(2026, [['a', 120, 'b', 100], ['b', 130, 'a', 90]])]);
    const riv = S.rivalries(rows);
    const ab = riv.filter(r => r.a === 'A' && r.b === 'B')[0];
    const ba = riv.filter(r => r.a === 'B' && r.b === 'A')[0];
    ok('both directions are recorded', !!ab && !!ba);
    ok('records mirror each other', ab.w === ba.l && ab.l === ba.w, ab.w + '-' + ab.l);
    ok('points mirror too', ab.pf === ba.pa);
    ok('meeting count is right', ab.w + ab.l === 2);
    ok('no pairing without a meeting', riv.every(r => r.w + r.l > 0));
}

console.log('\nRECORD BOOK');
{
    const rows = S.flatten([season(2026, [
        ['a', 200, 'b', 50],
        ['c', 101, 'd', 100],
        ['e', 140, 'f', 150],
    ])]);
    const rec = S.recordBook(rows);
    ok('the highest score leads', /200 by A/.test(rec.highest[0]), rec.highest[0]);
    ok('the lowest score leads the other list', /50 by B/.test(rec.lowest[0]), rec.lowest[0]);
    ok('biggest win is the 150-point margin', /\+150/.test(rec.biggestWins[0]), rec.biggestWins[0]);
    ok('closest game is the one-pointer', /\+1 /.test(rec.closest[0]), rec.closest[0]);
    ok('most points in a loss finds the 140', /140 by E/.test(rec.mostInLoss[0]), rec.mostInLoss[0]);
    ok('every entry names a season and week', rec.highest.every(l => /2026 wk\d/.test(l)));
}

console.log('\nHONOURS  (champion is the playoff winner, not the top seed)');
{
    const hon = S.honours([
        season(2026, [['a', 1, 'b', 2]], { a: 1, b: 2 }),
        season(2025, [['a', 1, 'b', 2]], { b: 1, a: 4 }),
    ]);
    ok('newest season first', hon[0].season === 2026);
    ok('champion read from final rank 1', hon[0].champion === 'A');
    ok('runner-up read from rank 2', hon[0].runnerUp === 'B');
    ok('worst final rank is the Sacko', hon[1].sacko === 'A', hon[1].sacko);
    ok('and the champion that year is the other one', hon[1].champion === 'B');
    ok('no ranks yields nulls rather than guesses',
        S.honours([season(2024, [['a', 1, 'b', 2]])])[0].champion === null);
}

console.log('\nDRAFT INDEX');
{
    const mk = (year, picks) => ({
        season: year,
        teams: [{ id: 1, managerKey: 'a', managerNick: 'ALEX' }, { id: 2, managerKey: 'b', managerNick: 'NICK' }],
        schedule: [],
        draftDetail: { picks },
    });
    const idx = S.draftIndex([
        mk(2024, [{ teamId: 1, playerName: 'Derrick Henry', overallPickNumber: 5, position: 'RB' }]),
        mk(2025, [{ teamId: 1, playerName: 'Derrick Henry', overallPickNumber: 9, position: 'RB' }]),
        mk(2026, [{ teamId: 2, playerName: 'Derrick Henry', overallPickNumber: 30, position: 'RB' },
                  { teamId: 1, playerName: 'One Timer', overallPickNumber: 2, position: 'WR' }]),
    ]);
    ok('a player taken three times appears',
        idx.repeat.some(l => /Derrick Henry: drafted 3x/.test(l)), JSON.stringify(idx.repeat));
    ok('and credits the most frequent drafter first',
        idx.repeat.some(l => /Derrick Henry.*ALEX 2/.test(l)));
    ok('a one-off pick is left out', !idx.repeat.some(l => /One Timer/.test(l)));
    ok('career pick counts are tallied', idx.tendencies.some(l => /ALEX: 3 career picks/.test(l)),
        JSON.stringify(idx.tendencies));
    ok('only genuine first-round picks count toward tendencies',
        idx.tendencies.some(l => /ALEX.*RB 1/.test(l)) || idx.tendencies.some(l => /ALEX.*WR 1/.test(l)));
    ok('a pick at 30 is not first round',
        !idx.tendencies.some(l => /NICK.*RB 1/.test(l)), JSON.stringify(idx.tendencies));
    ok('no drafts is safe', S.draftIndex([]).repeat.length === 0);
}

console.log('\nTHE SHEET ITSELF');
{
    const s = season(2026, [['a', 120, 'b', 100]], { a: 1, b: 2 });
    const sheet = S.buildSheet({ seasons: [s] });
    ok('a sheet is produced', typeof sheet === 'string' && sheet.length > 500);
    ok('it names the league', /The League/.test(sheet));
    ok('career records present', /CAREER RECORDS/.test(sheet));
    ok('head-to-head present', /HEAD-TO-HEAD/.test(sheet));
    ok('record book present', /ALL-TIME RECORD BOOK/.test(sheet));
    ok('champions present', /CHAMPIONS/.test(sheet));
    ok('season by season present', /SEASON BY SEASON/.test(sheet));

    // The coverage block is the thing that stops the bot inventing answers.
    ok('the limits block is present', /DOES NOT COVER/.test(sheet));
    ok('it warns that weekly player data is one season only', /weeks? 4 of 2019|WEEKLY scoring exists/.test(sheet));
    ok('it forbids deriving new totals', /Do not derive new totals/.test(sheet));
    ok('it says transactions are absent', /Trades, waiver claims/.test(sheet));

    ok('empty input yields null, not an empty sheet', S.buildSheet({ seasons: [] }) === null);
    ok('null input is safe', S.buildSheet(null) === null);
    ok('a season with no games still builds',
        typeof S.buildSheet({ seasons: [{ season: 2026, teams: [], schedule: [] }] }) === 'string');
}

console.log('\nSTATUS');
{
    const st = S.stats({ seasons: [season(2026, [['a', 1, 'b', 2]])] });
    ok('reports availability', st.available === true);
    ok('reports size', st.chars > 0);
    ok('reports season count', st.seasons === 1);
    ok('empty data reports unavailable', S.stats({ seasons: [] }).available === false);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
