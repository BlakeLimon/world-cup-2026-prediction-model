#!/usr/bin/env node
// dashboard.mjs — a tiny zero-dependency local web dashboard for the
// model-vs-sportsbook value comparison. The API key stays server-side (.env);
// the browser only ever talks to this local server.
//   node dashboard.mjs           → http://localhost:3000
//   PORT=4000 node dashboard.mjs → custom port
import { createServer } from "node:http";
import { formatAmericanOdds } from "./elo.mjs";
import { loadEnv, loadRatings, fetchOdds, evaluateMatch } from "./value.mjs";

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
    for (const row of r.rows) {
      row.fair = formatAmericanOdds(row.pModel);
      if (row.value) valueCount++;
    }
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
  .verdict { font-weight:700; font-size:12px; }
  .verdict.value { color:var(--green); }
  .verdict.outlier { color:var(--amber); }
  .verdict.none { color:var(--muted); }
  .bar { display:inline-block; height:8px; border-radius:4px; background:var(--accent);
    vertical-align:middle; opacity:.55; }
  .pos { color:var(--green); } .neg { color:var(--red); }
  .loading,.empty { color:var(--muted); padding:40px; text-align:center; }
  .err { color:var(--red); padding:20px; }
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
  <div id="picks"></div>
  <div id="matches"><div class="loading">Loading live odds…</div></div>
</main>
<footer>
  Fair / no-vig odds from the model · best price across US books · ⚠ outlier = model disagrees too far to trust.
  Educational use — bet responsibly.
</footer>
<script>
const fmtPct = x => (x*100).toFixed(1)+'%';
const sign = a => a>0 ? '+'+a : ''+a;
const fmtEv = x => (x>=0?'+':'')+(x*100).toFixed(1)+'%';
const when = iso => new Date(iso).toLocaleString([], {weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});

async function load() {
  const ev = (parseFloat(document.getElementById('ev').value)||0)/100;
  const btn = document.getElementById('refresh'); btn.disabled = true;
  document.getElementById('matches').innerHTML = '<div class="loading">Loading live odds…</div>';
  try {
    const r = await fetch('/api/value?ev='+ev);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    render(d);
  } catch(e) {
    document.getElementById('matches').innerHTML = '<div class="err">Error: '+e.message+'</div>';
  } finally { btn.disabled = false; }
}

function render(d) {
  document.getElementById('meta').innerHTML =
    '<span><b>'+d.matchCount+'</b> matches</span>' +
    '<span><b>'+d.valueCount+'</b> value bets</span>' +
    '<span><b>'+d.remaining+'</b> API credits left</span>' +
    '<span>updated '+new Date(d.generatedAt).toLocaleTimeString()+'</span>';

  // Top value-bets panel
  const picks = [];
  for (const m of d.matches) for (const row of m.rows) if (row.value)
    picks.push({...row, home:m.home, away:m.away});
  picks.sort((a,b)=>b.ev-a.ev);
  document.getElementById('picks').innerHTML = picks.length ? (
    '<div class="picks"><h2>⭐ '+picks.length+' Value Bet'+(picks.length>1?'s':'')+'</h2>' +
    picks.map(p =>
      '<div class="pick"><span class="bet">'+p.label+'</span>' +
      '<span class="vs">'+p.home+' vs '+p.away+'</span>' +
      '<span class="price">'+sign(p.american)+'</span>' +
      '<span class="book">'+p.book+'</span>' +
      '<span class="pill ev">'+fmtEv(p.ev)+' EV</span></div>'
    ).join('') + '</div>'
  ) : '';

  // Per-match tables
  document.getElementById('matches').innerHTML = d.matches.length ? d.matches.map(m =>
    '<div class="match"><h3><span>'+m.home+' vs '+m.away+'</span>' +
    '<span class="when">'+when(m.kickoff)+' · '+m.bookCount+' books</span></h3>' +
    '<table><thead><tr>' +
    '<th class="team">Outcome</th><th>Model</th><th>Fair</th><th>Market</th>' +
    '<th>Best</th><th class="team">Book</th><th>EV</th><th class="team">Verdict</th>' +
    '</tr></thead><tbody>' +
    m.rows.map(row => {
      const cls = row.verdict;
      const vlabel = cls==='value'?'✅ VALUE':cls==='outlier'?'⚠ outlier':'—';
      return '<tr class="'+cls+'">' +
        '<td class="team">'+row.label+'</td>' +
        '<td>'+fmtPct(row.pModel)+' <span class="bar" style="width:'+(row.pModel*42).toFixed(0)+'px"></span></td>' +
        '<td>'+row.fair+'</td>' +
        '<td>'+fmtPct(row.pMarket)+'</td>' +
        '<td class="price">'+sign(row.american)+'</td>' +
        '<td class="team book">'+row.book+'</td>' +
        '<td class="'+(row.ev>=0?'pos':'neg')+'">'+fmtEv(row.ev)+'</td>' +
        '<td class="team verdict '+cls+'">'+vlabel+'</td></tr>';
    }).join('') +
    '</tbody></table></div>'
  ).join('') : '<div class="empty">No matches currently listed by US books.</div>';

  if (d.unmatched.length)
    document.getElementById('matches').innerHTML +=
      '<div class="err">⚠ Unmatched teams (add to ALIAS in value.mjs): '+d.unmatched.join(', ')+'</div>';
}

document.getElementById('refresh').addEventListener('click', load);
document.getElementById('ev').addEventListener('keydown', e => { if(e.key==='Enter') load(); });
load();
</script>
</body>
</html>`;
