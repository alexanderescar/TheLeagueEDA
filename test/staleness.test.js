/**
 * staleness.test.js — the guard that would have caught the September outage.
 *
 * Background: the boot scrape used to fire only when the data file was absent. On an
 * ephemeral disk that was true after every redeploy, so the site stayed current by
 * accident. Mounting a volume made the file persist, the boot scrape stopped firing,
 * and a disabled refresh task went unnoticed for six days.
 *
 * server.js is not importable (it binds a port on require), so rather than spawn it
 * here, this tests the decision rule itself against the same boundaries the live
 * server uses. The end-to-end behaviour is exercised separately by booting the server
 * against fake file ages.
 */

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const DEFAULT_LIMIT = 3;

/** Mirrors server.js: Infinity when the file is missing. */
function ageDays(mtimeMs, now) {
    if (mtimeMs == null) return Infinity;
    return (now - mtimeMs) / 86400000;
}
function isStale(ageInDays, limit) {
    return !(ageInDays <= (limit == null ? DEFAULT_LIMIT : limit));
}

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const daysAgo = (d) => NOW - d * 86400000;

console.log('\nAGE CALCULATION');
{
    ok('missing file is infinitely old', ageDays(null, NOW) === Infinity);
    ok('fresh file is ~0 days', ageDays(NOW, NOW) === 0);
    ok('one day ago', Math.abs(ageDays(daysAgo(1), NOW) - 1) < 1e-9);
    ok('six days ago (the actual outage)', Math.abs(ageDays(daysAgo(6), NOW) - 6) < 1e-9);
}

console.log('\nTHE BOUNDARY  (limit is 3 days)');
{
    ok('missing file is stale', isStale(ageDays(null, NOW)));
    ok('brand new is fresh', !isStale(ageDays(NOW, NOW)));
    ok('2 days is fresh — a routine deploy must not rescrape', !isStale(ageDays(daysAgo(2), NOW)));
    ok('exactly 3 days is fresh (inclusive)', !isStale(ageDays(daysAgo(3), NOW)));
    ok('3 days and a minute is stale', isStale(ageDays(daysAgo(3) - 60000, NOW)));
    ok('4 days is stale', isStale(ageDays(daysAgo(4), NOW)));
    ok('the 6-day outage would have been caught', isStale(ageDays(daysAgo(6), NOW)));
}

console.log('\nWHY 3 AND NOT 1 OR 7');
{
    // A missed Tuesday refresh means the data is ~7 days old by the next Tuesday, but
    // it crosses the line within 3 — so any deploy or restart after Friday rescues it.
    ok('a missed weekly refresh is stale well before the next one',
        isStale(ageDays(daysAgo(3.5), NOW)));
    // Deploys during a normal week must not trigger a full ESPN rescrape.
    ok('same-day redeploy does not rescrape', !isStale(ageDays(daysAgo(0.2), NOW)));
    ok('next-day redeploy does not rescrape', !isStale(ageDays(daysAgo(1), NOW)));
    // A 7-day limit would have let the real outage run its full course unnoticed.
    ok('a 7-day limit would NOT have caught the outage', !isStale(ageDays(daysAgo(6), NOW), 7));
    ok('a 1-day limit would rescrape on ordinary deploys', isStale(ageDays(daysAgo(1.5), NOW), 1));
}

console.log('\nOVERRIDE');
{
    ok('a larger limit tolerates older data', !isStale(ageDays(daysAgo(5), NOW), 7));
    ok('a smaller limit is stricter', isStale(ageDays(daysAgo(2), NOW), 1));
    ok('limit 0 makes everything stale', isStale(ageDays(daysAgo(0.01), NOW), 0));
}

console.log('\nBAD CLOCKS AND BAD INPUT');
{
    // A file mtime in the future (clock skew, restored backup) yields a negative age.
    // It must read as fresh rather than wrapping around into stale.
    ok('a future mtime is treated as fresh', !isStale(ageDays(NOW + 86400000, NOW)));
    ok('undefined mtime is stale, not a crash', isStale(ageDays(undefined, NOW)));
    ok('NaN age is stale rather than silently fresh', isStale(NaN),
        'NaN comparisons are false, so the rule must be written as !(age <= limit)');
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
