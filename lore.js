/**
 * lore.js — the things a beat writer would already know.
 *
 * The weekly commentary has always had the numbers. What it never had was the
 * context twelve people who have played together since 2010 carry in their heads:
 * who has never won, who owes a Sacko presentation at the next draft, which rules
 * are named after whom and why, and what the money actually is.
 *
 * Commissioner's Desk asks new users to type their lore into a box at signup. This
 * league already wrote it down — a ratified constitution and 107 recorded votes —
 * so this reads it rather than asking for it.
 *
 * Everything here is derived from data already on disk. Nothing is invented, and a
 * manager with no honours simply has an empty list rather than a generated one.
 */

const fs   = require('fs');
const path = require('path');

const PUB = path.join(__dirname, 'public');

/**
 * Rules this league named after people. The joke only lands if the writer knows
 * the story, so each carries a one-line summary rather than a section reference.
 *
 * Kept as a small hand-maintained list on purpose: parsing prose out of the
 * constitution to find "named rules" would be brittle, and there are three.
 */
const NAMED_RULES = [
    {
        name: 'The Brad Johnson Rule',
        section: '5.3',
        gist: 'If a player throws a pass to himself he collects the passing AND receiving '
            + 'points. Written after Brad Johnson did exactly that for 13.4 points.',
    },
    {
        name: 'The Robert Meachum Rule',
        section: '5.2',
        gist: 'An offensive player who recovers a fumble after a turnover and advances it '
            + 'gets the credit — but owners have to spot it themselves and tell the '
            + 'commissioner by Tuesday night.',
    },
    {
        name: 'The Peter Rule',
        section: '4.4',
        gist: 'A transaction freeze from the end of the season until the day after the draft '
            + 'order is set. Dormant since keepers were retired in 2026, not repealed — it '
            + 'returns automatically in any Keeper Season.',
    },
];

function readJson(file) {
    try {
        const f = path.join(PUB, file);
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { return null; }
}

/** Prize money and the Sacko, pulled from the constitution text. */
function readStakes() {
    const out = {
        champion: null, runnerUp: null, weeklyHigh: null,
        sacko: 'The owner who finishes last in the regular season is the Sacko, and must '
             + 'deliver a presentation at the following draft explaining why his team was '
             + 'the worst in the league.',
    };
    try {
        const f = path.join(PUB, 'constitution.md');
        if (!fs.existsSync(f)) return out;
        const md = fs.readFileSync(f, 'utf8');
        // [^$] means the match can never run past the next dollar figure, so a
        // generous gap is safe: it cannot accidentally pick up the following prize.
        // 80 because the weekly-high line reads "Weekly high scorer during the
        // regular season (through week 14) receives $25" — 52 characters of gap.
        const money = (label) => {
            const m = md.match(new RegExp(label + '[^$]{0,80}\\$([\\d,]+)', 'i'));
            return m ? Number(m[1].replace(/,/g, '')) : null;
        };
        out.champion   = money('League Champion receives');
        out.runnerUp   = money('League Runner-Up receives');
        out.weeklyHigh = money('Weekly high scorer');
    } catch { /* stakes are nice to have, not load-bearing */ }
    return out;
}

/**
 * Titles, runner-up finishes and Sacko finishes per manager, across every season.
 *
 * `rankCalculatedFinal === 1` is the actual playoff winner rather than the regular
 * season leader — the distinction that matters in a league where the top seed
 * regularly loses in the first round.
 */
function honours(seasons) {
    const acc = {};
    const touch = (key, nick) => {
        acc[key] = acc[key] || {
            // Always a string: an ESPN team can come back with no nickname and no
            // name at all, and an undefined here reaches the sort comparator and
            // takes the whole brief down with it.
            manager: nick || String(key),
            titles: [], runnerUps: [], sackos: [], seasonsPlayed: 0,
        };
        if (nick) acc[key].manager = nick;
        return acc[key];
    };

    (seasons || []).forEach(s => {
        const teams = s.teams || [];
        if (!teams.length) return;
        // Last place by final rank when ESPN gives one, else by regular-season record.
        let worst = null;
        teams.forEach(t => {
            const key = t.managerKey || ('t:' + t.id);
            const rec = touch(key, t.managerNick || t.name);
            rec.seasonsPlayed++;
            if (t.rankCalculatedFinal === 1) rec.titles.push(s.season);
            if (t.rankCalculatedFinal === 2) rec.runnerUps.push(s.season);
            const rank = t.rankCalculatedFinal || t.playoffSeed || null;
            if (rank != null && (!worst || rank > worst.rank)) worst = { key, rank };
        });
        if (worst) touch(worst.key).sackos.push(s.season);
    });

    return Object.keys(acc).map(k => {
        const r = acc[k];
        return {
            managerKey: k,
            manager: r.manager,
            seasonsPlayed: r.seasonsPlayed,
            titles: r.titles.sort((a, b) => a - b),
            titleCount: r.titles.length,
            runnerUps: r.runnerUps.sort((a, b) => a - b),
            sackos: r.sackos.sort((a, b) => a - b),
            neverWon: r.titles.length === 0,
            lastTitle: r.titles.length ? Math.max.apply(null, r.titles) : null,
        };
    }).sort((a, b) => b.titleCount - a.titleCount
        || String(a.manager).localeCompare(String(b.manager)));
}

/**
 * Votes worth knowing about — the ones that changed something, plus anything the
 * archive flagged as unresolved. Deliberately short: this rides along on every
 * brief, and a writer who needs the full record can ask the rules bot.
 */
function notableVotes(store, limit) {
    if (!store || !Array.isArray(store.votes)) return [];
    return store.votes
        .filter(v => v.category !== 'trade' && (v.result === 'passed' || v.result === 'disputed'))
        .slice(0, limit || 12)
        .map(v => ({
            date: v.date,
            title: v.title,
            tally: v.tally,
            result: v.result,
            outcome: v.outcome || null,
        }));
}

/**
 * Build the lore packet.
 *
 * `currentStandings` is [{ managerKey, manager, wins, losses }] for the season in
 * progress, used to name who is currently on the hook for the Sacko presentation.
 */
function buildLore(seasons, currentStandings) {
    const hist = honours(seasons);
    const byKey = {};
    hist.forEach(h => { byKey[h.managerKey] = h; });

    let sackoRace = null;
    if (Array.isArray(currentStandings) && currentStandings.length) {
        const sorted = currentStandings.slice().sort((a, b) =>
            (a.wins - b.wins) || ((a.pointsFor || 0) - (b.pointsFor || 0)));
        const last = sorted[0];
        if (last) {
            const h = byKey[last.managerKey];
            sackoRace = {
                manager: last.manager,
                record: last.wins + '-' + last.losses,
                previousSackos: h ? h.sackos : [],
            };
        }
    }

    const droughts = hist.filter(h => h.neverWon && h.seasonsPlayed >= 3)
        .map(h => ({ manager: h.manager, seasons: h.seasonsPlayed }));

    return {
        stakes: readStakes(),
        namedRules: NAMED_RULES,
        honours: hist.map(h => ({
            manager: h.manager,
            titles: h.titles,
            titleCount: h.titleCount,
            runnerUps: h.runnerUps,
            sackos: h.sackos,
            neverWon: h.neverWon,
            lastTitle: h.lastTitle,
            seasonsPlayed: h.seasonsPlayed,
        })),
        neverWon: droughts,
        sackoRace,
        notableVotes: notableVotes(readJson('votes.json')),
        note: 'Lore is drawn from the ratified constitution and the league vote archive. '
            + 'Use it where it bears on the week — a first title, a long drought, a rule '
            + 'that is about to matter. Do not recite it.',
    };
}

module.exports = { buildLore, honours, readStakes, notableVotes, NAMED_RULES };
