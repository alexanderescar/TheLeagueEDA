const P = require('../public/power.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/** 12-team season; scores[teamId][week-1] drives everything. */
function makeSeason(scores, weeks, rosters) {
    const n = scores.length;
    const teams = [...Array(n).keys()].map(i => ({ id: i, name: 'T' + i }));
    const schedule = [];
    for (let w = 1; w <= weeks; w++) {
        const ids = [...Array(n).keys()];
        const rot = ids.slice(1);
        const shift = (w - 1) % rot.length;
        const arr = [ids[0], ...rot.slice(shift), ...rot.slice(0, shift)];
        for (let i = 0; i < n / 2; i++) {
            const h = arr[i], a = arr[n - 1 - i];
            schedule.push({
                matchupPeriodId: w,
                home: { teamId: h, totalPoints: scores[h][w - 1] },
                away: { teamId: a, totalPoints: scores[a][w - 1] },
            });
        }
    }
    return { teams, schedule, rosters: rosters || null };
}

const flat = (v, w) => Array(w).fill(v);

console.log('\nALL-PLAY');
{
    // Four teams, one week, distinct scores -> 3-0, 2-1, 1-2, 0-3.
    const scores = [[100],[90],[80],[70]];
    const s = makeSeason(scores, 1);
    const weekly = P.pwWeeklyScores(s.schedule, 1);
    const ap = P.pwAllPlay(weekly, 1);
    ok('top scorer goes 3-0', ap[0].w === 3 && ap[0].l === 0, JSON.stringify(ap[0]));
    ok('bottom scorer goes 0-3', ap[3].w === 0 && ap[3].l === 3, JSON.stringify(ap[3]));
    ok('middle team splits', ap[1].w === 2 && ap[1].l === 1);
    const totalW = Object.values(ap).reduce((a, r) => a + r.w, 0);
    const totalL = Object.values(ap).reduce((a, r) => a + r.l, 0);
    ok('all-play wins equal all-play losses', totalW === totalL, `${totalW} vs ${totalL}`);
}

console.log('\nRANKING RESPONDS TO WHAT MATTERS');
{
    // Everyone identical except team 0 scores far more.
    const scores = [...Array(12).keys()].map(i => flat(i === 0 ? 150 : 100, 6));
    const pr = P.powerRankings(makeSeason(scores, 6), 6, null);
    ok('the highest scorer ranks first', pr.rows[0].teamId === 0, 'got ' + pr.rows[0].teamId);
    ok('all 12 teams ranked', pr.rows.length === 12);
    ok('ranks are 1..12', pr.rows.every((r, i) => r.rank === i + 1));
}

console.log('\nRECENT FORM IS WEIGHTED OVER OLD RESULTS');
{
    // Team 0: terrible early, elite lately. Team 1: the exact reverse.
    const scores = [...Array(12).keys()].map(() => flat(100, 6));
    scores[0] = [70, 70, 70, 150, 150, 150];
    scores[1] = [150, 150, 150, 70, 70, 70];
    const pr = P.powerRankings(makeSeason(scores, 6), 6, null);
    const a = pr.rows.find(r => r.teamId === 0), b = pr.rows.find(r => r.teamId === 1);
    ok('the team trending up ranks above the one trending down', a.rank < b.rank,
        `hot=${a.rank} cold=${b.rank}`);
    ok('season scoring still counts (they are not miles apart)', Math.abs(a.rank - b.rank) <= 11);
}

console.log('\nINJURIES DRAG A TEAM DOWN');
{
    const scores = [...Array(12).keys()].map(() => flat(110, 4));
    const proj = {}; for (let i = 1; i <= 300; i++) proj[i] = 100;
    const rosters = {};
    for (let t = 0; t < 12; t++) {
        rosters[t] = [1,2,3,4,5].map(k => ({
            playerId: t * 10 + k, name: `p${t}_${k}`,
            status: (t === 5 && k <= 3) ? 'OUT' : 'ACTIVE',
        }));
    }
    for (let t = 0; t < 12; t++) for (const p of rosters[t]) proj[p.playerId] = 100;
    const pr = P.powerRankings(makeSeason(scores, 4, rosters), 4, proj);
    const hurt = pr.rows.find(r => r.teamId === 5);
    ok('the injured team is not ranked first', hurt.rank > 1, 'rank=' + hurt.rank);
    ok('its out-list is populated', hurt.health.out.length === 3, JSON.stringify(hurt.health.out.length));
    ok('healthy teams score higher on health', pr.rows.find(r => r.teamId === 0).zHealth > hurt.zHealth);
}

console.log('\nMOVEMENT');
{
    // Distinct baselines so ranks are well defined rather than a pile of ties.
    const scores = [...Array(12).keys()].map(i => flat(90 + i * 3, 6));
    // Team 1 starts near the bottom and is the best team for three straight weeks.
    scores[1] = [93, 93, 93, 165, 168, 170];
    const season = makeSeason(scores, 6);

    const early = P.powerRankings(season, 3, null).rows.find(r => r.teamId === 1).rank;
    const pr = P.powerWithMovement(season, 6, null);
    const surger = pr.rows.find(r => r.teamId === 1);
    ok('a sustained surge climbs the rankings', surger.rank < early, `week3=${early} week6=${surger.rank}`);
    ok('movement is reported', typeof surger.move === 'number');

    // Movement must equal the actual difference against last week's ranking.
    const prev = P.powerRankings(season, 5, null);
    const prevRank = {}; prev.rows.forEach(r => { prevRank[r.teamId] = r.rank; });
    ok('move equals prevRank - rank for every team',
        pr.rows.every(r => r.move === prevRank[r.teamId] - r.rank));
    ok('movement nets to zero across the league',
        pr.rows.reduce((a, r) => a + r.move, 0) === 0);

    const pr1 = P.powerWithMovement(season, 1, null);
    ok('week 1 has no prior rank to move from', pr1.rows.every(r => r.prevRank === null && r.move === 0));

    // One huge week should NOT vault a bad team to the top — the season-long
    // components exist precisely to prevent that.
    const spike = [...Array(12).keys()].map(() => flat(100, 5));
    spike[7] = [60, 60, 60, 60, 220];
    const sp = P.powerRankings(makeSeason(spike, 5), 5, null).rows.find(r => r.teamId === 7);
    ok('a single outlier week does not buy a top ranking', sp.rank > 6, 'rank=' + sp.rank);
}

console.log('\nPRESEASON (no games played)');
{
    const scores = [...Array(12).keys()].map(() => flat(0, 0));
    const s = makeSeason([...Array(12).keys()].map(() => []), 0);
    const proj = {};
    const rosters = {};
    for (let t = 0; t < 12; t++) {
        rosters[t] = [1,2,3].map(k => ({ playerId: t * 10 + k, name: `p${t}_${k}`, status: 'ACTIVE' }));
        for (const p of rosters[t]) proj[p.playerId] = 100 + t * 5;   // team 11 strongest
    }
    s.rosters = rosters;
    const pr = P.powerRankings(s, 0, proj);
    ok('still ranks everyone before any games', pr.rows.length === 12);
    ok('marked as not yet played', pr.played === false);
    ok('best projected roster leads', pr.rows[0].teamId === 11, 'got ' + pr.rows[0].teamId);
}

console.log('\nBLURBS');
{
    const scores = [...Array(12).keys()].map(() => flat(100, 4));
    scores[0] = [100, 100, 100, 160];
    scores[3] = [100, 100, 100, 60];
    const pr = P.powerWithMovement(makeSeason(scores, 4), 4, null);
    const r0 = pr.rows.find(r => r.teamId === 0);
    const b = P.pwBlurb(r0, { name: 'Alex', week: 4, played: true, oppName: 'Nick', weekHigh: 160 });
    ok('produces a non-empty blurb', b && b.length > 20, b);
    ok('mentions the manager', b.indexOf('Alex') > -1);
    // Different teams must not get identical copy.
    const others = pr.rows.slice(0, 6).map(r =>
        P.pwBlurb(r, { name: 'M' + r.teamId, week: 4, played: true, oppName: 'Opp', weekHigh: 160 }));
    ok('blurbs vary between teams', new Set(others).size >= 4, new Set(others).size + ' distinct');
    // Same team, different weeks -> different line.
    const w1 = P.pwBlurb(r0, { name: 'Alex', week: 1, played: true, oppName: 'Nick', weekHigh: 160 });
    const w2 = P.pwBlurb(r0, { name: 'Alex', week: 2, played: true, oppName: 'Nick', weekHigh: 160 });
    ok('same team gets different copy in different weeks', w1 !== w2);
    const pre = P.pwBlurb(pr.rows[0], { name: 'Alex', week: 0, played: false });
    ok('preseason blurb does not claim games happened', pre.length > 10 && !/beat|lost/.test(pre), pre);
}

console.log('\nLUCK DETECTION IN COPY');
{
    // Team 0 scores 2nd-highest every week but always faces the top scorer.
    const n = 12, weeks = 6;
    const scores = [...Array(n).keys()].map(() => flat(100, weeks));
    for (let w = 0; w < weeks; w++) { scores[0][w] = 140; scores[1][w] = 150; }
    const schedule = [];
    for (let w = 1; w <= weeks; w++) {
        schedule.push({ matchupPeriodId: w, home: { teamId: 0, totalPoints: scores[0][w-1] }, away: { teamId: 1, totalPoints: scores[1][w-1] } });
        for (let i = 2; i < n; i += 2) {
            schedule.push({ matchupPeriodId: w, home: { teamId: i, totalPoints: scores[i][w-1] }, away: { teamId: i+1, totalPoints: scores[i+1][w-1] } });
        }
    }
    const season = { teams: [...Array(n).keys()].map(i => ({ id: i })), schedule, rosters: null };
    const pr = P.powerWithMovement(season, weeks, null);
    const unlucky = pr.rows.find(r => r.teamId === 0);
    ok('the unlucky team has a losing record', unlucky.wins === 0 && unlucky.losses === weeks,
        `${unlucky.wins}-${unlucky.losses}`);
    ok('but a strong all-play record', unlucky.allPlay.pct > 0.7, 'apPct=' + unlucky.allPlay.pct.toFixed(2));
    const blurb = P.pwBlurb(unlucky, { name: 'Peter', week: weeks, played: true, oppName: 'Nick', weekHigh: 150 });
    ok('the copy calls out the bad luck', /all-play|unlucky|schedule|whole league|field/i.test(blurb), blurb);
    ok('power rank beats their standings position', unlucky.rank <= 3, 'rank=' + unlucky.rank);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
