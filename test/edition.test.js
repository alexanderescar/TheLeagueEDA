/**
 * edition.test.js — the masthead dateline.
 *
 * The first version assumed the season always opened on 8 September and printed
 * a wrong date every year. The NFL opens on the Thursday after Labor Day, which
 * is the first Monday in September, so the whole calendar derives from that.
 * These functions live in index.html; the logic is mirrored here because that
 * file cannot be imported.
 */
let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

function seasonOpener(year) {
    const sept1 = new Date(Date.UTC(year, 8, 1));
    const firstMonday = 1 + ((8 - sept1.getUTCDay()) % 7);
    return new Date(Date.UTC(year, 8, firstMonday + 3));
}
function editionDate(year, week) {
    return new Date(seasonOpener(year).getTime() + ((week - 1) * 7 + 5) * 86400000);
}
const iso = d => d.toISOString().slice(0, 10);
const dow = d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];

console.log('\nSEASON OPENER  (Thursday after the first Monday in September)');
{
    ok('2026 opens 10 September', iso(seasonOpener(2026)) === '2026-09-10', iso(seasonOpener(2026)));
    ok('2025 opens 4 September',  iso(seasonOpener(2025)) === '2025-09-04', iso(seasonOpener(2025)));
    ok('2024 opens 5 September',  iso(seasonOpener(2024)) === '2024-09-05', iso(seasonOpener(2024)));
    for (let y = 2010; y <= 2035; y++) {
        if (dow(seasonOpener(y)) !== 'Thu') { ok('opener is a Thursday in ' + y, false, dow(seasonOpener(y))); break; }
        if (y === 2035) ok('every season 2010-2035 opens on a Thursday', true);
    }
    // Labor Day can fall as late as the 7th, pushing the opener to the 10th.
    ok('the opener never precedes 4 September',
        [...Array(26)].every((_, i) => seasonOpener(2010 + i).getUTCDate() >= 4));
    ok('and never follows 10 September',
        [...Array(26)].every((_, i) => seasonOpener(2010 + i).getUTCDate() <= 10));
}

console.log('\nEDITION DATE  (the Tuesday after the week wraps)');
{
    // The case that prompted the fix: Week 3 of 2026 is today, 29 September.
    ok('2026 week 3 is Tuesday 29 September',
        iso(editionDate(2026, 3)) === '2026-09-29', iso(editionDate(2026, 3)));
    ok('2026 week 1 is Tuesday 15 September', iso(editionDate(2026, 1)) === '2026-09-15');
    ok('2026 week 4 is Tuesday 6 October',    iso(editionDate(2026, 4)) === '2026-10-06');
    for (let w = 1; w <= 17; w++) {
        if (dow(editionDate(2026, w)) !== 'Tue') { ok('week ' + w + ' is a Tuesday', false, dow(editionDate(2026, w))); break; }
        if (w === 17) ok('every week of 2026 lands on a Tuesday', true);
    }
    ok('consecutive weeks are exactly seven days apart',
        editionDate(2026, 5) - editionDate(2026, 4) === 7 * 86400000);
    ok('editions advance through the season',
        editionDate(2026, 14) > editionDate(2026, 1));
    ok('a playoff week still resolves', iso(editionDate(2026, 16)) === '2026-12-29');
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
