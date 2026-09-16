const H = require('../public/highscores.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/** Build a season where scores[week][teamIndex] drives everything. */
function season(year, scores, regWeeks) {
    const teams = [0,1,2,3].map(i => ({ id: i, name: 'T' + i }));
    const schedule = [];
    Object.keys(scores).forEach(w => {
        const wk = Number(w), s = scores[w];
        schedule.push({ matchupPeriodId: wk, home: { teamId: 0, totalPoints: s[0] }, away: { teamId: 1, totalPoints: s[1] } });
        schedule.push({ matchupPeriodId: wk, home: { teamId: 2, totalPoints: s[2] }, away: { teamId: 3, totalPoints: s[3] } });
    });
    return {
        season: year, teams, schedule,
        settings: { scheduleSettings: { matchupPeriodCount: regWeeks == null ? 13 : regWeeks } },
    };
}
const resolve = (id, s) => 'M' + id;

console.log('\nWEEKLY WINNERS');
{
    H.HS_MONEY_FROM = null;
    const s = season(2024, { 1: [100, 90, 80, 70], 2: [50, 60, 70, 120] }, 14);
    const w = H.hsWeeklyWinners([s], resolve);
    ok('one entry per eligible week', w.length === 2, 'got ' + w.length);
    ok('week 1 winner is the top scorer', w[0].winners[0].name === 'M0' && w[0].score === 100);
    ok('week 2 winner is the top scorer', w[1].winners[0].name === 'M3' && w[1].score === 120);
    ok('no ties flagged', w.every(x => !x.tie));
}

console.log('\nPLAYOFF WEEKS ARE EXCLUDED');
{
    // 13-week regular season; weeks 14-16 are playoffs and must not pay out.
    const s = season(2015, { 13: [100, 90, 80, 70], 14: [200, 10, 10, 10], 16: [190, 10, 10, 10] }, 13);
    const w = H.hsWeeklyWinners([s], resolve);
    ok('only the regular-season week counts', w.length === 1, 'got ' + w.length);
    ok('the 200-point playoff week is ignored', w[0].score === 100, 'score=' + w[0].score);
}
{
    // Same scores, but a 14-week regular season makes week 14 eligible.
    const s = season(2022, { 13: [100, 90, 80, 70], 14: [200, 10, 10, 10], 16: [190, 10, 10, 10] }, 14);
    const w = H.hsWeeklyWinners([s], resolve);
    ok('week 14 counts when the regular season is 14 weeks', w.length === 2);
    ok('and week 16 still does not', w.every(x => x.week <= 14));
}

console.log('\nTIES SPLIT THE PRIZE');
{
    H.HS_MONEY_FROM = 2020;
    const s = season(2024, { 1: [100, 100, 80, 70] }, 14);
    const w = H.hsWeeklyWinners([s], resolve);
    ok('tie is flagged', w[0].tie === true);
    ok('both teams listed', w[0].winners.length === 2);
    ok('prize splits to 12.50', w[0].money === 12.5, 'money=' + w[0].money);
    const byMgr = H.hsByManager(w);
    const total = byMgr.reduce((a, r) => a + r.money, 0);
    ok('season payout still totals $25', Math.abs(total - 25) < 0.001, 'total=' + total);
}

console.log('\nMONEY ONLY FROM THE CONFIGURED YEAR');
{
    H.HS_MONEY_FROM = 2020;
    const a = season(2015, { 1: [100, 90, 80, 70] }, 13);
    const b = season(2024, { 1: [100, 90, 80, 70] }, 14);
    const w = H.hsWeeklyWinners([a, b], resolve);
    const old = w.find(x => x.season === 2015), recent = w.find(x => x.season === 2024);
    ok('pre-rule week has a score', old && old.score === 100);
    ok('pre-rule week has no money', old.money === null && old.paid === false);
    ok('post-rule week is paid', recent.money === 25 && recent.paid === true);
    const rows = H.hsByManager(w);
    const m0 = rows.find(r => r.name === 'M0');
    ok('manager credited 2 weeks but only 1 payout', m0.weeks === 2 && m0.paidWeeks === 1, `${m0.weeks}/${m0.paidWeeks}`);
    ok('dollars reflect only the paid week', m0.money === 25, 'money=' + m0.money);
}
{
    H.HS_MONEY_FROM = null;
    const s = season(2024, { 1: [100, 90, 80, 70] }, 14);
    const w = H.hsWeeklyWinners([s], resolve);
    ok('money off entirely when unset', w[0].money === null && w[0].paid === false);
    ok('scores still tracked', w[0].score === 100);
}

console.log('\nCAREER TOTALS');
{
    H.HS_MONEY_FROM = 2011;
    const s = season(2024, { 1: [100, 90, 80, 70], 2: [110, 10, 10, 10], 3: [10, 10, 10, 95] }, 14);
    const w = H.hsWeeklyWinners([s], resolve);
    const rows = H.hsByManager(w);
    const m0 = rows.find(r => r.name === 'M0');
    ok('counts weeks won', m0.weeks === 2, 'weeks=' + m0.weeks);
    ok('sums the money', m0.money === 50, 'money=' + m0.money);
    ok('tracks personal best', m0.best.pts === 110 && m0.best.week === 2);
    ok('sorted by money', rows[0].name === 'M0');
    ok('everyone who won appears', rows.length === 2);
}

console.log('\nWON THE WEEK AND LOST THE GAME');
{
    H.HS_MONEY_FROM = 2011;
    // T0 scores 150 but faces T1's 160 — impossible, so instead: T0 150 vs T1 160
    // means T1 is the high scorer. Use T2 vs T3 to make the loser the league high.
    const s = { season: 2024, teams: [0,1,2,3].map(i => ({ id: i, name: 'T'+i })),
        settings: { scheduleSettings: { matchupPeriodCount: 14 } },
        schedule: [
            { matchupPeriodId: 1, home: { teamId: 0, totalPoints: 80 }, away: { teamId: 1, totalPoints: 70 } },
            { matchupPeriodId: 1, home: { teamId: 2, totalPoints: 140 }, away: { teamId: 3, totalPoints: 150 } },
        ] };
    const w = H.hsWeeklyWinners([s], resolve);
    ok('league high is the 150', w[0].score === 150 && w[0].winners[0].name === 'M3');
    ok('and that team won its game', w[0].winners[0].lostAnyway === false);

    const s2 = { season: 2023, teams: [0,1,2,3].map(i => ({ id: i, name: 'T'+i })),
        settings: { scheduleSettings: { matchupPeriodCount: 14 } },
        schedule: [
            { matchupPeriodId: 1, home: { teamId: 0, totalPoints: 150 }, away: { teamId: 1, totalPoints: 160 } },
            { matchupPeriodId: 1, home: { teamId: 2, totalPoints: 90 }, away: { teamId: 3, totalPoints: 80 } },
        ] };
    const w2 = H.hsWeeklyWinners([s2], resolve);
    ok('the 160 wins the week', w2[0].score === 160);
    const recs = H.hsRecords(w2);
    ok('records survive a normal week', recs && recs.totalWeeks === 1);
}

console.log('\nRECORD BOOK');
{
    H.HS_MONEY_FROM = 2011;
    const s = season(2024, { 1:[100,10,10,10], 2:[120,10,10,10], 3:[130,10,10,10], 5:[90,10,10,10], 6:[10,10,10,200] }, 14);
    const w = H.hsWeeklyWinners([s], resolve);
    const r = H.hsRecords(w);
    ok('highest ever found', r.highest.pts === 200 && r.highest.name === 'M3');
    ok('lowest winning score found', r.lowestWinning.pts === 90);
    ok('most weeks in a season', r.mostInSeason.name === 'M0' && r.mostInSeason.count === 4, JSON.stringify(r.mostInSeason));
    ok('streak found (weeks 1-3)', r.longestStreak && r.longestStreak.run === 3 && r.longestStreak.from === 1,
        JSON.stringify(r.longestStreak));
    ok('week 5 does not extend the streak', r.longestStreak.run === 3);
    ok('counts total weeks', r.totalWeeks === 5);
}

console.log('\nSEASON BREAKDOWN');
{
    H.HS_MONEY_FROM = 2011;
    const a = season(2024, { 1:[100,10,10,10], 2:[110,10,10,10] }, 14);
    const b = season(2023, { 1:[10,10,10,95] }, 14);
    const rows = H.hsBySeason(H.hsWeeklyWinners([a, b], resolve));
    ok('newest season first', rows[0].season === 2024);
    ok('season payout summed', rows[0].money === 50, 'money=' + rows[0].money);
    ok('top earner identified', rows[0].topEarner === 'M0' && rows[0].topEarnerWeeks === 2);
    ok('older season present', rows[1].season === 2023 && rows[1].money === 25);
}

console.log('\nEMPTY AND MISSING DATA');
{
    ok('no seasons returns nothing', H.hsWeeklyWinners([], resolve).length === 0);
    ok('records on empty is null', H.hsRecords([]) === null);
    const noSched = { season: 2010, teams: [], schedule: [] };
    ok('a season with no schedule is skipped', H.hsWeeklyWinners([noSched], resolve).length === 0);
    const unplayed = season(2026, { 1: [0, 0, 0, 0] }, 14);
    ok('unplayed weeks are skipped', H.hsWeeklyWinners([unplayed], resolve).length === 0);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
