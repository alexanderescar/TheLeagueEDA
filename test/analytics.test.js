const A = require('../analytics.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const store = () => A.emptyStore();
const at = (iso) => new Date(iso).getTime();

console.log('\nLEAGUE TIME, NOT UTC  (Monday Night Football has to land on Monday)');
{
    // 02:00 UTC Friday is 22:00 Thursday in Florida. Counting in UTC would file
    // every MNF and late-window game under the following day.
    ok('late-night game files under the day it was played',
        A.dayKey(at('2026-09-18T02:00:00Z')) === '2026-09-17',
        A.dayKey(at('2026-09-18T02:00:00Z')));
    ok('and keeps the local hour', A.hourKey(at('2026-09-18T02:00:00Z')) === 22,
        String(A.hourKey(at('2026-09-18T02:00:00Z'))));
    ok('midday is unambiguous', A.dayKey(at('2026-09-17T16:00:00Z')) === '2026-09-17');
    ok('midnight local rolls the day', A.dayKey(at('2026-09-17T04:30:00Z')) === '2026-09-17');
    ok('bad timestamps return null', A.dayKey('not a date') === null);
    ok('day keys sort as strings', ['2026-10-01','2026-09-30'].sort()[0] === '2026-09-30');
}

console.log('\nRECORDING');
{
    const s = store();
    ok('a clean beacon is accepted', A.recordEvent(s, { vid: 'abc123', tab: 'standings', at: at('2026-09-17T16:00:00Z') }).ok);
    ok('the day row exists', !!s.days['2026-09-17']);
    ok('views counted', s.days['2026-09-17'].views === 1);
    ok('tab counted', s.days['2026-09-17'].tabs.standings === 1);
    ok('device recorded', s.devices.abc123 && s.devices.abc123.views === 1);
    ok('firstSeen set', s.firstSeen === '2026-09-17');
    ok('name seam is present but empty', s.devices.abc123.name === null);
}

console.log('\nBAD INPUT IS DROPPED, NOT THROWN  (this is a public endpoint)');
{
    const s = store();
    ok('no vid', !A.recordEvent(s, { tab: 'standings' }).ok);
    ok('empty vid', !A.recordEvent(s, { vid: '', tab: 'standings' }).ok);
    ok('oversized vid', !A.recordEvent(s, { vid: 'x'.repeat(200), tab: 'standings' }).ok);
    ok('vid with punctuation', !A.recordEvent(s, { vid: 'a b;drop', tab: 'standings' }).ok);
    ok('unknown tab cannot create a key',
        !A.recordEvent(s, { vid: 'abc', tab: '__proto__' }).ok);
    ok('made-up tab rejected', !A.recordEvent(s, { vid: 'abc', tab: 'nonsense' }).ok);
    ok('null event', !A.recordEvent(s, null).ok);
    ok('nothing was written', Object.keys(s.days).length === 0 && Object.keys(s.devices).length === 0);
    ok('missing tab defaults to load',
        A.recordEvent(s, { vid: 'abc', at: at('2026-09-17T16:00:00Z') }).tab === 'load');
}

console.log('\nPROTOTYPE POLLUTION  (a public endpoint gets probed for exactly this)');
{
    // "__proto__" satisfies [A-Za-z0-9_-]+, so the character check alone lets it
    // through. store.devices['__proto__'] then returns Object.prototype rather than
    // creating a property, and dev.views++ writes onto Object.prototype — giving
    // every object in the process a stray field while the visit goes uncounted.
    const s = store();
    const t = at('2026-09-17T16:00:00Z');
    A.UNSAFE_KEYS.forEach(k => {
        ok('rejects vid ' + k, !A.recordEvent(s, { vid: k, tab: 'standings', at: t }).ok);
    });
    ok('Object.prototype is untouched', !('views' in {}), 'Object.prototype.views = ' + ({}).views);
    ok('no phantom device was created', Object.keys(s.devices).length === 0);
    ok('no day row was created', Object.keys(s.days).length === 0);

    // And the guard holds after a JSON round trip, which is how the store comes
    // back from disk with ordinary prototypes restored.
    const revived = JSON.parse(JSON.stringify(A.emptyStore()));
    ok('guard survives a reload from disk',
        !A.recordEvent(revived, { vid: '__proto__', tab: 'standings', at: t }).ok);
    ok('still clean afterwards', !('views' in {}));

    // Ordinary ids that merely contain underscores must still work.
    ok('a normal underscored id is fine',
        A.recordEvent(s, { vid: 'phone_1-abc', tab: 'standings', at: t }).ok);
}

console.log('\nDISTINCT DEVICES  (the number that answers "is anyone looking")');
{
    const s = store();
    const t = at('2026-09-17T16:00:00Z');
    // One person clicking around a lot is still one person.
    ['standings','week','rules','week','standings'].forEach(tab =>
        A.recordEvent(s, { vid: 'phone1', tab, at: t }));
    A.recordEvent(s, { vid: 'laptop2', tab: 'standings', at: t });

    ok('views count every click', s.days['2026-09-17'].views === 6);
    ok('devices count people, not clicks', s.days['2026-09-17'].devices.length === 2);
    ok('a device is not double-listed', s.days['2026-09-17'].devices.filter(v => v === 'phone1').length === 1);

    const sum = A.summarize(s, { days: 30, today: '2026-09-17' });
    ok('summary agrees on devices', sum.distinctDevicesWindow === 2, String(sum.distinctDevicesWindow));
    ok('summary agrees on views', sum.totalViews === 6);
    ok('top tab identified', sum.tabs[0].tab === 'standings' && sum.tabs[0].views === 3,
        JSON.stringify(sum.tabs[0]));
}

console.log('\nTAB TALLIES ACROSS DAYS');
{
    const s = store();
    A.recordEvent(s, { vid: 'a', tab: 'draftrecap', at: at('2026-09-15T16:00:00Z') });
    A.recordEvent(s, { vid: 'b', tab: 'draftrecap', at: at('2026-09-16T16:00:00Z') });
    A.recordEvent(s, { vid: 'c', tab: 'rules',      at: at('2026-09-17T16:00:00Z') });

    const sum = A.summarize(s, { days: 30, today: '2026-09-17' });
    ok('three days on file', sum.daysOnFile === 3);
    ok('rows are newest first', sum.rows[0].day === '2026-09-17', sum.rows[0].day);
    ok('draftrecap summed across days', sum.tabs.find(t => t.tab === 'draftrecap').views === 2);
    ok('lifetime devices counted', sum.distinctDevicesLifetime === 3);

    const narrow = A.summarize(s, { days: 1, today: '2026-09-17' });
    ok('a 1-day window only sees the last day', narrow.distinctDevicesWindow === 1);
    ok('and only that day\'s tabs', narrow.tabs.length === 1 && narrow.tabs[0].tab === 'rules');
    ok('but totalViews stays lifetime', narrow.totalViews === 3);
}

console.log('\nRATE LIMIT  (one runaway client must not bury everyone else)');
{
    const s = store();
    const t = at('2026-09-17T16:00:00Z');
    let accepted = 0;
    for (let i = 0; i < A.MAX_EVENTS_PER_DAY + 50; i++) {
        if (A.recordEvent(s, { vid: 'spam', tab: 'standings', at: t }).ok) accepted++;
    }
    ok('capped at the daily limit', accepted === A.MAX_EVENTS_PER_DAY, String(accepted));
    ok('the cap is per device, not global',
        A.recordEvent(s, { vid: 'someoneelse', tab: 'standings', at: t }).ok);
    ok('a new day resets the cap',
        A.recordEvent(s, { vid: 'spam', tab: 'standings', at: at('2026-09-18T16:00:00Z') }).ok);
}

console.log('\nPRUNING  (the file cannot grow forever)');
{
    const s = store();
    // Write more days than the cap, one event each.
    for (let i = 0; i < A.MAX_DAYS + 25; i++) {
        const d = new Date(Date.UTC(2024, 0, 1 + i, 16, 0, 0));
        A.recordEvent(s, { vid: 'a', tab: 'standings', at: d.getTime() });
    }
    ok('day rows are capped', Object.keys(s.days).length === A.MAX_DAYS,
        String(Object.keys(s.days).length));
    ok('the oldest days are the ones dropped',
        Object.keys(s.days).sort()[0] > '2024-01-01');
    ok('per-device daily counters do not accumulate',
        Object.keys(s.devices.a.perDay).length <= 2,
        String(Object.keys(s.devices.a.perDay).length));
}

console.log('\nEMPTY AND MALFORMED STORES');
{
    const sum = A.summarize(A.emptyStore(), { days: 30, today: '2026-09-17' });
    ok('empty store summarizes without throwing', sum.totalViews === 0 && sum.rows.length === 0);
    ok('no devices', sum.distinctDevicesLifetime === 0 && sum.activeLast7 === 0);
    ok('firstSeen is null', sum.firstSeen === null);
    ok('garbage store falls back to empty', A.summarize(null, {}).totalViews === 0);
    ok('undefined opts is fine', A.summarize(A.emptyStore()).windowDays === 30);
}

console.log('\nPERSISTENCE HONESTY  (a counter that silently resets is worse than none)');
{
    const p = A.persistence();
    ok('reports which directory it uses', typeof p.dataDir === 'string' && p.dataDir.length > 0);
    ok('durable exactly when DATA_DIR is set', p.durable === !!process.env.DATA_DIR);
    ok('the note explains the consequence', /redeploy/i.test(p.note), p.note);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
