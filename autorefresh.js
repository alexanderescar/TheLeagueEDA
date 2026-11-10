/**
 * autorefresh.js — the data refresh, moved off Alex's desktop and onto the server.
 *
 * Why this exists. The weekly refresh used to be a Claude scheduled task running on
 * a Windows machine at 6:00 AM. Scheduled tasks on a desktop only fire while the
 * desktop is awake, so in practice the refresh ran whenever the computer was turned
 * on — 8:51 one week, 9:51 the next. The blurb task runs at 9:00, so twice running
 * it woke up, found data from the previous week, correctly refused to write
 * commentary about it, and the site sat on stale power rankings until someone
 * noticed.
 *
 * The refresh never needed a desktop. It is an HTTP-shaped job against ESPN, and
 * the server is already up twenty-four hours a day. So it lives here now, and the
 * only thing left on the desktop is the part that genuinely needs Claude: writing.
 *
 * Two triggers, deliberately:
 *
 *   1. A weekly anchor — Tuesday morning, after the hour the blurb writer needs it
 *      by. This is the one that matters.
 *   2. A max-age safety net, so a missed anchor (a deploy, an ESPN outage, a server
 *      restart at the wrong moment) self-corrects within the day instead of waiting
 *      a week for the next Tuesday.
 *
 * `refreshDue` is pure and takes the clock as an argument, so the schedule can be
 * tested across DST boundaries, midnights and missed weeks without waiting for
 * Tuesday to come around.
 */

const TZ          = process.env.REFRESH_TZ   || 'America/New_York';
const ANCHOR_DAY  = Number(process.env.REFRESH_DAY  ?? 2);   // 0 = Sunday, 2 = Tuesday
const ANCHOR_HOUR = Number(process.env.REFRESH_HOUR ?? 9);   // local to TZ
const MAX_AGE_H   = Number(process.env.REFRESH_MAX_AGE_HOURS ?? 24);
const CHECK_EVERY_MS = Number(process.env.REFRESH_CHECK_MS ?? 15 * 60 * 1000);
// After a failure, wait this long before trying ESPN again. Without it, stale data
// plus expired cookies means a doomed scrape every fifteen minutes, indefinitely —
// ~96 pointless runs a day. An hour still recovers promptly once cookies are fixed.
const RETRY_AFTER_MS = Number(process.env.REFRESH_RETRY_MS ?? 60 * 60 * 1000);

/**
 * Wall-clock parts of `date` in `tz`.
 *
 * Everything downstream compares local parts rather than constructing instants,
 * which keeps the DST transitions from mattering: on the day the clocks move there
 * is no arithmetic to get wrong, only "what does the wall clock in New York say".
 */
function tzParts(date, tz = TZ) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const p = {};
    for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        weekday: WD[p.weekday],
        // hour12:false renders midnight as "24" in some ICU builds. Normalise, or
        // every midnight check silently compares 24 against the anchor hour.
        hour: Number(p.hour) % 24,
        minute: Number(p.minute),
        ymd: `${p.year}-${p.month}-${p.day}`,
    };
}

/**
 * Should a refresh run right now?
 *
 * @param {Date|number} now           current time
 * @param {number|null} lastRefreshMs epoch ms of the last successful refresh, or
 *                                    null when there is no data file at all
 * @param {object}      opts          { tz, anchorDay, anchorHour, maxAgeHours }
 * @returns {{due: boolean, reason: string}}
 */
function refreshDue(now, lastRefreshMs, opts = {}) {
    const tz         = opts.tz         || TZ;
    const anchorDay  = opts.anchorDay  ?? ANCHOR_DAY;
    const anchorHour = opts.anchorHour ?? ANCHOR_HOUR;
    const maxAgeH    = opts.maxAgeHours ?? MAX_AGE_H;

    const nowMs = now instanceof Date ? now.getTime() : Number(now);

    // No data at all, or an unreadable timestamp. NaN must mean "refresh", never
    // "fine" — the same trap /api/status had to be fixed for.
    if (lastRefreshMs == null || !Number.isFinite(Number(lastRefreshMs))) {
        return { due: true, reason: 'no previous refresh on record' };
    }

    const ageH = (nowMs - Number(lastRefreshMs)) / 3_600_000;

    // A clock that has gone backwards (restored backup, container clock skew)
    // should not read as "refreshed in the future" and suppress refreshes forever.
    if (ageH < 0) return { due: true, reason: 'last refresh is in the future — clock skew' };

    if (ageH > maxAgeH) {
        return { due: true, reason: `data is ${ageH.toFixed(1)}h old (limit ${maxAgeH}h)` };
    }

    const n = tzParts(new Date(nowMs), tz);
    const l = tzParts(new Date(Number(lastRefreshMs)), tz);

    const atAnchor    = n.weekday === anchorDay && n.hour >= anchorHour;
    const alreadyDone = l.ymd === n.ymd && l.hour >= anchorHour;

    if (atAnchor && !alreadyDone) {
        return { due: true, reason: `weekly anchor (${n.ymd} ${String(anchorHour).padStart(2, '0')}:00 ${tz})` };
    }

    return { due: false, reason: `not due — ${ageH.toFixed(1)}h old` };
}

/**
 * Start the background loop.
 *
 * `deps` is injected so the loop can be exercised without touching ESPN:
 *   dataAgeMs()  -> epoch ms of the current data file, or null
 *   scrape()     -> Promise, the full refresh (scrape + derived data)
 */
function startAutoRefresh(deps) {
    const log       = deps.log || console.log;
    const dataAgeMs = deps.dataAgeMs;
    const scrape    = deps.scrape;
    const everyMs   = deps.checkEveryMs ?? CHECK_EVERY_MS;

    // One at a time. A scrape takes minutes; without this a slow run would overlap
    // the next tick and two writers would race for league_data.json.
    let running = false;
    let lastFailAt = 0;
    const retryAfter = deps.retryAfterMs ?? RETRY_AFTER_MS;
    const state = { running: false, lastAttemptAt: null, lastOkAt: null, lastError: null, lastReason: null };

    async function tick() {
        if (running) return;
        const verdict = refreshDue(Date.now(), dataAgeMs(), deps);
        state.lastReason = verdict.reason;
        if (!verdict.due) return;

        // Back off after a failure rather than hammering ESPN every tick while the
        // data sits stale — the "due" condition stays true the whole time it is broken.
        const sinceFail = Date.now() - lastFailAt;
        if (lastFailAt && sinceFail < retryAfter) {
            state.lastReason = `due (${verdict.reason}) but backing off — `
                + `${Math.round((retryAfter - sinceFail) / 60000)} min until retry`;
            return;
        }

        running = true; state.running = true;
        state.lastAttemptAt = new Date().toISOString();
        log(`[AutoRefresh] starting — ${verdict.reason}`);
        try {
            await scrape();
            state.lastOkAt = new Date().toISOString();
            state.lastError = null;
            lastFailAt = 0;              // recovered — drop the backoff
            log('[AutoRefresh] done');
        } catch (err) {
            // Never throw out of the loop: a failed refresh must not take the
            // server down, and the next tick will try again.
            state.lastError = err.message;
            lastFailAt = Date.now();
            log(`[AutoRefresh] failed: ${err.message}`);
        } finally {
            running = false; state.running = false;
        }
    }

    const timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();   // don't hold the process open in tests
    setTimeout(tick, deps.startDelayMs ?? 60_000);   // let boot settle first

    return { tick, state, stop: () => clearInterval(timer), config: { tz: TZ, anchorDay: ANCHOR_DAY, anchorHour: ANCHOR_HOUR, maxAgeHours: MAX_AGE_H } };
}

module.exports = { refreshDue, tzParts, startAutoRefresh, TZ, ANCHOR_DAY, ANCHOR_HOUR, MAX_AGE_H };
