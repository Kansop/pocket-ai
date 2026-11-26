import { webkit, devices } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('../..', import.meta.url)); // pocket-ai repo root
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const path = join(root, normalize(rel).replace(/^\/+/, ''));
    if (!path.startsWith(root) || !existsSync(path) || statSync(path).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const cases = JSON.parse(process.env.CASES || '[]');
const expectedCount = Number(process.env.TOPIC_COUNT || '0');
const base = process.env.BASE_URL || '';
const port = Number(process.env.PORT || '8765');

const samples = cases.length ? cases : [
  ['how do i start my homework', 'Starting homework'],
  ['what is a ps5', 'PlayStation 5'],
  ['variable', 'Variables'],
  ['how do i remember what i study', 'Remembering what you study'],
  ['what is a percentage', 'Percent of a number'],
  ['using a checklist', 'Using a checklist'],
  ['how do i solve for x', 'Solving for x'],
  ['what is dna', 'DNA'],
  ['what is the pythagorean theorem', 'The Pythagorean theorem'],
  ['what is the greenhouse effect', 'The greenhouse effect'],
  ['how do i calculate percent change', 'Percent change'],
  ['what should i do during an earthquake', 'Earthquakes'],
];

let server;
const url = base || `http://127.0.0.1:${port}/pocket-assistant/winter/`;
if (!base) server = await serve(port);

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 15'] });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

const res = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
console.log('status', res && res.status(), 'url', page.url());
await page.waitForFunction(() => window.__assistantReady === true, null, { timeout: 20000 });
const info = await page.evaluate(() => ({ ready: window.__assistantReady, count: window.__topicCount, err: window.__assistantError || null }));
console.log('ready', JSON.stringify(info));
if (expectedCount && info.count !== expectedCount) {
  errs.push(`topic count ${info.count} != ${expectedCount}`);
}

let pass = 0, fail = 0;
for (const [q, title] of samples) {
  const got = await page.evaluate((question) => {
    const i = window.__classify(question);
    if (i < 0) return { i, title: null, desc: null };
    const t = model.topics[i];
    return { i, title: t.title, desc: t.desc };
  }, q);
  const ok = got.title === title;
  if (ok) pass++; else fail++;
  console.log(ok ? 'OK' : 'FAIL', JSON.stringify({ q, expected: title, got }));
}

// Also type one question through the UI
await page.fill('#q', 'what is dna');
await page.click('#chat button[type=submit]');
await page.waitForTimeout(300);
const ui = await page.evaluate(() => {
  const card = document.querySelector('#history article:last-of-type');
  return card ? { h2: card.querySelector('h2')?.textContent, p: card.querySelector('p')?.textContent, q: card.querySelector('small')?.textContent } : null;
});
console.log('ui', JSON.stringify(ui));
if (ui?.h2 !== 'DNA') { fail++; errs.push('UI did not show DNA'); } else pass++;

console.log('errors:', errs.join('\n  ') || 'none');
console.log(`results pass=${pass} fail=${fail}`);
await browser.close();
if (server) server.close();
if (fail || errs.length || !info.ready) process.exit(1);
