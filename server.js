const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// Accept ESPN_S2 or ESPN_2 (common Railway variable name typo)
const LEAGUE_ID   = process.env.LEAGUE_ID   || '119089';
const ESPN_S2     = process.env.ESPN_S2     || process.env.ESPN_2 || '';
const SWID        = process.env.SWID        || '';
const TURSO_URL   = process.env.TURSO_URL   || '';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';
const SCRAPE_KEY  = process.env.SCRAPE_KEY  || 'theleague';
// The NFL season rolls over in the spring, so anything before ~June still belongs
// to the previous fantasy year.
const CURRENT_SEASON = process.env.CURRENT_SEASON || (() => {
    const d = new Date();
    return d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1;
})();

const DATA_FILE = path.join(__dirname, 'data', 'league_data.json');

app.use(express.static(path.join(__dirname, 'public')));

// ── Data source priority:
// 1. Turso DB (if configured)
// 2. Local JSON file (written by scrape.js / /admin/scrape)
// 3. Live ESPN fetch fallback (requires valid cookies)

async function getFromTurso() {
    if (!TURSO_URL || !TURSO_TOKEN) return null;
    const { createClient } = await import('@libsql/client');
    const db  = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
    const res = await db.execute('SELECT data FROM league_data WHERE id = 1');
    if (!res.rows.length) return null;
    return JSON.parse(res.rows[0].data);
}

function getFromFile() {
    if (!fs.existsSync(DATA_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return null; }
}

function espnHeaders() {
    const h = {
        'Accept':     'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer':    'https://fantasy.espn.com/',
        'Origin':     'https://fantasy.espn.com',
    };
    if (ESPN_S2 && SWID) h['Cookie'] = `espn_s2=${ESPN_S2}; SWID=${SWID}`;
    return h;
}

async function fetchSeasonLive(season) {
    const base = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${LEAGUE_ID}`;
    const [mainRes, draftRes] = await Promise.allSettled([
        fetch(`${base}?view=mTeam&view=mStandings&view=mSettings&view=mSchedule`, { headers: espnHeaders() }),
        fetch(`${base}?view=mDraftDetail`, { headers: espnHeaders() }),
    ]);
    if (mainRes.status === 'rejected' || !mainRes.value.ok) return null;
    const text = await mainRes.value.text();
    if (text.trimStart().startsWith('<')) return null; // HTML = expired cookies
    const data = JSON.parse(text);
    if (!data.teams?.length) return null;
    let draftDetail = null;
    if (draftRes.status === 'fulfilled' && draftRes.value.ok) {
        const dt = await draftRes.value.text();
        if (!dt.trimStart().startsWith('<')) {
            draftDetail = JSON.parse(dt).draftDetail || null;
        }
    }
    return {
        season: parseInt(season),
        settings: data.settings || {},
        teams:    data.teams    || [],
        schedule: data.schedule || [],
        status:   data.status   || {},
        draftDetail,
        scrapedAt: new Date().toISOString(),
        source: 'live',
    };
}

async function getAllData() {
    try {
        const turso = await getFromTurso();
        if (turso?.seasons?.length) {
            console.log(`[Data] Loaded ${turso.seasons.length} seasons from Turso`);
            return { ...turso, source: 'turso' };
        }
    } catch (e) { console.warn('[Data] Turso error:', e.message); }

    const file = getFromFile();
    if (file?.seasons?.length) {
        console.log(`[Data] Loaded ${file.seasons.length} seasons from file`);
        return { ...file, source: 'file' };
    }

    console.log('[Data] No stored data — attempting live ESPN fetch');
    const results = await Promise.allSettled(['2024','2023','2022','2021'].map(fetchSeasonLive));
    const seasons = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean).sort((a,b) => b.season - a.season);
    if (!seasons.length) return null;
    return { seasons, source: 'live', updatedAt: new Date().toISOString() };
}

// ── API: main data endpoint
function getInaugural2010(){ try{ const p=path.join(__dirname,'season_2010.json'); if(fs.existsSync(p)) return JSON.parse(fs.readFileSync(p,'utf8')); }catch(e){ console.warn('[2010]',e.message);} return null; }
function withInaugural(d){ if(!d||!Array.isArray(d.seasons)) return d; if(d.seasons.some(s=>s.season===2010)) return d; const s=getInaugural2010(); return s?{...d,seasons:[...d.seasons,s].sort((a,b)=>b.season-a.season)}:d; }

app.get('/api/league', async (req, res) => {
    try {
        const data = await getAllData();
        if (!data) return res.status(502).json({
            error: 'No data available',
            fix: 'Visit /admin/scrape?key=YOUR_SCRAPE_KEY to trigger a scrape',
            hasFile: fs.existsSync(DATA_FILE), hasTurso: !!(TURSO_URL && TURSO_TOKEN), hasCookies: !!(ESPN_S2 && SWID),
        });
        res.json(annotatePreseason(annotateDraftStats(annotateManagers(withInaugural(data)))));
    } catch (err) {
        console.error('[API]', err);
        res.status(500).json({ error: err.message });
    }
});

// ── API: status
app.get('/api/status', (req, res) => {
    res.json({
        leagueId: LEAGUE_ID,
        hasFile:    fs.existsSync(DATA_FILE),
        hasTurso:   !!(TURSO_URL && TURSO_TOKEN),
        hasCookies: !!(ESPN_S2 && SWID),
        fileAge:    fs.existsSync(DATA_FILE)
            ? Math.round((Date.now() - fs.statSync(DATA_FILE).mtimeMs) / 1000 / 60) + ' min ago'
            : null,
    });
});

// ── Admin: trigger scrape from browser — streams live progress log
// Usage: https://your-app.up.railway.app/admin/scrape?key=theleague
app.get('/admin/scrape', async (req, res) => {
    if (req.query.key !== SCRAPE_KEY) {
        return res.status(403).send('Forbidden — wrong key');
    }

    // Stream HTML so progress appears live in the browser
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(`<!DOCTYPE html><html><head><title>Scraping...</title>
    <style>body{background:#111;color:#0f0;font-family:monospace;padding:2em;white-space:pre-wrap}
    .err{color:#f66}.ok{color:#0f0}.done{color:#ff0;font-size:1.4em}</style></head><body>`);

    const log = (msg) => {
        console.log('[Scrape]', msg);
        res.write(msg + '\n');
    };

    try {
        log('🏈 The League — Data Scraper');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        if (!ESPN_S2 || !SWID) {
            res.write('<span class="err">❌ ESPN cookies not set in Railway env vars (ESPN_S2 + SWID).\nAdd them in Railway → Variables and redeploy.</span>');
            res.end('</body></html>');
            return;
        }

        const { runScrape } = require('./scrape');
        const result = await runScrape(log);

        log(`\n<span class="done">🎉 Done! ${result.seasons.length} seasons scraped and saved.</span>`);

        // Draft grades need per-player projections and actuals — rebuild them off the fresh draft data.
        try {
            log('\n📊 Building draft grade data (projections vs actuals)...');
            await require('./playerstats').buildPlayerStats(result, log);
        } catch (e) {
            log(`<span class="err">⚠️  Player stats failed: ${e.message}</span>`);
            log('   (The site still works — the Draft Grades tab will just be empty.)');
        }

        log('\nNext: <a href="/" style="color:#0af">← Back to the app</a> (refresh to see new data)');
    } catch (err) {
        log(`\n<span class="err">❌ Scrape failed: ${err.message}</span>`);
        log('\nIf cookies are expired:');
        log('1. Go to fantasy.espn.com → DevTools → Application → Cookies');
        log('2. Copy fresh espn_s2 and SWID values');
        log('3. Update ESPN_S2 and SWID in Railway → Variables');
        log('4. Railway will redeploy, then visit this URL again');
    }

    res.end('</body></html>');
});

// ── Admin: rebuild only the draft-grade player data (no full re-scrape)
app.get('/admin/playerstats', async (req, res) => {
    if (req.query.key !== SCRAPE_KEY) return res.status(403).send('Forbidden — wrong key');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(`<!DOCTYPE html><html><head><title>Player stats</title>
    <style>body{background:#111;color:#0f0;font-family:monospace;padding:2em;white-space:pre-wrap}
    .err{color:#f66}.done{color:#ff0;font-size:1.4em}</style></head><body>`);
    const log = (m) => { console.log('[PlayerStats]', m); res.write(m + '\n'); };
    try {
        log('📊 Building projections + actuals for every drafted player\n');
        const out = await require('./playerstats').buildPlayerStats(null, log);
        log(`\n<span class="done">🎉 Done — ${out.summary.length} seasons.</span>`);
        log('\n<a href="/" style="color:#0af">← Back to the app</a>');
    } catch (err) {
        log(`\n<span class="err">❌ Failed: ${err.message}</span>`);
    }
    res.end('</body></html>');
});

// ── Admin: rebuild the current-season draft recap data (ESPN + FantasyPros)
app.get('/admin/preseason', async (req, res) => {
    if (req.query.key !== SCRAPE_KEY) return res.status(403).send('Forbidden — wrong key');
    const year = req.query.year || CURRENT_SEASON;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(`<!DOCTYPE html><html><head><title>Preseason ${year}</title>
    <style>body{background:#111;color:#0f0;font-family:monospace;padding:2em;white-space:pre-wrap}
    .err{color:#f66}.done{color:#ff0;font-size:1.4em}</style></head><body>`);
    const log = (m) => { console.log('[Preseason]', m); res.write(m + '\n'); };
    try {
        log(`Building ${year} draft recap data — ESPN projections + FantasyPros consensus\n`);
        const out = await require('./preseason').buildPreseason(year, null, log);
        const fp = out.sources.fantasyPros;
        log(`\n<span class="done">Done.</span>`);
        log(`ESPN matched ${out.sources.espn.matched}/${out.sources.espn.of}`);
        log(fp ? `FantasyPros matched ${fp.matched}/${fp.of} (${fp.experts} experts, ${fp.scoring})`
               : 'FantasyPros unavailable — grades will use ESPN only');
        log('\n<a href="/" style="color:#0af">← Back to the app</a>');
    } catch (err) {
        log(`\n<span class="err">Failed: ${err.message}</span>`);
    }
    res.end('</body></html>');
});

if (!fs.existsSync(DATA_FILE) && ESPN_S2 && SWID && !TURSO_URL) {
    console.log('[Boot] No data file - running background scrape');
    Promise.resolve()
        .then(() => require('./scrape').runScrape(console.log))
        .then(d => require('./playerstats').buildPlayerStats(d, console.log))
        .catch(e => console.error('[Boot] scrape failed', e.message));
} else if (ESPN_S2 && SWID && !fs.existsSync(path.join(__dirname, 'data', 'player_stats.json'))) {
    // Data exists but draft-grade stats don't — build just those.
    console.log('[Boot] No player stats file - building in background');
    Promise.resolve()
        .then(() => require('./playerstats').buildPlayerStats(null, console.log))
        .catch(e => console.error('[Boot] player stats failed', e.message));
}

// Current-season draft recap data (ESPN + FantasyPros), rebuilt if missing.
if (!fs.existsSync(path.join(__dirname, 'data', `preseason_${CURRENT_SEASON}.json`))) {
    console.log(`[Boot] No preseason_${CURRENT_SEASON} file - building in background`);
    setTimeout(() => {
        require('./preseason').buildPreseason(CURRENT_SEASON, null, console.log)
            .catch(e => console.error('[Boot] preseason failed', e.message));
    }, 20000);   // let any boot scrape finish writing league_data.json first
}

app.get('/health', (req, res) => res.json({ ok: true }));

let _mgrs=null;
function loadManagers(){ if(_mgrs) return _mgrs; try{ _mgrs=JSON.parse(fs.readFileSync(path.join(__dirname,'managers.json'),'utf8')); }catch(e){ _mgrs={}; } return _mgrs; }
function annotateManagers(d){ if(!d||!Array.isArray(d.seasons)) return d; const M=loadManagers(); d.seasons.forEach(s=>{ (s.teams||[]).forEach(t=>{ const g=t.owners&&t.owners[0]; const info=(typeof g==='string')?M[g]:null; if(info){ t.managerKey=info.key; t.managerNick=info.nick; t.managerName=info.name; } else { t.managerKey='t:'+(t.name||t.id); t.managerNick=t.name||('Team '+t.id); t.managerName=t.managerNick; } }); }); return d; }

function annotateDraftStats(d){ try { return require('./playerstats').annotateDraftStats(d); } catch(e) { console.warn('[DraftStats]', e.message); return d; } }
function annotatePreseason(d){ try { return require('./preseason').annotatePreseason(d); } catch(e) { console.warn('[Preseason]', e.message); return d; } }

app.listen(PORT, () => {
    console.log(`The League on :${PORT} · League ${LEAGUE_ID}`);
    console.log(`Sources: file=${fs.existsSync(DATA_FILE)} turso=${!!(TURSO_URL&&TURSO_TOKEN)} cookies=${!!(ESPN_S2&&SWID)}`);
    if (!ESPN_S2 || !SWID) console.warn('⚠️  No ESPN cookies set — visit /admin/scrape after adding ESPN_S2 + SWID to Railway vars');
});
