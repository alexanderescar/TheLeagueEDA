/**
 * analytics.js — did anyone actually look at the thing?
 *
 * The site is a single-page app: every tab lives at the same URL, so a stock
 * analytics tag would report one pageview and tell you nothing about whether
 * anyone opened the Draft Recap. This counts sections instead of pages.
 *
 * What it stores, deliberately:
 *   - an opaque random id the browser generates and keeps in localStorage
 *   - which tab was opened, and when, rounded to the hour
 *
 * What it does not store: IP addresses, user agents, names, or anything that
 * identifies a person. With a twelve-person audience, "one desktop visitor in
 * Florida" is not anonymous, so the coarse stuff is left out on purpose.
 *
 * The device id is the seam for later. If the league ever wants a "who are you?"
 * picker, set `name` on the device record and the existing history gains names
 * retroactively for anyone who comes back. Until then it stays null.
 *
 * ── On persistence ───────────────────────────────────────────────────────────
 * Railway's filesystem is ephemeral: a redeploy wipes it. A counter that resets
 * to zero every deploy is worse than no counter, because it looks like nobody
 * came. Mount a volume and set DATA_DIR to its path and this survives. Without
 * one it still works, it just forgets on deploy — see /admin/stats, which says
 * which mode it is in rather than quietly implying the numbers are complete.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE     = path.join(DATA_DIR, 'analytics.json');

/** The league is in Florida; Railway runs UTC. Monday Night Football has to land
 *  on Monday or the day-by-day numbers read as nonsense. */
const TZ = process.env.LEAGUE_TZ || 'America/New_York';

/**
 * The eight top-level tabs, plus the nine History sub-tabs, plus 'load' for a
 * bare page open. Anything not on this list is dropped: an allowlist means a
 * stale cached page or someone poking the endpoint cannot invent keys in the store.
 * Mirrors switchTab() and histSubTab() in public/index.html — if a tab is added
 * there, add it here or its views will be silently discarded.
 */
const KNOWN_TABS = [
    'standings', 'week', 'draftrecap', 'rules',
    'history', 'champions', 'managers', 'draft',
    'hist-allplay', 'hist-alltime', 'hist-dna', 'hist-highs', 'hist-matchups',
    'hist-records', 'hist-rivalries', 'hist-season-table', 'hist-standings-all',
    'load',
];

const MAX_VID_LEN       = 40;
const MAX_EVENTS_PER_DAY = 400;   // per device; a real person cannot out-click this
const MAX_DAYS           = 800;   // ~2 seasons of daily rows before the oldest roll off

/**
 * Keys that must never be used to index into a plain object.
 *
 * `__proto__` passes a naive [A-Za-z0-9_-] check, and `store.devices['__proto__']`
 * does not create a property — it returns Object.prototype. The code then does
 * `dev.views++`, which writes `views` onto Object.prototype and hands every object
 * in the process a `views` field, while the visit itself goes uncounted. This is a
 * public endpoint, so the guard is explicit rather than relying on the map being
 * prototype-less: the store is JSON round-tripped on every restart, and JSON.parse
 * hands back objects with ordinary prototypes.
 */
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
function safeKey(k) { return UNSAFE_KEYS.indexOf(k) === -1; }

/** YYYY-MM-DD in league time. */
function dayKey(at, tz) {
    const d = at instanceof Date ? at : new Date(at || Date.now());
    if (isNaN(d.getTime())) return null;
    // en-CA formats as YYYY-MM-DD, which sorts correctly as a string.
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || TZ }).format(d);
}

/** Hour 0-23 in league time. */
function hourKey(at, tz) {
    const d = at instanceof Date ? at : new Date(at || Date.now());
    if (isNaN(d.getTime())) return null;
    const h = new Intl.DateTimeFormat('en-US', {
        timeZone: tz || TZ, hour: 'numeric', hour12: false,
    }).format(d);
    const n = Number(h);
    return isNaN(n) ? null : (n === 24 ? 0 : n);
}

function emptyStore() {
    return { version: 1, firstSeen: null, days: {}, devices: {} };
}

/**
 * Fold one beacon into the store. Returns { ok, reason }.
 *
 * Invalid input is dropped rather than thrown: this runs on a public endpoint,
 * and a malformed beacon should never be able to take the site down or poison
 * the counts.
 */
function recordEvent(store, ev) {
    if (!store || typeof store !== 'object') return { ok: false, reason: 'no store' };
    if (!ev || typeof ev !== 'object') return { ok: false, reason: 'no event' };

    const vid = String(ev.vid || '').trim();
    if (!vid || vid.length > MAX_VID_LEN || !/^[A-Za-z0-9_-]+$/.test(vid)) {
        return { ok: false, reason: 'bad vid' };
    }
    if (!safeKey(vid)) return { ok: false, reason: 'unsafe vid' };

    // An unknown tab name means either a stale cached page or someone poking the
    // endpoint. Either way, don't let it create arbitrary keys in the store.
    const tab = String(ev.tab || 'load');
    if (KNOWN_TABS.indexOf(tab) === -1) return { ok: false, reason: 'unknown tab' };

    const day = dayKey(ev.at);
    const hr  = hourKey(ev.at);
    if (!day) return { ok: false, reason: 'bad timestamp' };

    store.days    = store.days    || {};
    store.devices = store.devices || {};

    const d = store.days[day] = store.days[day] || { views: 0, devices: [], tabs: {}, hours: {} };
    const dev = store.devices[vid] = store.devices[vid] || {
        first: day, last: day, views: 0, name: null,
    };

    // Per-device daily cap. Counted against the device, not the day, so one
    // runaway client can't hide everyone else's traffic.
    const seenToday = (dev.perDay && dev.perDay[day]) || 0;
    if (seenToday >= MAX_EVENTS_PER_DAY) return { ok: false, reason: 'rate' };

    d.views++;
    d.tabs[tab] = (d.tabs[tab] || 0) + 1;
    if (hr != null) d.hours[hr] = (d.hours[hr] || 0) + 1;
    if (d.devices.indexOf(vid) === -1) d.devices.push(vid);

    dev.views++;
    dev.last = day > dev.last ? day : dev.last;
    dev.first = day < dev.first ? day : dev.first;
    dev.perDay = dev.perDay || {};
    dev.perDay[day] = seenToday + 1;

    if (!store.firstSeen || day < store.firstSeen) store.firstSeen = day;

    prune(store);
    return { ok: true, day, tab };
}

/** Keep the file from growing without bound. */
function prune(store) {
    const days = Object.keys(store.days).sort();
    if (days.length > MAX_DAYS) {
        days.slice(0, days.length - MAX_DAYS).forEach(k => { delete store.days[k]; });
    }
    // Per-device daily counters are only needed for today's rate limit.
    const keep = days.slice(-2);
    Object.keys(store.devices).forEach(vid => {
        const dev = store.devices[vid];
        if (!dev.perDay) return;
        Object.keys(dev.perDay).forEach(k => { if (keep.indexOf(k) === -1) delete dev.perDay[k]; });
    });
}

/**
 * Roll the store up for the dashboard.
 *
 * `days` is how far back to report. Percentages are deliberately absent: with a
 * twelve-person league, "33% of visitors" means four people, and the raw number
 * is both smaller and more honest.
 */
function summarize(store, opts) {
    const o = opts || {};
    const n = o.days || 30;
    const today = o.today || dayKey(Date.now());
    const s = store && store.days ? store : emptyStore();

    const allDays = Object.keys(s.days).sort();
    const window = allDays.slice(-n);

    const rows = window.map(day => {
        const d = s.days[day];
        return {
            day,
            views: d.views,
            devices: d.devices.length,
            tabs: d.tabs,
            topTab: Object.keys(d.tabs).sort((a, b) => d.tabs[b] - d.tabs[a])[0] || null,
        };
    });

    // Tab totals across the window.
    const tabTotals = {};
    window.forEach(day => {
        const t = s.days[day].tabs;
        Object.keys(t).forEach(k => { tabTotals[k] = (tabTotals[k] || 0) + t[k]; });
    });
    const tabs = Object.keys(tabTotals)
        .map(k => ({ tab: k, views: tabTotals[k] }))
        .sort((a, b) => b.views - a.views);

    // Distinct devices across the window, and lifetime.
    const seen = {};
    window.forEach(day => s.days[day].devices.forEach(v => { seen[v] = true; }));

    const devices = Object.keys(s.devices).map(vid => ({
        vid, name: s.devices[vid].name || null,
        first: s.devices[vid].first, last: s.devices[vid].last,
        views: s.devices[vid].views,
    })).sort((a, b) => (b.last > a.last ? 1 : b.last < a.last ? -1 : b.views - a.views));

    const activeLast7 = devices.filter(d => {
        const cutoff = window.slice(-7)[0];
        return cutoff ? d.last >= cutoff : false;
    }).length;

    return {
        firstSeen: s.firstSeen,
        today,
        windowDays: n,
        totalViews: allDays.reduce((a, k) => a + s.days[k].views, 0),
        distinctDevicesWindow: Object.keys(seen).length,
        distinctDevicesLifetime: devices.length,
        activeLast7,
        rows: rows.slice().reverse(),   // newest first for reading
        tabs,
        devices,
        daysOnFile: allDays.length,
    };
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Beacons arrive in bursts (one page load fires several), so writes are debounced
// rather than synchronous per event. Worst case a crash loses a few seconds of
// counts, which for this purpose is not worth a database.

let cache = null;
let dirty = false;
let timer = null;

function load() {
    if (cache) return cache;
    try {
        if (fs.existsSync(FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            cache = (parsed && parsed.days) ? parsed : emptyStore();
        } else {
            cache = emptyStore();
        }
    } catch (err) {
        console.warn('[Analytics] could not read store, starting fresh:', err.message);
        cache = emptyStore();
    }
    return cache;
}

function flush() {
    if (!dirty || !cache) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(cache));
        dirty = false;
    } catch (err) {
        console.warn('[Analytics] write failed:', err.message);
    }
}

function scheduleFlush() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, 5000);
    if (timer.unref) timer.unref();
}

/** Public: record a beacon and persist lazily. */
function track(ev) {
    const store = load();
    const res = recordEvent(store, ev);
    if (res.ok) scheduleFlush();
    return res;
}

/** Public: the dashboard payload. */
function stats(opts) {
    return summarize(load(), opts);
}

/** Whether the counts will survive the next redeploy. */
function persistence() {
    const usingVolume = !!process.env.DATA_DIR;
    return {
        dataDir: DATA_DIR,
        usingVolume,
        durable: usingVolume,
        note: usingVolume
            ? 'DATA_DIR is set, so these counts survive redeploys.'
            : 'No DATA_DIR set — this is Railway\'s ephemeral disk, so a redeploy resets these counts to zero.',
    };
}

process.on('SIGTERM', flush);
process.on('SIGINT', flush);

module.exports = {
    track, stats, persistence, flush,
    // exported for tests
    recordEvent, summarize, emptyStore, dayKey, hourKey, prune, safeKey,
    KNOWN_TABS, UNSAFE_KEYS, MAX_EVENTS_PER_DAY, MAX_DAYS, FILE, DATA_DIR,
};
