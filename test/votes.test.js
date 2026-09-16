const fs = require('fs');
const path = require('path');
const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'votes.json'), 'utf8'));
const R = require('../rules.js');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const votes = store.votes;

console.log('\nSTRUCTURE');
{
    ok('votes present', Array.isArray(votes) && votes.length > 100, votes.length + ' votes');
    const ids = votes.map(v => v.id);
    ok('ids are unique', new Set(ids).size === ids.length);
    const required = ['id', 'season', 'date', 'category', 'title', 'options', 'result', 'outcome', 'tally', 'source'];
    const missing = votes.filter(v => required.some(k => v[k] == null));
    ok('every vote has the required fields', !missing.length, missing.map(v => v.id).join(', '));
    ok('every vote has at least two recorded options or is unanimous',
        votes.every(v => v.options.length >= 2 || v.unanimous));
}

console.log('\nTALLIES ADD UP');
{
    const bad = votes.filter(v => v.turnout !== v.options.reduce((a, o) => a + o.votes, 0));
    ok('turnout equals the sum of option votes', !bad.length, bad.map(v => v.id).join(', '));
    const tallyBad = votes.filter(v => v.tally !== v.options.map(o => o.votes).join('-'));
    ok('tally string matches the option votes', !tallyBad.length, tallyBad.map(v => v.id).join(', '));
    ok('nobody has negative votes', votes.every(v => v.options.every(o => o.votes >= 0)));
}

console.log('\nWINNERS');
{
    const oneWinner = votes.filter(v => v.options.filter(o => o.winner).length !== 1);
    ok('exactly one winning option each', !oneWinner.length, oneWinner.map(v => v.id).join(', '));
    // The winner must be the top vote-getter, except on ties where it is a co-leader.
    const wrong = votes.filter(v => {
        const w = v.options.find(o => o.winner);
        const max = Math.max(...v.options.map(o => o.votes));
        return v.result === 'tied' ? w.votes !== max : v.options.some(o => o.votes > w.votes);
    });
    ok('the winner is the top vote-getter', !wrong.length, wrong.map(v => v.id).join(', '));
    const tiesFlagged = votes.filter(v => {
        const max = Math.max(...v.options.map(o => o.votes));
        const leaders = v.options.filter(o => o.votes === max).length;
        return leaders > 1 && v.result !== 'tied' && v.result !== 'upheld';
    });
    ok('any vote with co-leaders is marked tied', !tiesFlagged.length, tiesFlagged.map(v => v.id).join(', '));
}

console.log('\nTHRESHOLDS  (a majority is not always enough)');
{
    const unanimityVotes = votes.filter(v => v.threshold === 'unanimous');
    ok('unanimity-threshold votes exist', unanimityVotes.length >= 2, unanimityVotes.length + ' found');
    // None of them were unanimous, so none may be recorded as a clean pass.
    const wrongly = unanimityVotes.filter(v => {
        const dissent = v.options.filter(o => !o.winner).reduce((a, o) => a + o.votes, 0);
        return dissent > 0 && v.result === 'passed';
    });
    ok('a unanimity vote with dissent is never marked passed', !wrongly.length,
        wrongly.map(v => `${v.id} (${v.tally})`).join(', '));
}

console.log('\nUNANIMOUS FLAG');
{
    const wrong = votes.filter(v => {
        const dissent = v.options.filter(o => !o.winner).reduce((a, o) => a + o.votes, 0);
        return !!v.unanimous !== (dissent === 0);
    });
    ok('unanimous flag matches zero dissent', !wrong.length, wrong.map(v => `${v.id} (${v.tally})`).join(', '));
}

console.log('\nCATEGORIES AND RESULTS');
{
    const cats = ['rule', 'money', 'scoring', 'governance', 'trade'];
    const badCat = votes.filter(v => cats.indexOf(v.category) === -1);
    ok('categories are from the known set', !badCat.length, badCat.map(v => v.category).join(', '));
    const results = ['passed', 'failed', 'tied', 'upheld', 'vetoed', 'disputed'];
    const badRes = votes.filter(v => results.indexOf(v.result) === -1);
    ok('results are from the known set', !badRes.length, badRes.map(v => v.result).join(', '));
    ok('trades resolve to upheld or vetoed',
        votes.filter(v => v.category === 'trade').every(v => ['upheld','vetoed'].includes(v.result)));
    ok('non-trades never use upheld/vetoed',
        votes.filter(v => v.category !== 'trade').every(v => !['upheld','vetoed'].includes(v.result)));
}

console.log('\nDATES AND SEASONS');
{
    ok('seasons are plausible', votes.every(v => v.season >= 2010 && v.season <= 2030));
    const mismatched = votes.filter(v => String(v.date).slice(0, 4) !== String(v.season));
    ok('the date year matches the season', !mismatched.length, mismatched.map(v => v.id).join(', '));
    ok('sorted newest first', votes.every((v, i) => i === 0 || votes[i - 1].season >= v.season));
}

console.log('\nTRADES');
{
    const trades = votes.filter(v => v.category === 'trade');
    ok('trades have parties', trades.every(v => Array.isArray(v.parties) && v.parties.length));
    ok('trades describe what moved', trades.every(v => !!v.detail));
    const vetoed = trades.filter(v => v.result === 'vetoed');
    ok('vetoed trades really did lose', vetoed.every(v => {
        const veto = v.options.find(o => /^veto$/i.test(o.label));
        const no = v.options.find(o => /no veto/i.test(o.label));
        return veto && no && veto.votes > no.votes;
    }), vetoed.map(v => v.id).join(', '));
}

console.log('\nCONSTITUTION VERSIONS');
{
    const vs = store.versions;
    ok('five versions on record', vs.length === 5, vs.length + '');
    ok('exactly one marked current', vs.filter(v => v.current).length === 1);
    ok('effective years increase', vs.every((v, i) => i === 0 || vs[i - 1].effectiveFrom < v.effectiveFrom));
    ok('open questions recorded', Array.isArray(store._openQuestions) && store._openQuestions.length > 0);
}

console.log('\nBOT DIGEST');
{
    const digest = R.voteDigest(store);
    ok('digest builds', typeof digest === 'string' && digest.length > 1000);
    ok('digest is smaller than the raw file', digest.length < JSON.stringify(store).length,
        `${(digest.length/1024).toFixed(0)}KB vs ${(JSON.stringify(store).length/1024).toFixed(0)}KB`);
    ok('every vote appears in the digest',
        votes.every(v => digest.indexOf(v.title) > -1));
    ok('thresholds are surfaced to the bot', digest.indexOf('required: unanimous') > -1);
    ok('unresolved items are surfaced', digest.indexOf('UNRESOLVED') > -1);
    ok('digest survives an empty store', R.voteDigest({ votes: [] }) != null);
    ok('digest returns null on garbage', R.voteDigest(null) === null);
}

console.log(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
