/**
 * Tests for the server-side refresh schedule.
 *
 * Background: the refresh was a Claude scheduled task on a Windows desktop set for
 * 6:00 AM. Desktop tasks only fire while the machine is awake, so it actually ran
 * at 8:51 one Tuesday and 9:51 the next — both times AFTER the 9:00 blurb task,
 * which read week-old data and correctly declined to write. Moving it server-side
 * removes the dependency on the machine; these tests pin the schedule.
 *
 * `refreshDue` takes the clock as an argument precisely so Tuesdays, midnights and
 * DST changeovers can be tested on a Wednesday in November.
 */

const A = require('../autorefresh.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const TZ = 'America/New_York';
const OPTS = { tz: TZ, anchorDay: 2, anchorHour: 9, maxAgeHours: 24 };
const H = 3_600_000;

/** An instant from a New York wall-clock time, written the obvious way. */
function et(iso) { return new Date(iso).getTime(); }

console.log('\nTZ PARTS  (the wall clock in New York)');
{
    // 2026-11-10T14:57Z is 09:57 EST on Tuesday 10 November.
    const p = A.tzParts(new Date('2026-11-10T14:57:00Z'), TZ);
    ok('weekday is Tuesday', p.weekday === 2, String(p.weekday));
    ok('hour is local, not UTC', p.hour === 9, String(p.hour));
    ok('date is local', p.ymd === '2026-11-10', p.ymd);

    // 05:30 UTC on the 11th is still 00:30 on the 10th in New York. ICU renders
    // midnight as "24" in some builds; if that leaked through, every anchor
    // comparison at midnight would misfire.
    const mid = A.tzParts(new Date('2026-11-11T05:30:00Z'), TZ);
    ok('midnight reads as hour 0, never 24', mid.hour === 0, String(mid.hour));
    ok('and belongs to the previous local day', mid.ymd === '2026-11-11' || mid.ymd === '2026-11-10', mid.ymd);
}

console.log('\nTHE WEEKLY ANCHOR  (Tuesday, 9am New York)');
{
    const tue0957 = et('2026-11-10T14:57:00Z');   // Tue 09:57 EST
    const tue0830 = et('2026-11-10T13:30:00Z');   // Tue 08:30 EST
    const mon2300 = et('2026-11-10T04:00:00Z');   // Mon 23:00 EST

    // Refreshed late Monday night, so only ~11h old: the max-age net does not
    // fire, and the anchor has to be what triggers it.
    let r = A.refreshDue(tue0957, mon2300, OPTS);
    ok('Tuesday after 9am with Monday-night data is due', r.due === true, JSON.stringify(r));
    ok('and it says the anchor did it', /weekly anchor/.test(r.reason), r.reason);

    r = A.refreshDue(tue0830, mon2300, OPTS);
    ok('Tuesday BEFORE 9am is not due', r.due === false, JSON.stringify(r));

    // Already refreshed at 09:05 today — the 09:57 tick must not scrape again.
    const tue0905 = et('2026-11-10T14:05:00Z');
    r = A.refreshDue(tue0957, tue0905, OPTS);
    ok('it does not run twice in one Tuesday morning', r.due === false, JSON.stringify(r));

    // Refreshed at 02:00 Tuesday, before the anchor: the anchor still owes a run.
    const tue0200 = et('2026-11-10T07:00:00Z');
    r = A.refreshDue(tue0957, tue0200, OPTS);
    ok('a pre-anchor run on the same day does not satisfy the anchor', r.due === true, JSON.stringify(r));

    // Wednesday, fresh data — nothing to do.
    const wed1000 = et('2026-11-11T15:00:00Z');
    const wed0200 = et('2026-11-11T07:00:00Z');
    r = A.refreshDue(wed1000, wed0200, OPTS);
    ok('Wednesday with fresh data is not due', r.due === false, JSON.stringify(r));
}

console.log('\nTHE MAX-AGE SAFETY NET');
{
    const wed1000 = et('2026-11-11T15:00:00Z');
    let r = A.refreshDue(wed1000, wed1000 - 30 * H, OPTS);
    ok('30-hour-old data is due even on a Wednesday', r.due === true, JSON.stringify(r));
    ok('and the reason names the age', /30\.0h old/.test(r.reason), r.reason);

    r = A.refreshDue(wed1000, wed1000 - 20 * H, OPTS);
    ok('20-hour-old data is not', r.due === false, JSON.stringify(r));

    // A missed Tuesday (server down) must self-correct rather than wait a week.
    const thu = et('2026-11-12T15:00:00Z');
    r = A.refreshDue(thu, et('2026-11-09T15:00:00Z'), OPTS);
    ok('a missed Tuesday is caught by Thursday', r.due === true, JSON.stringify(r));
}

console.log('\nBAD INPUT  (must fail toward refreshing, never toward silence)');
{
    const now = et('2026-11-11T15:00:00Z');
    ok('no data file is due', A.refreshDue(now, null, OPTS).due === true);
    ok('undefined is due', A.refreshDue(now, undefined, OPTS).due === true);
    ok('NaN is due, not "fine"', A.refreshDue(now, NaN, OPTS).due === true);
    ok('a garbage timestamp is due', A.refreshDue(now, 'nonsense', OPTS).due === true);

    // Clock skew: a timestamp in the future would otherwise read as negative age
    // and suppress every refresh indefinitely.
    const r = A.refreshDue(now, now + 48 * H, OPTS);
    ok('a future timestamp is due rather than suppressing forever', r.due === true, JSON.stringify(r));
    ok('and says it is skew', /clock skew/.test(r.reason), r.reason);
}

console.log('\nDST  (the clocks move; the anchor should not)');
{
    // US DST ends Sunday 1 Nov 2026. The Tuesday either side must behave the same.
    const tueBefore = et('2026-10-27T13:57:00Z');   // Tue 09:57 EDT (UTC-4)
    const tueAfter  = et('2026-11-10T14:57:00Z');   // Tue 09:57 EST (UTC-5)

    ok('09:57 EDT is hour 9', A.tzParts(new Date(tueBefore), TZ).hour === 9,
        String(A.tzParts(new Date(tueBefore), TZ).hour));
    ok('09:57 EST is also hour 9', A.tzParts(new Date(tueAfter), TZ).hour === 9,
        String(A.tzParts(new Date(tueAfter), TZ).hour));

    ok('the anchor fires the Tuesday before the change',
        A.refreshDue(tueBefore, tueBefore - 11 * H, OPTS).due === true);
    ok('and the Tuesday after',
        A.refreshDue(tueAfter, tueAfter - 11 * H, OPTS).due === true);

    // Spring forward, 8 March 2026: 02:00 does not exist locally that day.
    const springTue = et('2026-03-10T13:57:00Z');   // Tue 09:57 EDT
    ok('the Tuesday after spring-forward still anchors at 9',
        A.refreshDue(springTue, springTue - 11 * H, OPTS).due === true);
}

console.log('\nTHE SCENARIO THAT BROKE  (replayed)');
{
    // 10 Nov 2026: last refresh Tue 3 Nov 09:51, blurb task runs 09:30 Tue 10 Nov.
    // Under the old desktop schedule the refresh had not yet happened at 09:30.
    // Server-side, the 09:00 anchor means the data is already fresh by then.
    const lastWeek  = et('2026-11-03T14:51:00Z');
    const tue0901   = et('2026-11-10T14:01:00Z');   // 09:01 EST, first tick past 9
    const r = A.refreshDue(tue0901, lastWeek, OPTS);
    ok('at 09:01 the refresh is due', r.due === true, JSON.stringify(r));

    // Having run at 09:02, the 09:30 blurb task finds data 28 minutes old.
    const ranAt = et('2026-11-10T14:02:00Z');
    const blurbTime = et('2026-11-10T14:30:00Z');
    const ageMin = (blurbTime - ranAt) / 60000;
    ok('the blurb task at 09:30 sees data ~28 minutes old', Math.round(ageMin) === 28, String(ageMin));
    ok('and no second refresh races it',
        A.refreshDue(blurbTime, ranAt, OPTS).due === false);
}

console.log('\nCONFIG DEFAULTS');
{
    ok('anchors on Tuesday by default', A.ANCHOR_DAY === 2, String(A.ANCHOR_DAY));
    ok('at 9am by default', A.ANCHOR_HOUR === 9, String(A.ANCHOR_HOUR));
    ok('Eastern by default', A.TZ === 'America/New_York', A.TZ);
    ok('with a 24h safety net', A.MAX_AGE_H === 24, String(A.MAX_AGE_H));
    ok('startAutoRefresh is exported', typeof A.startAutoRefresh === 'function');
}

console.log('\nTHE LOOP  (injected deps, no network)');
{
    (async () => {
        let scrapes = 0;
        const rf = A.startAutoRefresh({
            log: () => {},
            dataAgeMs: () => null,              // always "no data" => always due
            scrape: async () => { scrapes++; await new Promise(r => setTimeout(r, 20)); },
            checkEveryMs: 1e9, startDelayMs: 1e9,   // never fire on its own
        });

        await rf.tick();
        ok('a due tick scrapes', scrapes === 1, String(scrapes));
        ok('and records success', !!rf.state.lastOkAt);

        // Overlap guard: a second tick while one is in flight must not double-run.
        const inflight = rf.tick();
        await rf.tick();
        await inflight;
        ok('overlapping ticks do not double-scrape', scrapes === 2, String(scrapes));

        const bad = A.startAutoRefresh({
            log: () => {},
            dataAgeMs: () => null,
            scrape: async () => { throw new Error('ESPN said no'); },
            checkEveryMs: 1e9, startDelayMs: 1e9,
        });
        await bad.tick();
        ok('a failing scrape does not throw out of the loop', bad.state.lastError === 'ESPN said no', String(bad.state.lastError));
        ok('and the loop is left unlocked for the next try', bad.state.running === false);

        // Backoff: with stale data the "due" condition stays true, so without this
        // a broken ESPN would mean a doomed scrape every single tick.
        let attempts = 0;
        const flaky = A.startAutoRefresh({
            log: () => {},
            dataAgeMs: () => null,
            scrape: async () => { attempts++; throw new Error('still down'); },
            checkEveryMs: 1e9, startDelayMs: 1e9,
            retryAfterMs: 60_000,
        });
        await flaky.tick();
        await flaky.tick();
        await flaky.tick();
        ok('a failure backs off instead of retrying every tick', attempts === 1, String(attempts));
        ok('and says how long until the retry', /backing off/.test(flaky.state.lastReason), flaky.state.lastReason);

        // With no backoff window, it retries freely — proving the guard is what
        // suppressed the attempts above rather than something else being broken.
        let free = 0;
        const nobackoff = A.startAutoRefresh({
            log: () => {},
            dataAgeMs: () => null,
            scrape: async () => { free++; throw new Error('down'); },
            checkEveryMs: 1e9, startDelayMs: 1e9,
            retryAfterMs: 0,
        });
        await nobackoff.tick();
        await nobackoff.tick();
        ok('with the window at zero it retries each tick', free === 2, String(free));

        // Recovery clears the backoff, so a fixed cookie takes effect on the next tick.
        let phase = 'bad', recovered = 0;
        const heals = A.startAutoRefresh({
            log: () => {},
            dataAgeMs: () => null,
            scrape: async () => { if (phase === 'bad') throw new Error('down'); recovered++; },
            checkEveryMs: 1e9, startDelayMs: 1e9,
            retryAfterMs: 0,
        });
        await heals.tick();
        phase = 'good';
        await heals.tick();
        ok('recovery clears the error', heals.state.lastError === null, String(heals.state.lastError));
        ok('and the scrape succeeds again', recovered === 1, String(recovered));

        rf.stop(); bad.stop(); flaky.stop(); nobackoff.stop(); heals.stop();

        console.log(`\n${passes} passed, ${fails} failed\n`);
        process.exit(fails ? 1 : 0);
    })();
}
