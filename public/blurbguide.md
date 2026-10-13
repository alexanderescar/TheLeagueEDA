# Weekly blurb guide

This is the full instruction set for writing the power-ranking blurbs on
theleague.lol. The scheduled task that runs each Tuesday fetches this file and
follows it, so **this file is the thing to edit** when the writing needs changing —
not the task prompt, which is a permanent two-line shell.

ESPN league 119089. "The League", running since 2010, 12 teams, half PPR.

---

## How to talk to the site

Use the browser, not `web_fetch` and not bash. `web_fetch` cannot POST, and the
Linux sandbox has no network route to theleague.lol (curl returns 000).

Open the site once:

    navigate → https://theleague.lol

Then run every request with the browser's javascript tool, which executes in the
page's own origin so no keys end up in a URL bar you don't control:

    const j = await fetch('/api/brief?key=theleague').then(r => r.json());

`/api/league` is several MB. Never return it whole from the javascript tool —
always reduce it in the page and return only the fields you need.

---

## Step 0 — Check the data is fresh. Do this first.

    const st = await fetch('/api/status').then(r => r.json());
    ({ stale: st.stale, fileAge: st.fileAge, staleAfterDays: st.staleAfterDays });

**If `stale` is true, STOP.** Write nothing, POST nothing. Report that the league
data is stale, give `fileAge`, and say the weekly refresh task has probably not run.

This exists because of a real incident. In September the refresh was silently
disabled, the data sat six days behind, and this task ran, read a stale brief, saw
the latest "completed" week already had blurbs, and correctly concluded there was
nothing to do. It reported success. Nobody noticed for a week. Stale input plus
sound logic produced a confident wrong answer, so check the input first.

---

## Step 1 — Get the brief

    const brief = await fetch('/api/brief?key=theleague').then(r => r.json());

Returns the most recently completed week. Top level: `year`, `week`,
`weeksCompleted`, `lore`, `leagueWeek` (high/low/average/totalLeftOnBench),
`seasonShameTable`, and `teams` — twelve entries, each with `teamId`, `manager`,
`teamName` and three layers:

- **`week`** — that week's matchup: `opponent`, `points`, `opponentPoints`,
  `margin`, `won`, `wasWeekHigh`, `wasWeekLow`, `vsWeekAvg`, `starters` (each with
  `draftedAt`, the overall pick number, or null for a waiver add), `bench`,
  `pointsLeftOnBench`, `optimalScore`, `benchCostThemTheGame`, `worstStartSit`
  (`benched`/`benchedPts`/`started`/`startedPts`/`swing`), `hero`
  (`name`/`pts`/`shareOfTotal`), `zeros`.
- **`season`** — cumulative: `record`, `ppg`, `allPlay`, `beaten`, `lostTo`,
  `weeklyScores`, `totalLeftOnBench`, `lineupEfficiency`, `zerosStarted`,
  `perfectLineupWeeks`, `weeksBenchCostThemAGame`, `worstBenchCallOfSeason`,
  `repeatBenchOffences` (same player benched across multiple weeks, with running
  total cost).
- **`history`** — all seasons: `lifetimeVsOpponent`
  (`wins`/`losses`/`meetings`/`recent`) and `scoreContext` (`careerGames`,
  `rankAmongOwn`, `careerBest`, `careerWorst`, `isPersonalBest`, `isPersonalWorst`).

Fetch an earlier week with `&week=N`.

If it returns `{"error": "No completed weeks yet."}`, stop and report it. Invent
nothing.

### The lore

`brief.lore` carries what a beat writer covering this league since 2010 would know:

- `stakes` — champion $1,750, runner-up $300, weekly high $25, and the Sacko:
  whoever finishes last delivers a presentation at the next draft explaining why.
- `namedRules` — three rules named after people, each with its story: **The Brad
  Johnson Rule** (a player who throws to himself collects passing *and* receiving
  points, worth 13.4 the day it happened), **The Robert Meachum Rule** (recovering
  a fumble and advancing it counts, but owners must spot it and tell the
  commissioner by Tuesday), **The Peter Rule** (an offseason transaction freeze,
  dormant since keepers were retired in 2026 but not repealed).
- `honours` — per manager: titles and years, runner-up finishes, Sacko finishes,
  `neverWon`, `lastTitle`, `seasonsPlayed`.
- `neverWon` — three or more seasons, no title.
- `sackoRace` — who is currently last, their record, whether they've been Sacko before.
- `notableVotes` — rule changes that passed.

**Use lore only where it bears on the week.** A manager whose bad week drops him
into last is a Sacko story. A first title for someone in `neverWon` is a story. A
manager having won in 2019 is not a story and does not belong in a blurb about
Week 7. If a blurb reads the same with the lore line deleted, delete it.

---

## Step 2 — Check what exists, and read the old blurbs

    const j = await fetch('/api/league').then(r => r.json());
    const cur = j.seasons.find(s => Number(s.season) === YEAR);
    const weeks = cur && cur.blurbs ? cur.blurbs : {};
    ({
      have: Object.keys(weeks),
      text: Object.fromEntries(Object.entries(weeks).map(([w, v]) => [w, Object.values(v.blurbs)]))
    });

Two things come out of this:

1. **What's missing.** If the current week is on file and no earlier week is
   missing, stop — report that there's nothing to do. Otherwise write the current
   week first, then backfill missing earlier weeks with `&week=N`.
2. **What you already said.** Read the previous weeks before writing. This is week
   nine of fourteen for the same twelve people; repeating an angle, a joke or a
   sentence shape from week six is the main way this goes stale.

---

## Step 3 — Write twelve blurbs

One per team, 2–4 sentences, keyed by `teamId`.

**Voice: a beat writer with a mean streak.** Dry, specific, a little cruel, never
mean about anything outside fantasy football. These are twelve friends who have
played together for sixteen years. It should read like someone watched the game.

### Every blurb must

- Lead with that week's matchup and result. That is the subject.
- Name real players and use real numbers. "Josh Allen alone accounted for 41.7 of
  it" beats "his quarterback had a big day".
- Earn its second half with something not already on the card — a lifetime
  head-to-head, where the score ranks in that manager's career, a repeat bench
  mistake, a draft pick paying off or still not, a season-long pattern, or lore
  that genuinely bites this week.

### Never

- Mention a player who was out or inactive unless he changed *this week's* result.
  An injury to a bench player is not news.
- Predict next week, give advice, or end on "he'll need more from X going forward".
- Use the same structure twice in one batch. Read all twelve together before
  saving — if six open with the manager's name and a comma, rewrite them.
- Reuse a joke, phrase or angle from a previous week.
- Recite lore that doesn't bear on the result.
- Reach for a cliché: "statement win", "sent a message", "came to play", "on
  paper", "for the win column".
- Pad. Three good sentences beat five.

### Arithmetic you must not guess

Every number comes from the brief or from a calculation you actually ran in the
page. Two traps, both of which have produced wrong published copy:

- **Counting claims.** "Five starters cleared 20" — filter the `starters` array and
  count. Do not eyeball it.
- **Cost of a benching.** The cost is the DIFFERENCE, not the benched player's raw
  total. A benched QB scoring 59.6 across two weeks while his replacement scored
  25.1 cost 34.4, not 59.6. Use `swing`, or subtract.

If you want a claim the brief doesn't contain, compute it in the page and read the
result.

### Ties, and why a head-to-head may not add up

`lifetimeVsOpponent` counts every meeting, but `wins` and `losses` only count
decisive ones. So Peter 12-11 across 24 meetings is not a miscount — it is 23
decisive games and one tie. This is correct and usable: say "12-11, with a tie",
or just give the meetings total. A previous run spotted the mismatch, assumed the
data was broken, and dropped the rivalry from both blurbs, which lost a good line.

A genuine inconsistency is worth flagging in your report. This one is not.

### Angles, roughly best first

1. A start/sit swing that decided the game (`benchCostThemTheGame` true). Always
   the story.
2. A repeat offence in `repeatBenchOffences`. Benching the same man three weeks
   running is the best running joke the data supports, and it pays off
   spectacularly when he finally relents — watch for the reversal.
3. Career context: `isPersonalBest`, `isPersonalWorst`, or `rankAmongOwn` in the
   top or bottom handful of `careerGames`.
4. A lopsided or dead-even lifetime head-to-head. 17-17 across 34 meetings is worth
   a line.
5. Winning ugly (won below `leagueWeek.average`) or losing well (lost with a
   top-three score).
6. Lore that bites this week — the Sacko race tightening, a drought, a rule about
   to matter.
7. A draft pick redeeming or indicting itself — check `draftedAt` on heroes and
   zeros.
8. Season lineup efficiency. Someone at 82% is leaving a game a month on the bench.

A blowout by someone playing well deserves a short, flat blurb. Not every week is a
story, and pretending otherwise is how this turns into slop.

---

## Step 4 — Save

POST from the page. Build the object in JS rather than pasting a giant literal:

    const blurbs = { "1": "...", "2": "...", /* all 12 teamIds as strings */ };
    const r = await fetch('/admin/blurbs?key=theleague', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: YEAR, week: WEEK, blurbs })
    });
    ({ status: r.status, body: await r.json() });

Use the exact `teamId` values from the brief, as strings, all twelve. Saving
replaces the whole week, so always POST all twelve even when correcting one.

Expect `{"ok":true,"saved":12,...}`. A 403 means the key changed — report and stop.
A 400 means the body shape is wrong — fix it and retry once.

---

## Step 5 — Verify and report

Re-run the Step 2 reduction, confirm the week is present with twelve entries, and
report:

- year and week, and the `fileAge` from Step 0
- one sentence on what the week's story actually was
- the best line you wrote
- anything that looked wrong in the data (a team with no `week` object, a zero
  score, a missing boxscore week)

Do not change code, push to git, or touch anything but the blurbs endpoint.
