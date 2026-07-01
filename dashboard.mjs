#!/usr/bin/env node
// dashboard.mjs — a tiny zero-dependency local web dashboard for the
// model-vs-sportsbook value comparison. The API key stays server-side (.env);
// the browser only ever talks to this local server.
//   node dashboard.mjs           → http://localhost:3000
//   PORT=4000 node dashboard.mjs → custom port
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { formatAmericanOdds } from "./elo.mjs";
import { loadEnv, loadRatings, fetchOdds, evaluateMatch } from "./value.mjs";

const LOG_PATH = new URL("./data/bet-log.json", import.meta.url);
function readLog() {
  if (!existsSync(LOG_PATH)) return [];
  try { return JSON.parse(readFileSync(LOG_PATH, "utf8")); } catch { return []; }
}

loadEnv();
const API_KEY = process.env.ODDS_API_KEY;
const REGIONS = process.env.ODDS_REGIONS || "us";
const PORT = process.env.PORT || 3000;
if (!API_KEY) {
  console.error("Missing ODDS_API_KEY (set it in .env).");
  process.exit(1);
}

const ratings = loadRatings();

// Build the JSON payload the page renders from.
async function buildPayload(evMin) {
  const { matches, remaining } = await fetchOdds({ apiKey: API_KEY, regions: REGIONS });
  const unmatched = new Set();
  const out = [];
  let valueCount = 0;
  for (const match of matches) {
    const r = evaluateMatch(match, ratings, { evMin, unmatched });
    if (!r) continue;
    for (const row of r.rows) row.fair = formatAmericanOdds(row.pModel);
    // Only surface spread lines that carry a signal (keeps the table tight).
    r.spreadRows = (r.spreadRows || []).filter((s) => s.verdict !== "none");
    for (const row of r.spreadRows) row.fair = formatAmericanOdds(row.pModel);
    valueCount += r.recommendations.length; // deduped: one bet per side
    out.push(r);
  }
  out.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  return {
    generatedAt: new Date().toISOString(),
    remaining,
    evMin,
    valueCount,
    matchCount: out.length,
    matches: out,
    logged: readLog(), // past/recorded recommendations (for days off the live feed)
    unmatched: [...unmatched],
  };
}

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (url.pathname === "/api/value") {
    try {
      const evMin = Math.max(0, parseFloat(url.searchParams.get("ev")) || 0.02);
      json(res, 200, await buildPayload(evMin));
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n  ⚽ Value dashboard running → http://localhost:${PORT}\n  (Ctrl+C to stop)\n`);
});

// --- the page (HTML + CSS + JS, all inline) ------------------------------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>World Cup 2026 — Model vs Sportsbooks</title>
<style>
  :root {
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2330; --line:#2a3340;
    --text:#e6edf3; --muted:#8b949e; --green:#2ea043; --greenbg:#0f2a17;
    --amber:#d29922; --amberbg:#2a230f; --red:#f85149; --accent:#58a6ff;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--line);
    display:flex; align-items:center; gap:20px; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; font-weight:600; }
  h1 span { color:var(--muted); font-weight:400; }
  .meta { color:var(--muted); font-size:12.5px; display:flex; gap:16px; flex-wrap:wrap; }
  .meta b { color:var(--text); font-weight:600; }
  .controls { margin-left:auto; display:flex; align-items:center; gap:10px; }
  label { color:var(--muted); font-size:12.5px; }
  input[type=number] { width:64px; background:var(--panel2); color:var(--text);
    border:1px solid var(--line); border-radius:6px; padding:5px 8px; }
  button { background:var(--accent); color:#04101f; border:0; border-radius:6px;
    padding:7px 14px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  main { padding:20px 24px; max-width:1100px; margin:0 auto; }
  .picks { background:var(--panel); border:1px solid var(--line); border-radius:10px;
    padding:16px 18px; margin-bottom:24px; }
  .picks h2 { margin:0 0 12px; font-size:14px; color:var(--green); }
  .pick { display:flex; align-items:center; gap:10px; padding:7px 0;
    border-top:1px solid var(--line); font-size:13.5px; }
  .pick:first-of-type { border-top:0; }
  .pick .bet { font-weight:600; min-width:150px; }
  .pick .vs { color:var(--muted); flex:1; }
  .pill { font-weight:700; padding:2px 9px; border-radius:999px; font-size:12px; }
  .pill.ev { background:var(--greenbg); color:var(--green); }
  .price { color:var(--accent); font-weight:600; }
  .book { color:var(--muted); font-size:12px; }
  .match { background:var(--panel); border:1px solid var(--line); border-radius:10px;
    margin-bottom:14px; overflow:hidden; }
  .match h3 { margin:0; padding:12px 16px; font-size:14.5px; background:var(--panel2);
    display:flex; justify-content:space-between; align-items:center; }
  .match h3 .when { color:var(--muted); font-weight:400; font-size:12px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:right; padding:9px 12px; border-top:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; font-size:11.5px; text-transform:uppercase;
    letter-spacing:.04em; }
  td.team,th.team { text-align:left; font-weight:600; }
  tr.value td { background:var(--greenbg); }
  tr.outlier td { background:var(--amberbg); }
  tr.alt td { background:#13202b; }
  .verdict { font-weight:700; font-size:12px; }
  .verdict.value { color:var(--green); }
  .verdict.outlier { color:var(--amber); }
  .verdict.alt { color:var(--muted); }
  .verdict.none { color:var(--muted); }
  .bar { display:inline-block; height:8px; border-radius:4px; background:var(--accent);
    vertical-align:middle; opacity:.55; }
  .pos { color:var(--green); } .neg { color:var(--red); }
  .loading,.empty { color:var(--muted); padding:40px; text-align:center; }
  .err { color:var(--red); padding:20px; }
  .dates { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  .daychip { background:var(--panel); border:1px solid var(--line); color:var(--text);
    border-radius:999px; padding:6px 14px; font-size:13px; cursor:pointer; }
  .daychip.sel { background:var(--accent); color:#04101f; border-color:var(--accent); font-weight:600; }
  .daychip.past { opacity:.8; }
  .daychip .n { color:var(--muted); font-size:11px; margin-left:7px; }
  .daychip.sel .n { color:#04101f; }
  .logpanel { background:var(--panel); border:1px solid var(--line); border-radius:10px;
    padding:16px 18px; margin-top:8px; }
  .logpanel h2 { margin:0 0 12px; font-size:14px; color:var(--accent); }
  .logrow { display:flex; align-items:center; gap:10px; padding:7px 0;
    border-top:1px solid var(--line); font-size:13px; }
  .logrow:first-of-type { border-top:0; }
  .st { font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; }
  .st.open { background:#21262d; color:var(--muted); }
  .st.won { background:var(--greenbg); color:var(--green); }
  .st.lost { background:#2a1416; color:var(--red); }
  .st.push { background:var(--amberbg); color:var(--amber); }
  .tag2 { font-size:10px; font-weight:700; padding:1px 6px; border-radius:5px;
    background:var(--panel2); color:var(--muted); }
  footer { color:var(--muted); font-size:11.5px; padding:16px 24px; text-align:center;
    border-top:1px solid var(--line); }
</style>
</head>
<body>
<header>
  <h1>⚽ World Cup 2026 <span>· model vs US sportsbooks</span></h1>
  <div class="meta" id="meta"></div>
  <div class="controls">
    <label>EV ≥ <input type="number" id="ev" value="2" min="0" step="0.5">%</label>
    <button id="refresh">Refresh</button>
  </div>
</header>
<main>
  <div id="dates" class="dates"></div>
  <div id="picks"></div>
  <div id="matches"><div class="loading">Loading live odds…</div></div>
  <div id="logged"></div>
</main>
<footer>
  Pick a day above · live odds for upcoming days, your logged bets for past days ·
  ⚠ outlier = model disagrees too far to trust. Educational use — bet responsibly.
</footer>
<script>
const fmtPct = x => (x*100).toFixed(1)+'%';
const sign = a => a>0 ? '+'+a : ''+a;
const fmtEv = x => (x>=0?'+':'')+(x*100).toFixed(1)+'%';
const when = iso => new Date(iso).toLocaleString([], {weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
const dayKey = iso => new Date(iso).toLocaleDateString();
const dayLabel = iso => new Date(iso).toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'});

let DATA = null;
let selectedDate = null;

async function load() {
  const ev = (parseFloat(document.getElementById('ev').value)||0)/100;
  const btn = document.getElementById('refresh'); btn.disabled = true;
  document.getElementById('matches').innerHTML = '<div class="loading">Loading live odds…</div>';
  try {
    const r = await fetch('/api/value?ev='+ev);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    DATA = d;
    renderMeta();
    renderDates();
    renderDay();
  } catch(e) {
    document.getElementById('matches').innerHTML = '<div class="err">Error: '+e.message+'</div>';
  } finally { btn.disabled = false; }
}

function renderMeta() {
  document.getElementById('meta').innerHTML =
    '<span><b>'+DATA.matchCount+'</b> live matches</span>' +
    '<span><b>'+DATA.valueCount+'</b> value bets</span>' +
    '<span><b>'+DATA.remaining+'</b> credits</span>' +
    '<span>updated '+new Date(DATA.generatedAt).toLocaleTimeString()+'</span>';
}

// Union of days from live matches + logged bets, ascending.
function allDates() {
  const m = new Map();
  for (const x of DATA.matches) m.set(dayKey(x.kickoff), x.kickoff);
  for (const b of (DATA.logged||[])) m.set(dayKey(b.kickoff), b.kickoff);
  return [...m.entries()].sort((a,b)=> new Date(a[1]) - new Date(b[1]));
}
const liveOn = key => DATA.matches.filter(m=>dayKey(m.kickoff)===key);
const loggedOn = key => (DATA.logged||[]).filter(b=>dayKey(b.kickoff)===key);

function renderDates() {
  const dates = allDates();
  const keys = dates.map(d=>d[0]);
  if (!selectedDate || !keys.includes(selectedDate)) {
    const firstLive = dates.find(([k])=> liveOn(k).length);
    selectedDate = (firstLive || dates[0] || [null])[0];
  }
  document.getElementById('dates').innerHTML = dates.map(([k,iso])=>{
    const live = liveOn(k).length;
    let v = 0; for (const mm of liveOn(k)) v += mm.recommendations.length;
    const n = live ? (v+' VB') : (loggedOn(k).length+' logged');
    return '<button class="daychip'+(k===selectedDate?' sel':'')+(live?'':' past')+'" data-k="'+k+'">'+dayLabel(iso)+'<span class="n">'+n+'</span></button>';
  }).join('') || '<span class="empty">No days available.</span>';
  document.querySelectorAll('.daychip').forEach(el =>
    el.addEventListener('click', () => { selectedDate = el.dataset.k; renderDates(); renderDay(); }));
}

function matchTable(m) {
  const row = (r, isSpread) => {
    const cls = r.recommended ? 'value' : r.value ? 'alt' : r.verdict;
    const vlabel = r.recommended?'✅ VALUE':r.value?'· alt':cls==='outlier'?'⚠ outlier':'—';
    return '<tr class="'+cls+'">' +
      '<td class="team">'+r.label+'</td>' +
      '<td>'+fmtPct(r.pModel)+(isSpread?'':' <span class="bar" style="width:'+(r.pModel*42).toFixed(0)+'px"></span>')+'</td>' +
      '<td>'+r.fair+'</td>' +
      '<td>'+fmtPct(r.pMarket)+'</td>' +
      '<td class="price">'+sign(r.american)+'</td>' +
      '<td class="team book">'+r.book+'</td>' +
      '<td class="'+(r.ev>=0?'pos':'neg')+'">'+fmtEv(r.ev)+'</td>' +
      '<td class="team verdict '+cls+'">'+vlabel+'</td></tr>';
  };
  const venueStr = m.venue ? ' · '+m.venue.stadium+(m.venue.altitudeM>1200?' ('+m.venue.altitudeM+'m)':'') : '';
  const adjStr = (m.adjustmentNotes && m.adjustmentNotes.length) ? '<div style="padding:6px 16px;font-size:11.5px;color:var(--amber);">'+m.adjustmentNotes.join(' · ')+'</div>' : '';
  return '<div class="match"><h3><span>'+m.home+' vs '+m.away+'</span>' +
    '<span class="when">'+when(m.kickoff)+venueStr+' · '+m.bookCount+' books</span></h3>' + adjStr +
    '<table><thead><tr>' +
    '<th class="team">Outcome</th><th>Model</th><th>Fair</th><th>Market</th>' +
    '<th>Best</th><th class="team">Book</th><th>EV</th><th class="team">Verdict</th>' +
    '</tr></thead><tbody>' +
    m.rows.map(r=>row(r,false)).join('') +
    ((m.spreadRows&&m.spreadRows.length) ?
      '<tr><td class="team" colspan="8" style="color:var(--muted);font-size:11.5px;padding-top:10px;">spreads</td></tr>' +
      m.spreadRows.map(r=>row(r,true)).join('') : '') +
    '</tbody></table></div>';
}

function loggedPanel(logged) {
  const rows = logged.slice().sort((a,b)=>(b.ev||0)-(a.ev||0)).map(b=>{
    const st = b.status||'open';
    const res = b.result ? ' · '+b.home+' '+b.result.homeGoals+'-'+b.result.awayGoals+' '+b.away : '';
    return '<div class="logrow">' +
      '<span class="st '+st+'">'+st.toUpperCase()+'</span>' +
      '<span class="tag2">'+(b.market==='spread'?'SPR':'ML')+'</span>' +
      '<span class="bet" style="min-width:120px;font-weight:600;">'+b.bet+'</span>' +
      '<span class="vs" style="flex:1;color:var(--muted);">'+b.match+res+'</span>' +
      '<span class="price">'+sign(b.priceAmerican)+'</span>' +
      '<span class="book">'+b.book+'</span>' +
      '<span class="pill ev">'+fmtEv(b.ev||0)+'</span></div>';
  }).join('');
  return '<div class="logpanel"><h2>Logged recommendations · '+logged.length+'</h2>'+rows+'</div>';
}

function renderDay() {
  const live = liveOn(selectedDate);
  const logged = loggedOn(selectedDate);

  const picks = [];
  for (const m of live) for (const r of m.recommendations) picks.push({...r, home:m.home, away:m.away});
  picks.sort((a,b)=>b.ev-a.ev);
  document.getElementById('picks').innerHTML = picks.length ? (
    '<div class="picks"><h2>⭐ '+picks.length+' value bet'+(picks.length>1?'s':'')+' · '+dayLabel(live[0].kickoff)+'</h2>' +
    picks.map(p =>
      '<div class="pick"><span class="bet">'+p.label+'</span>' +
      '<span class="vs">'+p.home+' vs '+p.away+'</span>' +
      '<span class="price">'+sign(p.american)+'</span>' +
      '<span class="book">'+p.book+'</span>' +
      '<span class="pill ev">'+fmtEv(p.ev)+' EV</span></div>'
    ).join('') + '</div>'
  ) : '';

  document.getElementById('matches').innerHTML = live.length
    ? live.map(matchTable).join('')
    : (logged.length ? '' : '<div class="empty">No live matches for this day.</div>');
  document.getElementById('logged').innerHTML = logged.length ? loggedPanel(logged) : '';

  if (live.length && DATA.unmatched && DATA.unmatched.length)
    document.getElementById('matches').innerHTML +=
      '<div class="err">⚠ Unmatched teams (add to ALIAS in value.mjs): '+DATA.unmatched.join(', ')+'</div>';
}

document.getElementById('refresh').addEventListener('click', load);
document.getElementById('ev').addEventListener('keydown', e => { if(e.key==='Enter') load(); });
load();
</script>
</body>
</html>`;
