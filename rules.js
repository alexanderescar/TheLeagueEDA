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

function hasKey() { return !!(process.env.ANTHROPIC_API_KEY || '').trim(); }

function status() {
    const c = readConstitution();
    const f = readFaq();
    return {
        hasConstitution: !!c,
        constitutionChars: c ? c.length : 0,
        faqCount: f ? f.length : 0,
        botAvailable: !!(c && hasKey()),
        reason: !c ? 'No constitution.md on file'
              : !hasKey() ? 'ANTHROPIC_API_KEY not set'
              : null,
    };
}

const SYSTEM = `You answer questions about a fantasy football league's constitution.

Rules for your answers:
- Answer ONLY from the constitution text provided below. It is the sole authority.
- Quote the exact clause you are relying on, then explain it in plain English.
- If the constitution does not address the question, say so directly: "The constitution
  doesn't cover that." Do not infer, do not fill gaps with how leagues usually work, and
  do not invent a section number. Suggest it may be worth adding as an amendment.
- If two clauses conflict, say so and quote both rather than picking one.
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

module.exports = { ask, status, readConstitution, readFaq, hasKey };
