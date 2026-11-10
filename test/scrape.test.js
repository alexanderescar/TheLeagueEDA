/**
 * Tests for the scrape write guard.
 *
 * Background: on 10 Nov 2026 a scrape overwrote sixteen seasons of league history
 * with a single season. The old guard was `if (allData.length === 0) throw`, which
 * only caught a total failure — and since every per-season fetch has its own
 * try/catch, fifteen failures out of sixteen left one season in the array, passed
 * the guard, and replaced the file. The volume is mounted at /app/data, so the loss
 * was persistent.
 *
 * These test the real exported functions, not reimplementations of them.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const S    = require('../scrape.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('\nMAY-REPLACE  (the guard that would have stopped the incident)');
{
    // The exact shape of the real failure: 1 fresh season, 16 on disk.
    const r = S.mayReplace(1, 16, {});
    ok('a 1-season scrape may NOT replace 16 seasons', r.ok === false, JSON.stringify(r));
    ok('and it says why in plain terms',
        /1 season but 16 are already on disk/.test(r.reason), r.reason);

    ok('an empty scrape is refused', S.mayReplace(0, 16, {}).ok === false);
    ok('an empty scrape is refused even with nothing on disk',
        S.mayReplace(0, 0, {}).ok === false);
    ok('an empty scrape is refused even when forced',
        S.mayReplace(0, 16, { force: true }).ok === false);

    ok('the same count may replace', S.mayReplace(16, 16, {}).ok === true);
    ok('more seasons may replace', S.mayReplace(17, 16, {}).ok === true);
    ok('one fewer is still refused — off-by-one is the dangerous case',
        S.mayReplace(15, 16, {}).ok === false);

    ok('a first run with nothing on disk is allowed', S.mayReplace(1, 0, {}).ok === true);
    ok('and says so', /nothing usable on disk/.test(S.mayReplace(1, 0, {}).reason));

    const forced = S.mayReplace(1, 16, { force: true });
    ok('force overrides a shrink', forced.ok === true, JSON.stringify(forced));
    ok('but the reason records that it was forced', /force/.test(forced.reason), forced.reason);

    ok('missing opts is the same as no force', S.mayReplace(1, 16).ok === false);
}

console.log('\nREAD-EXISTING  (what we compare against)');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'league-scrape-'));
    const f   = path.join(dir, 'league_data.json');

    ok('a missing file reads as null', S.readExisting(f) === null);

    fs.writeFileSync(f, 'not json at all');
    ok('a corrupt file reads as null rather than throwing', S.readExisting(f) === null);

    fs.writeFileSync(f, JSON.stringify({ seasons: [] }));
    ok('an empty seasons array reads as null', S.readExisting(f) === null);

    fs.writeFileSync(f, JSON.stringify({ notSeasons: 1 }));
    ok('a wrong-shaped file reads as null', S.readExisting(f) === null);

    fs.writeFileSync(f, JSON.stringify({ seasons: [{ season: 2026 }, { season: 2025 }] }));
    const got = S.readExisting(f);
    ok('a good file reads back', got && got.seasons.length === 2, JSON.stringify(got));

    // An unreadable existing file must not block a scrape — it just means we have
    // no count to compare against, so the fresh data is allowed through.
    fs.writeFileSync(f, 'corrupt');
    const count = S.readExisting(f) ? S.readExisting(f).seasons.length : 0;
    ok('a corrupt file does not block a fresh scrape', S.mayReplace(16, count, {}).ok === true);

    fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nWRITE-ATOMIC  (no half-written file for a reader to see)');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'league-scrape-'));
    const f   = path.join(dir, 'league_data.json');

    S.writeAtomic(f, 'first');
    ok('it writes', fs.readFileSync(f, 'utf8') === 'first');

    S.writeAtomic(f, 'second');
    ok('it replaces', fs.readFileSync(f, 'utf8') === 'second');

    ok('no .tmp file is left behind', !fs.existsSync(f + '.tmp'));

    // The Refresh chat saw "1 season" and guessed a mid-write read. With a rename
    // that is impossible, so the one-season file it saw was a real write — which is
    // what the guard above now prevents.
    S.writeAtomic(f, JSON.stringify({ seasons: new Array(16).fill({}) }));
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok('a reader always gets valid JSON', parsed.seasons.length === 16);

    fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nEXPORTS');
{
    ok('runScrape is exported', typeof S.runScrape === 'function');
    // Not `.length` — both parameters have defaults, and default parameters do not
    // count toward it, so `.length` is 0 for a correct signature.
    ok('runScrape takes an options argument',
        /^async function runScrape\s*\(\s*log\s*=[^,]*,\s*opts\s*=/.test(S.runScrape.toString()),
        S.runScrape.toString().slice(0, 70));
    ok('OUT_FILE points at league_data.json', /league_data\.json$/.test(S.OUT_FILE), S.OUT_FILE);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
