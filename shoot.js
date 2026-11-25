// Screenshot the Token Radar dashboard at 1440x900, one fresh page per shot so the
// URL hash is really re-read, and report what actually rendered.
const puppeteer = require('/data/agent/node_modules/puppeteer-core');
const fs = require('fs');

const BASE = 'file:///data/agent/radar/dashboard/index.html';
const OUT = '/data/agent/radar/shots';
fs.mkdirSync(OUT, { recursive: true });

const shots = [
  ['1-board.png', BASE],
  ['2-detail.png', `${BASE}#detail=steakhouse-financial`],
  ['3-filtered.png', `${BASE}#category=Risk%20Curators&sort=tvl&dir=desc`],
];

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
  for (const [name, url] of shots) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await new Promise((r) => setTimeout(r, 500));
    const info = await page.evaluate(() => ({
      title: document.title,
      hasRadar: !!window.RADAR,
      rows: window.RADAR ? window.RADAR.rows.length : 0,
      rendered: document.querySelectorAll('#boardBody tr').length,
      kpis: document.querySelectorAll('.kpi').length,
      drawerOpen: !document.getElementById('drawer').hidden,
      drawerName: document.querySelector('.drawer-head h2') ? document.querySelector('.drawer-head h2').textContent : null,
      boardTitle: document.getElementById('boardTitle').textContent,
      firstRow: document.querySelector('#boardBody tr') ? document.querySelector('#boardBody tr').textContent.replace(/\s+/g, ' ').slice(0, 120) : null,
      bodyChildren: document.body.children.length,
    }));
    await page.screenshot({ path: `${OUT}/${name}`, type: 'png' });
    const kb = Math.round(fs.statSync(`${OUT}/${name}`).size / 1024);
    console.log(`${name}: ${kb} KB | rendered=${info.rendered} kpis=${info.kpis} drawer=${info.drawerOpen} title="${info.boardTitle}"`);
    console.log(`   hasRadar=${info.hasRadar} rows=${info.rows} first="${info.firstRow}"`);
    if (errs.length) console.log('   CONSOLE ERRORS:', errs.slice(0, 3).join(' | '));
    await page.close();
  }
  browser.disconnect();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
