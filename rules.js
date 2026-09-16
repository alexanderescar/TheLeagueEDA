/**
 * rules.js — the constitution, the FAQ, and the rules bot behind them.
 *
 * The bot is deliberately not a general-purpose assistant. It is handed the full
 * constitution on every request and told to answer only from it, quoting the clause
 * it relied on. In a league argument, a paraphrase that is subtly wrong is worse than
 * no answer at all — so "the constitution doesn't cover that" is an acceptable, and
 * often correct, response.
 *
 * Files it reads (both optional; the section degrades gracefully without them):
 *   public/constitution.md    the document, in markdown
 *   public/faq.json           [{ category, question, answer }]
 */

const fs   = require('fs');
const path = require('path');

const PUB = path.join(__dirname, 'public');
const MODEL = process.env.RULES_MODEL || 'claude-sonnet-5';
const MAX_QUESTION = 500;

function readConstitution() {
    try {
        const f = path.join(PUB, 'constitution.md');
        if (!fs.existsSync(f)) return null;
        return fs.readFileSync(f, 'utf8');
    } catch { return null; }
}

function readFaq() {
    try {
        const f = path.join(PUB, 'faq.json');
        if (!fs.existsSync(f)) return null;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        return Array.isArray(j) ? j : (j.faq || null);
    } catch { return null; }
}

/**
 * A proposed next version, if one is sitting in the folder.
 *
 * Deliberately NOT fed to the bot. The bot answers from the ratified constitution;
 * quoting unratified text in a dispute would be worse than saying nothing. It is
 * shown in the app, clearly labelled, so the league can read and adopt it.
 */
function readDraft() {
    try {
        const f = path.join(PUB, 'constitution_v6_draft.md');
        if (!fs.existsSync(f)) return null;
        return fs.readFileSync(f, 'utf8');
    } catch { return null; }
}

function readVotes() {
    try {
        const f = path.join(PUB, 'votes.json');
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { return null; }
}

/**
 * Flatten the vote archive into one line per vote.
 *
 * The raw file is ~76KB, which would be sent on every single question. A digest of
 * one line per vote is about a fifth of that and is easier to search, because the
 * date, outcome and tally sit together on the same line instead of being spread
 * across a nested object.
 */
function voteDigest(store) {
    if (!store || !Array.isArray(store.votes)) return null;
    const lines = store.votes.map(v => {
        const opts = v.options.map(o => `${o.label} ${o.votes}`).join(' / ');
        const bits = [
            v.date,
            v.category.toUpperCase(),
            v.title,
            `[${v.result.toUpperCase()} ${v.tally}]`,
            opts,
        ];
        if (v.threshold) bits.push(`(required: ${v.threshold})`);
        if (v.question && v.question !== v.title) bits.push(`Q: ${v.question}`);
        if (v.detail) bits.push(v.detail);
        if (v.outcome) bits.push(`-> ${v.outcome}`);
        if (v.note) bits.push(`Note: ${v.note}`);
        if (v.discrepancy) bits.push(`UNRESOLVED: ${v.discrepancy}`);
        if (v.constitutionRef) bits.push(`(constitution ${v.constitutionRef})`);
        return bits.join(' | ');
    });

    const versions = (store.versions || []).map(x =>
        `${x.version} (${x.dated}, effective ${x.effectiveFrom}): ${(x.highlights || []).join('; ')}`
        + (x.gaps ? ` -- GAPS: ${x.gaps}` : '')
    );

    return [
        'CONSTITUTION VERSION HISTORY:',
        ...versions,
        '',
        'VOTE ARCHIVE (one line per vote, newest first):',
        ...lines,
        ...(store._openQuestions ? ['', 'UNRESOLVED IN THE ARCHIVE:', ...store._openQuestions.map(q => '- ' + q)] : []),
    ].join('\n');
}

function hasKey() { return !!(process.env.ANTHROPIC_API_KEY || '').trim(); }

function status() {
    const c = readConstitution();
    const f = readFaq();
    const v = readVotes();
    return {
        voteCount: v && v.votes ? v.votes.length : 0,
        hasConstitution: !!c,
        constitutionChars: c ? c.length : 0,
        faqCount: f ? f.length : 0,
        botAvailable: !!(c && hasKey()),
        reason: !c ? 'No constitution.md on file'
              : !hasKey() ? 'ANTHROPIC_API_KEY not set'
              : null,
    };
}

const SYSTEM = `You answer questions about a fantasy football league's constitution and its
voting history. The league is "The League", running since 2010.

Rules for your answers:
- Answer ONLY from the material provided below. It is the sole authority.
- For rules questions, quote the exact constitution clause, then explain it plainly.
- For questions about votes ("when did we vote on X", "who wanted Y", "has this come up
  before"), cite the date and the tally, e.g. "August 2019, passed 11-1".
- If something is not in the material, say so directly: "That's not in the constitution"
  or "There's no vote on record for that." Do not infer, do not fill gaps with how
  leagues usually work, and do not invent a section number, date or tally.
- Watch for these traps, which the archive documents explicitly:
  * A majority is not always enough. Some votes required unanimity and failed despite
    a large majority. Check the "required:" marker before calling something passed.
  * A tie leaves the rule unchanged (constitution 6.1), except for trade vetoes, where
    a 2016 vote established that a tie allows the trade.
  * Proposals often failed several times before passing. If asked when something was
    decided, give the vote that actually passed, and mention the earlier attempts only
    if they are relevant.
  * Three things passed in 2026 that are not yet written into the constitution, and a
    couple of older votes were never codified. These are listed under UNRESOLVED.
- If the constitution and a vote disagree, say so and give both rather than choosing.
- Be brief. Two or three sentences is usually right. These are people settling an
  argument on their phone, not reading a legal brief.
- Keep a dry, matter-of-fact tone. No cheerleading, no emoji.

THE CONSTITUTION:
`;

/**
 * Ask the rules bot. Returns { answer } or throws with a readable message.
 */
async function ask(question, history) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Ask a question first.');
    if (q.length > MAX_QUESTION) throw new Error('That question is too long — keep it under 500 characters.');

    const constitution = readConstitution();
    if (!constitution) throw new Error('No constitution is loaded yet.');
    const key = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key) throw new Error('The rules bot is not configured yet.');

    const faq = readFaq();
    let system = SYSTEM + constitution;

    const digest = voteDigest(readVotes());
    if (digest) {
        system += '\n\n════ VOTING HISTORY ════\n'
                + 'Every recorded league vote, 2014-2026, reconstructed from the league archive.\n'
                + 'Format: date | category | title | [RESULT tally] | options with vote counts | context\n\n'
                + digest;
    }

    if (faq && faq.length) {
        system += '\n\nPREVIOUSLY ANSWERED QUESTIONS (treat as supporting context, '
                + 'the constitution above still governs):\n'
                + faq.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
    }

    // Keep a short rolling history so follow-ups ("what about in the playoffs?") work.
    const messages = [];
    (Array.isArray(history) ? history.slice(-6) : []).forEach(m => {
        if (!m || !m.role || !m.content) return;
        if (m.role !== 'user' && m.role !== 'assistant') return;
        messages.push({ role: m.role, content: String(m.content).slice(0, 2000) });
    });
    messages.push({ role: 'user', content: q });

    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 30000);
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Bearer is the current scheme; x-api-key still works but is the legacy fallback.
                'Authorization': `Bearer ${key}`,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages }),
            signal: ac.signal,
        });
        const text = await res.text();
        if (!res.ok) {
            console.warn('[Rules] API', res.status, text.slice(0, 300));
            throw new Error(res.status === 401
                ? 'The rules bot key was rejected.'
                : 'The rules bot is unavailable right now.');
        }
        const json = JSON.parse(text);
        const answer = (json.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim();
        if (!answer) throw new Error('No answer came back. Try rephrasing.');
        return { answer, model: json.model || MODEL };
    } finally {
        clearTimeout(tid);
    }
}

module.exports = { ask, status, readConstitution, readDraft, readFaq, readVotes, voteDigest, hasKey };
