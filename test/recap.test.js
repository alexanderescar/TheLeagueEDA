const R = require('../public/recap.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

// ── Synthetic 12-team league with a full snake draft and round-robin schedule ──
function makeLeague({ teams = 12, rounds = 16, seed = 1, skill = null } = {}) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const posCycle = ['RB','WR','RB','WR','QB','TE','WR','RB','WR','RB','QB','TE','WR','RB','D/ST','K'];
    const picks = [];
    let n = 0;
    for (let r = 0; r < rounds; r++) {
        const order = [...Array(teams).keys()];
        if (r % 2 === 1) order.reverse();
        for (const t of order) {
            n++;
            const base = Math.max(20, 330 - n * 1.4);
            const bump = skill ? skill[t] * 14 : 0;
            const proj = base + bump + rnd() * 14;
            picks.push({
                teamId: t, pick: n, pos: posCycle[r], name: `P${n}`,
                espnProj: Math.round(proj * 10) / 10,
                espnRank: n + Math.round((rnd() - 0.5) * 24),
                fpEcr:    n + Math.round((rnd() - 0.5) * 24),
                fpStd:    Math.round(rnd() * 40) / 10,
                fpTier:   Math.ceil(n / 12),
                bye:      5 + (n % 9),
                keeper:   false,
            });
        }
    }
    const teamList = [...Array(teams).keys()].map(i => ({ id: i, manager: `M${i}`, teamName: `T${i}` }));
    // Double round-robin-ish: 13 weeks
    const schedule = [];
    for (let w = 1; w <= 13; w++) {
        const ids = [...Array(teams).keys()];
        const rot = ids.slice(1);
        const shift = (w - 1) % rot.length;
        const arranged = [ids[0], ...rot.slice(shift), ...rot.slice(0, shift)];
        for (let i = 0; i < teams / 2; i++) {
            schedule.push({ week: w, home: arranged[i], away: arranged[teams - 1 - i] });
        }
    }
    return { picks, teams: teamList, schedule };
}

console.log('\nPLAYOFF ODDS CONSERVATION  (6 spots must be handed out every simulated season)');
{
    const { picks, teams, schedule } = makeLeague({ seed: 3 });
    const res = R.buildRecap(picks, teams, schedule, 6);
    const sum = res.rows.reduce((a, r) => a + r.playoffPct, 0);
    ok('playoff percentages sum to 600 (6 of 12)', Math.abs(sum - 600) < 1.5, 'sum=' + sum.toFixed(1));
    const tsum = res.rows.reduce((a, r) => a + r.titlePct, 0);
    ok('title odds sum to 100', Math.abs(tsum - 100) < 1.5, 'sum=' + tsum.toFixed(1));
    ok('every team has odds', res.rows.every(r => r.playoffPct != null));
    ok('odds are probabilities', res.rows.every(r => r.playoffPct >= 0 && r.playoffPct <= 100));
}

console.log('\nCALIBRATION  (odds must stay honest, not confident)');
{
    const skill = [4,3,2,1,0.5,0,-0.5,-1,-2,-3,-4,-5];
    const { picks, teams, schedule } = makeLeague({ seed: 8, skill });
    const res = R.buildRecap(picks, teams, schedule, 6);
    const pcts = res.rows.map(r => r.playoffPct);
    const spread = Math.max(...pcts) - Math.min(...pcts);
    ok('a huge talent gap still produces a modest spread', spread < 32, 'spread=' + spread.toFixed(1));
    ok('no team is given a near-lock', Math.max(...pcts) < 75, 'max=' + Math.max(...pcts));
    ok('no team is written off entirely', Math.min(...pcts) > 25, 'min=' + Math.min(...pcts));
    ok('reliability shrinkage is applied', R.PROJECTION_RELIABILITY <= 0.25, 'r=' + R.PROJECTION_RELIABILITY);
    // The better roster should still be favoured, just not wildly.
    const best = res.rows.find(r => r.teamId === 0), worst = res.rows.find(r => r.teamId === 11);
    ok('the stronger roster is still favoured', best.playoffPct > worst.playoffPct,
        `${best.playoffPct} vs ${worst.playoffPct}`);
}

console.log('\nTIER BANDS  (must not split effectively identical teams)');
{
    // Two teams a coin-flip apart must not land in different tiers.
    const a = R.oddsTier(50.4, 50), b = R.oddsTier(51.1, 50);
    ok('50.4% and 51.1% get the same tier', a.tier === b.tier, `${a.tier} vs ${b.tier}`);
    ok('a team at the baseline is called a coin flip', R.oddsTier(50, 50).tier === 'Coin flip');
    ok('+1 point is still a coin flip', R.oddsTier(51, 50).tier === 'Coin flip');
    ok('+8 is a contender', R.oddsTier(58, 50).tier === 'Contender');
    ok('-10 is a long shot', R.oddsTier(40, 50).tier === 'Long shot');
    // Bands must be wider than simulation noise (~1pt at 10k iterations).
    let flips = 0;
    for (let p = 30; p <= 70; p += 0.1) {
        if (R.oddsTier(p, 50).tier !== R.oddsTier(p + 1, 50).tier) flips++;
    }
    ok('at most 4 tier boundaries across the whole range', flips <= 45, 'boundary crossings=' + flips);
    ok('tiers respect a non-50 baseline', R.oddsTier(57, 50).tier !== R.oddsTier(57, 64).tier);
}

console.log('\nCALIBRATION IS NOT OVERCONFIDENT');
{
    ok('reliability stays close to the measured 0.074',
        R.PROJECTION_RELIABILITY <= 0.12,
        'reliability=' + R.PROJECTION_RELIABILITY + ' (0.20 stretches odds to 34-71%, unsupported)');
}

console.log('\nDETERMINISM  (same input must give the same odds every page load)');
{
    const { picks, teams, schedule } = makeLeague({ seed: 5 });
    const a = R.buildRecap(picks.map(p => ({...p})), teams, schedule, 6);
    const b = R.buildRecap(picks.map(p => ({...p})), teams, schedule, 6);
    const same = a.rows.every((r, i) => r.playoffPct === b.rows[i].playoffPct);
    ok('odds are reproducible', same);
}

console.log('\nSCHEDULE ACTUALLY MATTERS');
{
    const { picks, teams } = makeLeague({ seed: 9 });
    // Team 0 plays only the strongest opponent every week; team 1 plays only the weakest.
    const brutal = [], easy = [];
    for (let w = 1; w <= 13; w++) {
        brutal.push({ week: w, home: 0, away: 2 });
        easy.push({ week: w, home: 1, away: 3 });
    }
    const means = { 0: 130, 1: 130, 2: 140, 3: 100 };
    const sim = R.simulatePlayoffs(means, brutal.concat(easy), 2, { iterations: 4000 });
    ok('the team with the brutal draw fares worse than the identical team with an easy one',
        sim[1].playoffPct > sim[0].playoffPct,
        `brutal=${sim[0].playoffPct} easy=${sim[1].playoffPct}`);
}

console.log('\nGRADES');
{
    const skill = [3,2,1,0.5,0,0,0,0,-0.5,-1,-2,-3];
    const { picks, teams, schedule } = makeLeague({ seed: 11, skill });
    const res = R.buildRecap(picks, teams, schedule, 6);
    const top = res.rows[0];
    ok('rows are ranked by grade', res.rows.every((r, i) => i === 0 || res.rows[i-1].gradeZ >= r.gradeZ));
    ok('best roster grades in the A/B range', /^[AB]/.test(top.grade), top.grade);
    ok('grades vary across the league', new Set(res.rows.map(r => r.grade)).size >= 4);
    ok('grade blends both signals', res.rows.every(r => r.zPoints != null && r.zBoard != null));
}

console.log('\nLINEUP OPTIMISER');
{
    const players = [
        { pos:'QB', proj:300, name:'qb1' }, { pos:'QB', proj:250, name:'qb2' },
        { pos:'RB', proj:280, name:'rb1' }, { pos:'RB', proj:200, name:'rb2' }, { pos:'RB', proj:190, name:'rb3' },
        { pos:'WR', proj:270, name:'wr1' }, { pos:'WR', proj:210, name:'wr2' }, { pos:'WR', proj:205, name:'wr3' },
        { pos:'TE', proj:150, name:'te1' }, { pos:'K', proj:120, name:'k1' }, { pos:'D/ST', proj:110, name:'d1' },
    ];
    const lu = R.bestLineup(players);
    ok('starts exactly 10', lu.starters.length === 10, 'got ' + lu.starters.length);
    ok('starts the better QB only once', lu.starters.filter(p => p.pos === 'QB').length === 1);
    ok('flex goes to the best remaining flex-eligible', lu.starters.some(p => p.name === 'rb3') || lu.starters.some(p => p.name === 'wr3'));
    ok('total is the sum of starters', near(lu.total, lu.starters.reduce((a,p)=>a+p.proj,0), 0.05));
}

console.log('\nSUPERLATIVES & ROSTER SHAPE');
{
    const { picks, teams, schedule } = makeLeague({ seed: 15 });
    const res = R.buildRecap(picks, teams, schedule, 6);
    const s = res.superlatives;
    ok('a steal is identified', s.steal && s.steal.name);
    ok('a reach is identified', s.reach && s.reach.name);
    ok('steal beat the board, reach did not', s.steal.slotValue > 0 && s.reach.slotValue < 0,
        `steal=${s.steal.slotValue} reach=${s.reach.slotValue}`);
    ok('a most-controversial pick is found', s.controversial && s.controversial.std != null);
    ok('every team gets a roster shape', res.rows.every(r => !!r.shape));
    ok('positional ranks are 1..12', res.rows.every(r => ['QB','RB','WR','TE'].every(p => r.pos[p].rank >= 1 && r.pos[p].rank <= 12)));
    ok('top-heaviness is a percentage', res.rows.every(r => r.topHeavy > 0 && r.topHeavy < 100));
}

console.log('\nMISSING DATA');
{
    const { picks, teams, schedule } = makeLeague({ seed: 21 });
    picks.forEach((p, i) => { if (i % 5 === 0) { p.fpEcr = null; p.fpStd = null; } });
    picks.forEach((p, i) => { if (i % 11 === 0) { p.espnProj = null; } });
    const res = R.buildRecap(picks, teams, schedule, 6);
    ok('survives partial FantasyPros coverage', res && res.rows.length === 12);
    ok('odds still conserve', Math.abs(res.rows.reduce((a,r)=>a+r.playoffPct,0) - 600) < 1.5);
    ok('grades still finite', res.rows.every(r => isFinite(r.gradeZ)));
}
{
    const { picks, teams } = makeLeague({ seed: 2 });
    const res = R.buildRecap(picks, teams, [], 6);
    ok('no schedule = no odds, but no crash', res && res.rows.every(r => r.playoffPct == null));
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
