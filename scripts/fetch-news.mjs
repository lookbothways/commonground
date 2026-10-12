// Fetches world news from AP, BBC and the Guardian into news.json.
// Run by .github/workflows/news.yml every 30 minutes.
import { load } from 'cheerio';
import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'news.json';
const PER_SOURCE = 25;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const meta = ($, p) => $(`meta[property="${p}"], meta[name="${p}"]`).attr('content') || '';
const iso = d => { const t = new Date(d); return isNaN(t) ? '' : t.toISOString(); };

async function get(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'en-GB,en;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { console.warn('  skip:', e.message); }
    }
  }));
  return out.filter(Boolean);
}

function paras($, selectors) {
  for (const s of selectors) {
    const p = $(s).map((_, e) => clean($(e).text())).get().filter(t => t.length > 30);
    if (p.length) return p.slice(0, 60);
  }
  return [];
}

// Previous run, so article pages already fetched aren't fetched again
let prevRaw = '[]';
const prev = {};
try {
  const old = JSON.parse(await readFile(OUT, 'utf8'));
  prevRaw = JSON.stringify(old.articles || []);
  for (const a of old.articles || []) prev[a.url] = a;
} catch {}

async function article(url, source, selectors, hint = {}) {
  if (prev[url]?.body?.length) return prev[url];
  const $ = load(await get(url));
  const body = paras($, selectors);
  if (!body.length) return null;
  return {
    source, url,
    title: clean(hint.title || meta($, 'og:title') || $('h1').first().text()).replace(/\s+[-|]\s+(AP News|BBC News)$/, ''),
    summary: clean(hint.summary || meta($, 'og:description')),
    image: meta($, 'og:image'),
    date: hint.date || iso(meta($, 'article:published_time')),
    body,
  };
}

async function ap() {
  const $ = load(await get('https://apnews.com/world-news'));
  const links = [...new Set($('a[href*="/article/"]').map((_, a) => $(a).attr('href')).get()
    .map(h => new URL(h, 'https://apnews.com').href.split(/[?#]/)[0]))].slice(0, PER_SOURCE);
  return pool(links, 5, url => article(url, 'AP', ['.RichTextStoryBody p', '.RichTextBody p', 'article p']));
}

async function bbc() {
  const $ = load(await get('https://feeds.bbci.co.uk/news/world/rss.xml'), { xmlMode: true });
  const items = $('item').map((_, it) => {
    const $it = $(it);
    return {
      url: clean($it.find('link').text()).split('?')[0],
      title: clean($it.find('title').text()),
      summary: clean($it.find('description').text()),
      date: iso($it.find('pubDate').text()),
    };
  }).get()
    .filter(i => /bbc\.co(\.uk|m)\/news\/(articles|world)/.test(i.url) && !/\/(live|videos)\//.test(i.url))
    .slice(0, PER_SOURCE);
  return pool(items, 5, i => article(i.url, 'BBC', ['[data-component="text-block"] p', 'article p'], i));
}

async function guardian() {
  const key = process.env.GUARDIAN_KEY || 'test';
  const url = 'https://content.guardianapis.com/search?section=world&type=article&order-by=newest'
    + `&page-size=${PER_SOURCE}&show-fields=headline,trailText,thumbnail,body&api-key=${key}`;
  const j = JSON.parse(await get(url));
  return j.response.results.map(r => {
    const f = r.fields || {};
    const $ = load(f.body || '');
    return {
      source: 'Guardian',
      url: r.webUrl,
      title: clean(f.headline || r.webTitle),
      summary: clean(load(f.trailText || '').text()),
      image: f.thumbnail || '',
      date: r.webPublicationDate,
      body: $('p').map((_, p) => clean($(p).text())).get().filter(t => t.length > 30).slice(0, 60),
    };
  }).filter(a => a.body.length);
}

const articles = [];
for (const [name, fn] of Object.entries({ AP: ap, BBC: bbc, Guardian: guardian })) {
  let got = [];
  try { got = await fn(); } catch (e) { console.warn(name, 'failed:', e.message); }
  if (!got.length) got = Object.values(prev).filter(a => a.source === name); // keep last good set
  console.log(name, got.length);
  articles.push(...got);
}

if (JSON.stringify(articles) === prevRaw) {
  console.log('No changes');
} else {
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), articles }));
  console.log('Wrote', articles.length, 'articles');
}
