/**
 * crossseason.test.js — points and games must count the same set of matches.
 *
 * The bug this exists to prevent: buildCrossSeasonStats took the win/loss record
 * from ESPN's record.overall, which is regular season only, but took points-for
 * from t.points, which is the season total INCLUDING playoffs. Dividing one by the
 * other produced a points-per-game figure for anything that reached the playoffs.
 *
 * Nick's 2018 was the worst case and the one that surfaced it: 2222.02 points over
 * 15 games (13 regular, 2 playoff) divided by his 13-game regular-season record,
 * reported as 170.9 ppg against a true 148.1.
 *
 * buildCrossSeasonStats lives in index.html and cannot be imported, so the fixed
 * logic is mirrored here. The invariant under test is the one that matters: every
 * rate is a ratio of two quantities measured over the same games.
 */
let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/** Mirrors the fixed block in index.html. */
function crossSeason(season) {
    const regWeeks = (season.settings.scheduleSettings || {}).matchupPeriodCount;
    const pfMap = {}, paMap = {};
    (season.schedule || []).forEach(m => {
        if (!m.home || !m.away) return;
        const hp = m.home.totalPoints || 0, ap = m.away.totalPoints || 0;
        if (hp <= 0 && ap <= 0) return;                       // unplayed
        if (m.matchupPeriodId != null && regWeeks && m.matchupPeriodId > regWeeks) return;
        pfMap[m.home.teamId] = (pfMap[m.home.teamId] || 0) + hp;
        paMap[m.home.teamId] = (paMap[m.home.teamId] || 0) + ap;
        pfMap[m.away.teamId] = (pfMap[m.away.teamId] || 0) + ap;
        paMap[m.away.teamId] = (paMap[m.away.teamId] || 0) + hp;
    });
    return (season.teams || []).map(t => {
        const rec = (t.record || {}).overall || {};
        const w = rec.wins || 0, l = rec.losses || 0, gp = (w + l) || 1;
        const pf = pfMap[t.id] != null ? pfMap[t.id] : (t.points || 0);
        const pa = paMap[t.id] != null ? paMap[t.id] : (t.pointsAgainst || 0);
        return { owner: t.managerNick, wins: w, losses: l, gp, pf, pa, ppg: pf / gp, papg: pa / gp };
    });
}

/** Nick's 2018, reconstructed: 13-0 regular season then two playoff wins. */
function nick2018() {
    const teams = [
        { id: 1, managerNick: 'Nick', record: { overall: { wins: 13, losses: 0 } }, points: 2222.02 },
        { id: 2, managerNick: 'Foil', record: { overall: { wins: 0, losses: 13 } }, points: 1500 },
    ];
    const schedule = [];
    // 13 regular-season weeks: Nick scores 148.4 a week, opponent 100.
    for (let w = 1; w <= 13; w++) {
        schedule.push({
            matchupPeriodId: w,
            home: { teamId: 1, totalPoints: 148.4 },
            away: { teamId: 2, totalPoints: 100 },
        });
    }
    // Two playoff weeks at a higher clip — these must not reach the ppg figure.
    [14, 15].forEach(w => {
        schedule.push({
            matchupPeriodId: w,
            home: { teamId: 1, totalPoints: 146.38 },
            away: { teamId: 2, totalPoints: 90 },
        });
    });
    return { season: 2018, teams, schedule, settings: { scheduleSettings: { matchupPeriodCount: 13 } } };
}

console.log('\nTHE 2018 CASE');
{
    const s = nick2018();
    const rows = crossSeason(s);
    const n = rows.filter(r => r.owner === 'Nick')[0];

    ok('the regular-season record is unchanged', n.wins === 13 && n.losses === 0);
    ok('games played is the regular season', n.gp === 13, String(n.gp));
    ok('points for excludes the playoff run',
        Math.abs(n.pf - 13 * 148.4) < 0.01, String(n.pf));
    ok('and is NOT the ESPN season total', Math.abs(n.pf - 2222.02) > 1, String(n.pf));
    ok('ppg is the true regular-season average',
        Math.abs(n.ppg - 148.4) < 0.01, String(n.ppg));
    ok('the old inflated figure is gone', n.ppg < 160, String(n.ppg));
    ok('points against is regular season too',
        Math.abs(n.pa - 13 * 100) < 0.01, String(n.pa));
    ok('papg matches', Math.abs(n.papg - 100) < 0.01, String(n.papg));
}

console.log('\nTHE INVARIANT  (every rate divides matching quantities)');
{
    const rows = crossSeason(nick2018());
    ok('ppg always equals pf over gp', rows.every(r => Math.abs(r.ppg - r.pf / r.gp) < 1e-9));
    ok('papg always equals pa over gp', rows.every(r => Math.abs(r.papg - r.pa / r.gp) < 1e-9));
    // A team that never reached the playoffs was always correct; it must stay so.
    const foil = rows.filter(r => r.owner === 'Foil')[0];
    ok('a non-playoff team is unaffected', Math.abs(foil.ppg - 100) < 0.01, String(foil.ppg));
    ok('both sides of a game agree on points',
        Math.abs(rows[0].pf - rows[1].pa) < 0.01);
}

console.log('\nNO PLAYOFFS, NO DIFFERENCE');
{
    // A season that never went past the regular season must be identical either way.
    const s = nick2018();
    s.schedule = s.schedule.filter(m => m.matchupPeriodId <= 13);
    const n = crossSeason(s).filter(r => r.owner === 'Nick')[0];
    ok('a regular-season-only season is unchanged', Math.abs(n.ppg - 148.4) < 0.01);
}

console.log('\nFALLBACKS AND EDGE CASES');
{
    // 2010 has no matchup data at all; ESPN totals are the only source.
    const bare = {
        season: 2010,
        teams: [{ id: 1, managerNick: 'Old', record: { overall: { wins: 7, losses: 6 } }, points: 1300, pointsAgainst: 1250 }],
        schedule: [],
        settings: { scheduleSettings: { matchupPeriodCount: 13 } },
    };
    const r = crossSeason(bare)[0];
    ok('falls back to ESPN totals when there is no schedule', r.pf === 1300 && r.pa === 1250);
    ok('and still produces a rate', Math.abs(r.ppg - 1300 / 13) < 0.01, String(r.ppg));

    // Unplayed games must not count as zero-point games.
    const partial = {
        season: 2026,
        teams: [{ id: 1, managerNick: 'Now', record: { overall: { wins: 1, losses: 0 } } },
                { id: 2, managerNick: 'Opp', record: { overall: { wins: 0, losses: 1 } } }],
        schedule: [
            { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 120 }, away: { teamId: 2, totalPoints: 90 } },
            { matchupPeriodId: 2, home: { teamId: 1, totalPoints: 0 }, away: { teamId: 2, totalPoints: 0 } },
        ],
        settings: { scheduleSettings: { matchupPeriodCount: 14 } },
    };
    const p = crossSeason(partial)[0];
    ok('an unplayed week adds nothing', p.pf === 120, String(p.pf));
    ok('and does not drag the average down', Math.abs(p.ppg - 120) < 0.01, String(p.ppg));

    // A missing matchupPeriodCount must not silently drop every game.
    const noReg = nick2018();
    noReg.settings.scheduleSettings = {};
    const nr = crossSeason(noReg).filter(r => r.owner === 'Nick')[0];
    ok('without a regular-season length, nothing is dropped', nr.pf > 0, String(nr.pf));
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
