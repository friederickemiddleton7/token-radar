// Token Radar's page. Reads window.RADAR (written by main.ts beside this folder) and renders the
// board, the value model and a detail drawer for every protocol. No network, no framework.
//
// State lives in the URL hash (#q=…&category=…&chain=…&sort=…&dir=…&detail=…), so a filtered view or
// a detail view is a link a reader can open again -- and a screenshot can be reproduced exactly.
'use strict';

const D = window.RADAR;
const $ = (id) => document.getElementById(id);

const state = { q: '', category: '', chain: '', sort: 'rank', dir: 'desc', view: 'pre', detail: null };

/* ------------------------------------------------------------------ format */
function fmtUSD(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const s = n > 0 ? '+' : '';
  return `${s}${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;
}
function fmtAge(days) {
  if (typeof days !== 'number' || !Number.isFinite(days)) return 'unknown';
  if (days >= 730) return `${(days / 365).toFixed(1)} yr`;
  if (days >= 60) return `${Math.round(days / 30)} mo`;
  return `${days} d`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function deltaClass(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) < 0.005) return 'flat';
  return n > 0 ? 'up' : 'down';
}
function deltaArrow(n) {
  const c = deltaClass(n);
  return c === 'up' ? '▲' : c === 'down' ? '▼' : '·';
}

/* ------------------------------------------------------------------ header + KPIs */
function renderHeader() {
  $('modelVersion').textContent = `${D.model_version} model`;
  $('asOf').textContent = D.as_of;
  $('floor').textContent = fmtUSD(D.floor_usd);
  $('source').textContent = D.source.includes('api.llama.fi') ? 'DefiLlama protocols' : D.source.slice(0, 28);
  $('footSource').textContent = `Snapshot: ${D.source}. Watchlist: ${D.watchlist_size} protocols at or above ${fmtUSD(D.floor_usd)} of TVL that record no token and are not a wrapped, staked or bridged product of one that trades.`;
  $('footMethod').textContent =
    `Every protocol that records no token is scored by one function: its TVL sets a scale base through a concave multiple, ` +
    `its seven-day TVL change sets a momentum multiplier, and the time it has run with no token sets an accrual multiplier. ` +
    `The ${D.early_size} rows below the watchlist floor are the early radar: pre-token protocols the list does not name yet.`;
}

function renderKpis() {
  const rows = D.rows;
  const total = rows.reduce((s, r) => s + r.implied_value_usd, 0);
  const tvls = rows.map((r) => r.tvl_usd).sort((a, b) => a - b);
  const median = tvls[Math.floor(tvls.length / 2)];
  const top = rows[0];
  const kpis = [
    { k: 'Protocols scanned', v: String(D.protocol_count), s: 'in the sealed snapshot' },
    { k: 'Watchlist (no token)', v: String(D.watchlist_size), s: `at or above ${fmtUSD(D.floor_usd)} TVL` },
    { k: 'Board rows', v: String(D.board_size), s: `${D.early_size} below the floor` },
    { k: 'Combined implied value', v: fmtUSD(total), s: 'if each launched at its multiple' },
    { k: 'Median board TVL', v: fmtUSD(median), s: 'half the board is smaller' },
    { k: 'Top of the board', v: top.name, s: `${fmtUSD(top.implied_value_usd)} implied`, top: true },
  ];
  $('kpis').innerHTML = kpis
    .map((x) => `<div class="kpi${x.top ? ' live-kpi' : ''}"><div class="k">${esc(x.k)}</div><div class="v">${esc(x.v)}</div><div class="s">${esc(x.s)}</div></div>`)
    .join('');
}

/* ------------------------------------------------------------------ model panel */
function renderModel() {
  const m = D.model;
  const terms = [
    { t: 'Scale — TVL sets the base', d: `A protocol's TVL is multiplied by <b>${m.base_multiple} × (TVL / ${fmtUSD(D.floor_usd)})^−${m.scale_alpha}</b>. The multiple falls as TVL rises, because a larger protocol supports a smaller token value per dollar locked.` },
    { t: 'Momentum — 7-day change', d: `Seven-day TVL growth, clamped to <b>${m.growth_floor}%…+${m.growth_cap}%</b>, becomes <b>1 + growth × ${m.growth_weight}</b>. Recent growth lifts the implied value; decay damps it.` },
    { t: 'Accrual — time with no token', d: `From <b>${m.accrual_floor}</b> up to <b>${(m.accrual_floor + (1 - m.accrual_floor)).toFixed(2)}</b> as a protocol ages toward <b>${m.accrual_days} days</b>. The longer it has run without a token, the more user value has gathered for a launch to monetise.` },
  ];
  $('terms').innerHTML = terms.map((x) => `<div class="term"><div class="t">${esc(x.t)}</div><div class="d">${x.d}</div></div>`).join('');
  $('modelNote').innerHTML =
    `<b>What this is not.</b> The model does not predict whether or when a token launches, and it never scores a protocol ` +
    `whose token already trades: those ${D.live_size} sit in the live-token view at the market's own capitalisation. ` +
    `Unknown age is treated as ${m.unknown_age_days} days; unknown growth as 0%.`;
}

/* ------------------------------------------------------------------ filters */
function uniqueCategories() {
  const set = new Set();
  for (const r of D.rows) if (r.category) set.add(r.category);
  return [...set].sort((a, b) => a.localeCompare(b));
}
function uniqueChains() {
  const set = new Set();
  for (const r of D.rows) for (const c of r.chains) set.add(c);
  return [...set].sort((a, b) => a.localeCompare(b));
}
function renderFilterOptions() {
  $('category').innerHTML = '<option value="">All categories</option>' + uniqueCategories().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('chain').innerHTML = '<option value="">All chains</option>' + uniqueChains().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

/* ------------------------------------------------------------------ board table */
const COLS = [
  { id: 'rank', label: '#', cls: 'num rank-col' },
  { id: 'name', label: 'Protocol' },
  { id: 'category', label: 'Category' },
  { id: 'chains', label: 'Chains' },
  { id: 'tvl', label: 'TVL', cls: 'num' },
  { id: 'growth', label: '7d', cls: 'num' },
  { id: 'age', label: 'No-token age', cls: 'num' },
  { id: 'implied', label: 'Implied launch value', cls: 'num' },
];

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let rows = D.rows.filter((r) => {
    if (state.category && r.category !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (q) {
      const hay = `${r.name} ${r.slug} ${r.category ?? ''} ${r.chains.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const dir = state.dir === 'asc' ? 1 : -1;
  const key = state.sort;
  rows = rows.slice().sort((a, b) => {
    let va; let vb;
    if (key === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); return va < vb ? -dir : va > vb ? dir : a.rank - b.rank; }
    if (key === 'growth') { va = a.change_7d ?? -999; vb = b.change_7d ?? -999; }
    else if (key === 'age') { va = a.age_days ?? -1; vb = b.age_days ?? -1; }
    else if (key === 'tvl') { va = a.tvl_usd; vb = b.tvl_usd; }
    else { va = a.implied_value_usd; vb = b.implied_value_usd; }
    return (va - vb) * dir || a.rank - b.rank;
  });
  return rows;
}

function chainChips(chains) {
  const shown = chains.slice(0, 2).map((c) => `<span class="chain">${esc(c)}</span>`);
  if (chains.length > 2) shown.push(`<span class="chain more">+${chains.length - 2}</span>`);
  return `<div class="chains">${shown.join('')}</div>`;
}

function renderBoard() {
  const rows = visibleRows();
  const max = Math.max(...D.rows.map((r) => r.implied_value_usd), 1);
  const watch = new Set();
  // The watchlist is named by the snapshot; rows below the floor are the early radar.
  for (const r of D.rows) if (r.tvl_usd >= D.floor_usd) watch.add(r.slug);

  $('boardTitle').textContent = state.view === 'live' ? 'Live tokens — already trading' : 'The board — pre-token, ranked by implied launch value';
  $('boardCount').textContent = state.view === 'live'
    ? `${rows.length} of ${D.live_size} live-token protocols, at the market's own capitalisation. Not part of the ranking.`
    : `${rows.length} of ${D.board_size} pre-token protocols. Amber edge = on the watchlist; blue tag = below the floor (early radar).`;

  if (state.view === 'live') { renderLive(rows.length); return; }

  $('boardHead').innerHTML = COLS.map((c) => {
    const active = state.sort === c.id;
    const arr = active ? `<span class="arr">${state.dir === 'desc' ? '↓' : '↑'}</span>` : '';
    return `<th class="${c.cls || ''}" data-sort="${c.id}" scope="col">${esc(c.label)}${arr}</th>`;
  }).join('');

  $('boardBody').innerHTML = rows.map((r) => {
    const pct = Math.max(4, Math.round((r.implied_value_usd / max) * 100));
    const tag = watch.has(r.slug) ? '<span class="wl-tag">watchlist</span>' : '<span class="early-tag">early</span>';
    return `<tr class="${r.rank <= 3 ? 'top' : ''} ${watch.has(r.slug) ? 'is-watchlist' : ''}" data-slug="${esc(r.slug)}" tabindex="0">
      <td class="num rank">${r.rank}</td>
      <td><div class="pname"><span class="n">${esc(r.name)}${tag}</span><span class="slug">${esc(r.slug)}</span></div></td>
      <td>${r.category ? `<span class="cat">${esc(r.category)}</span>` : '<span class="cat none">uncategorised</span>'}</td>
      <td>${chainChips(r.chains)}</td>
      <td class="num tvl">${fmtUSD(r.tvl_usd)}</td>
      <td class="num"><span class="delta ${deltaClass(r.change_7d)}">${deltaArrow(r.change_7d)} ${fmtPct(r.change_7d)}</span></td>
      <td class="num age">${fmtAge(r.age_days)}</td>
      <td class="num bar"><span class="imp"><span class="cur">${fmtUSD(r.implied_value_usd)}</span></span><span class="fill" style="width:${pct}%"></span></td>
    </tr>`;
  }).join('');
  $('boardEmpty').hidden = rows.length !== 0;
  $('boardTable').style.display = rows.length ? '' : 'none';
}

function renderLive(shown) {
  const live = D.live.filter((r) => {
    if (state.category && r.category !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.q.trim()) {
      const hay = `${r.name} ${r.slug} ${r.category ?? ''} ${r.chains.join(' ')}`.toLowerCase();
      if (!hay.includes(state.q.trim().toLowerCase())) return false;
    }
    return true;
  });
  $('boardHead').innerHTML = '<tr><th>#</th><th>Protocol</th><th>Category</th><th>Chains</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">MCap / TVL</th><th class="num">7d</th></tr>';
  $('boardBody').innerHTML = live.map((r, i) => {
    const ratio = r.mcap_usd && r.tvl_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) : '—';
    return `<tr data-slug="${esc(r.slug)}" tabindex="0">
      <td class="num rank">${i + 1}</td>
      <td><div class="pname"><span class="n">${esc(r.name)}</span><span class="slug">${esc(r.slug)}</span></div></td>
      <td>${r.category ? `<span class="cat">${esc(r.category)}</span>` : '<span class="cat none">uncategorised</span>'}</td>
      <td>${chainChips(r.chains)}</td>
      <td class="num tvl">${fmtUSD(r.tvl_usd)}</td>
      <td class="num mcap">${fmtUSD(r.mcap_usd)}</td>
      <td class="num ratio">${ratio}×</td>
      <td class="num"><span class="delta ${deltaClass(r.change_7d)}">${deltaArrow(r.change_7d)} ${fmtPct(r.change_7d)}</span></td>
    </tr>`;
  }).join('');
  $('boardEmpty').hidden = live.length !== 0;
  $('boardTable').style.display = live.length ? '' : 'none';
}

/* ------------------------------------------------------------------ detail drawer */
function openDetail(slug) {
  const r = D.rows.find((x) => x.slug === slug);
  if (!r) return;
  state.detail = slug;
  const watch = r.tvl_usd >= D.floor_usd;
  const base = r.tvl_usd * r.tvl_multiple;
  const afterMom = base * r.growth_multiplier;
  const implied = r.implied_value_usd;
  const bridge = [
    { l: 'TVL scale base', v: base, f: 'base', note: `${fmtUSD(r.tvl_usd)} × ${r.tvl_multiple.toFixed(3)}` },
    { l: '× momentum (7d)', v: afterMom, f: 'mom', note: `× ${r.growth_multiplier.toFixed(3)} on ${fmtPct(r.change_7d)}` },
    { l: '× accrual (age)', v: implied, f: 'acc', note: `× ${r.accrual_multiplier.toFixed(3)} on ${fmtAge(r.age_days)}` },
  ];
  const maxB = Math.max(base, afterMom, implied, 1);
  const steps = (r.plan || []).map((s, i) => `<li><div class="ptext">${esc(s.text)}</div><div class="ptags"><span class="ptag cost">cost ${esc(s.cost)}</span><span class="ptag time">${esc(s.time)}</span></div></li>`).join('');

  $('drawer').innerHTML = `
    <div class="drawer-head">
      <div class="dh-text">
        <h2>${esc(r.name)}</h2>
        <div class="dh-slug">${esc(r.slug)}</div>
        <div class="dh-badges">
          ${watch ? '<span class="wl-tag">watchlist</span>' : '<span class="early-tag">early radar</span>'}
          ${r.category ? `<span class="cat">${esc(r.category)}</span>` : '<span class="cat none">uncategorised</span>'}
          <span class="chip">rank <b>#${r.rank}</b></span>
        </div>
      </div>
      <button class="drawer-close" id="drawerClose" aria-label="Close detail">×</button>
    </div>
    <div class="dhero">
      <div class="k">Implied launch value</div>
      <div class="v"><span class="cur">${fmtUSD(implied)}</span></div>
      <div class="sub">What this protocol's token would be worth at launch if its record stayed as it is.</div>
    </div>
    <div class="dsec">
      <h3>How that value is built</h3>
      <div class="bridge">
        ${bridge.map((b) => `<div class="brow"><div class="bl">${esc(b.l)}</div><div class="btrack"><span class="bfill ${b.f}" style="width:${Math.max(5, Math.round((b.v / maxB) * 100))}%"></span></div><div class="bv">${fmtUSD(b.v)}</div></div>`).join('')}
      </div>
      <p class="bnote">${esc(bridge.map((b) => b.note).join('  ·  '))}</p>
    </div>
    <div class="dsec">
      <h3>The protocol's own record</h3>
      <div class="facts">
        <div class="fact"><div class="k">TVL</div><div class="v">${fmtUSD(r.tvl_usd)}</div></div>
        <div class="fact"><div class="k">7-day change</div><div class="v">${fmtPct(r.change_7d)}</div></div>
        <div class="fact"><div class="k">Listed on DefiLlama</div><div class="v">${r.listed_at ?? 'unknown'}</div></div>
        <div class="fact"><div class="k">Age with no token</div><div class="v">${fmtAge(r.age_days)}</div></div>
        <div class="fact"><div class="k">TVL multiple</div><div class="v">${r.tvl_multiple.toFixed(3)}×</div></div>
        <div class="fact"><div class="k">Chains</div><div class="v" style="font-size:13px">${esc(r.chains.join(', ') || '—')}</div></div>
      </div>
    </div>
    <div class="dsec">
      <h3>How to farm it</h3>
      <ol class="plan">${steps}</ol>
    </div>
    <p class="caveat">This protocol <b>records no token</b> in the snapshot — it may still have one the record does not carry. The plan is general guidance from its category, chains and size, not financial advice; verify costs on the chain before you commit capital.</p>
  `;
  $('drawer').hidden = false;
  $('scrim').hidden = false;
  document.body.style.overflow = 'hidden';
  $('drawerClose').addEventListener('click', closeDetail);
  $('drawer').scrollTop = 0;
}

function closeDetail() {
  state.detail = null;
  $('drawer').hidden = true;
  $('scrim').hidden = true;
  document.body.style.overflow = '';
  writeHash();
}

/* ------------------------------------------------------------------ url state */
function writeHash() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (state.chain) p.set('chain', state.chain);
  if (state.sort !== 'rank') p.set('sort', state.sort);
  if (state.dir !== 'desc') p.set('dir', state.dir);
  if (state.view !== 'pre') p.set('view', state.view);
  if (state.detail) p.set('detail', state.detail);
  const s = p.toString();
  history.replaceState(null, '', s ? `#${s}` : '#');
}
function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  state.q = p.get('q') ?? '';
  state.category = p.get('category') ?? '';
  state.chain = p.get('chain') ?? '';
  state.sort = p.get('sort') ?? 'rank';
  state.dir = p.get('dir') ?? 'desc';
  state.view = p.get('view') === 'live' ? 'live' : 'pre';
  state.detail = p.get('detail');
}

/* ------------------------------------------------------------------ wire up */
function bind() {
  $('search').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); writeHash(); });
  $('category').addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); writeHash(); });
  $('chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); writeHash(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderBoard(); writeHash(); });
  $('dir').addEventListener('change', (e) => { state.dir = e.target.value; renderBoard(); writeHash(); });
  $('boardHead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sort === key) state.dir = state.dir === 'desc' ? 'asc' : 'desc';
    else { state.sort = key; state.dir = key === 'name' ? 'asc' : 'desc'; }
    $('sort').value = state.sort;
    $('dir').value = state.dir;
    renderBoard(); writeHash();
  });
  $('boardBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  $('boardBody').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr[data-slug]');
    if (tr) { e.preventDefault(); openDetail(tr.dataset.slug); }
  });
  $('tabPre').addEventListener('click', () => setView('pre'));
  $('tabLive').addEventListener('click', () => setView('live'));
  $('scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.detail) closeDetail(); });
}
function setView(v) {
  state.view = v;
  $('tabPre').classList.toggle('is-active', v === 'pre');
  $('tabLive').classList.toggle('is-active', v === 'live');
  $('tabPre').setAttribute('aria-selected', String(v === 'pre'));
  $('tabLive').setAttribute('aria-selected', String(v === 'live'));
  renderBoard(); writeHash();
}

/* ------------------------------------------------------------------ boot */
readHash();
renderHeader();
renderKpis();
renderModel();
renderFilterOptions();
$('search').value = state.q;
$('category').value = state.category;
$('chain').value = state.chain;
$('sort').value = state.sort;
$('dir').value = state.dir;
if (state.view === 'live') { $('tabPre').classList.remove('is-active'); $('tabLive').classList.add('is-active'); }
bind();
renderBoard();
if (state.detail) openDetail(state.detail);
