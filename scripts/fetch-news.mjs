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
const status = {}; // per-source notes, written into news.json for debugging

async function get(url) {
  const r = await fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-GB,en;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  const errs = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { errs.push(e.message); }
    }
  }));
  if (errs.length) console.warn(`  ${errs.length} article fetches failed, e.g. ${errs[0]}`);
  return out.filter(Boolean);
}

// The page's JSON-LD article object, if any
function ld($) {
  for (const s of $('script[type="application/ld+json"]').get()) {
    try {
      const j = JSON.parse($(s).text());
      for (const o of [j, ...(Array.isArray(j) ? j : j['@graph'] || [])]) {
        if (o?.articleBody || o?.datePublished) return o;
      }
    } catch {}
  }
  return {};
}

// Body text: try CSS selectors, then the JSON-LD articleBody
function paras($, selectors, j) {
  for (const s of selectors) {
    const p = $(s).map((_, e) => clean($(e).text())).get().filter(t => t.length > 30);
    if (p.length) return p.slice(0, 60);
  }
  return (j.articleBody || '').split(/\n+/).map(clean).filter(t => t.length > 30).slice(0, 60);
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
  const j = ld($);
  const body = paras($, selectors, j);
  if (!body.length) throw new Error(`no body text ${url}`);
  return {
    source, url,
    title: clean(hint.title || meta($, 'og:title') || $('h1').first().text()).replace(/\s+[-|]\s+(AP News|BBC News|The Guardian)$/, ''),
    summary: clean(hint.summary || meta($, 'og:description')),
    image: hint.image || meta($, 'og:image'),
    date: hint.date || iso(meta($, 'article:published_time') || j.datePublished),
    body,
  };
}

function rss(xml) {
  const $ = load(xml, { xmlMode: true });
  return $('item').map((_, it) => {
    const $it = $(it);
    const imgs = $it.find('media\\:content, media\\:thumbnail').map((_, m) => ({ url: $(m).attr('url'), w: +$(m).attr('width') || 0 })).get();
    imgs.sort((a, b) => b.w - a.w);
    return {
      url: clean($it.find('link').first().text()).split('?')[0],
      title: clean($it.find('title').first().text()),
      summary: clean(load($it.find('description').first().text()).text()).replace(/\s*Continue reading\.*$/, ''),
      date: iso($it.find('pubDate').first().text()),
      image: imgs[0]?.url || '',
    };
  }).get();
}

async function ap() {
  const sel = ['.RichTextStoryBody p', '.RichTextBody p', '.Article p', 'article p'];
  let links = [];
  for (const page of ['https://apnews.com/world-news', 'https://apnews.com/hub/world-news']) {
    try {
      const $ = load(await get(page));
      links = [...new Set($('a[href*="/article/"]').map((_, a) => $(a).attr('href')).get()
        .map(h => new URL(h, 'https://apnews.com').href.split(/[?#]/)[0]))].slice(0, PER_SOURCE);
      status.AP = `${links.length} links from ${page}`;
      if (links.length) break;
    } catch (e) { status.AP = e.message; }
  }
  return pool(links, 5, url => article(url, 'AP', sel));
}

async function bbc() {
  const items = rss(await get('https://feeds.bbci.co.uk/news/world/rss.xml'))
    .filter(i => /bbc\.co(\.uk|m)\/news\/(articles|world)/.test(i.url) && !/\/(live|videos)\//.test(i.url))
    .slice(0, PER_SOURCE);
  status.BBC = `${items.length} feed items`;
  return pool(items, 5, i => article(i.url, 'BBC', ['[data-component="text-block"] p', 'article p'], { ...i, image: '' }));
}

async function guardianApi() {
  const key = process.env.GUARDIAN_KEY || 'test';
  const url = 'https://content.guardianapis.com/search?section=world&type=article&order-by=newest'
    + `&page-size=${PER_SOURCE}&show-fields=headline,trailText,thumbnail,body&api-key=${key}`;
  const j = JSON.parse(await get(url));
  return (j.response?.results || []).map(r => {
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

async function guardianRss() {
  const items = rss(await get('https://www.theguardian.com/world/rss'))
    .filter(i => !/\/(live|video|gallery|audio)\//.test(i.url))
    .slice(0, PER_SOURCE);
  return pool(items, 5, i => article(i.url, 'Guardian',
    ['[data-gu-name="body"] p', '#maincontent p', '.article-body-commercial-selector p', 'article p'], i));
}

async function guardian() {
  try {
    const got = await guardianApi();
    status.Guardian = `${got.length} from API`;
    if (got.length) return got;
  } catch (e) { status.Guardian = 'API: ' + e.message.replace(/api-key=[^&\s]+/, 'api-key=***'); }
  const got = await guardianRss();
  status.Guardian += ` · ${got.length} from RSS`;
  return got;
}

const articles = [];
for (const [name, fn] of Object.entries({ AP: ap, BBC: bbc, Guardian: guardian })) {
  let got = [];
  try { got = await fn(); } catch (e) { status[name] = (status[name] ? status[name] + ' · ' : '') + e.message; }
  if (!got.length) {
    got = Object.values(prev).filter(a => a.source === name); // keep last good set
    status[name] = (status[name] || '') + ` · kept ${got.length} from last run`;
  }
  console.log(name, got.length, '|', status[name]);
  articles.push(...got);
}

if (JSON.stringify(articles) === prevRaw) {
  console.log('No changes');
} else {
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), status, articles }));
  console.log('Wrote', articles.length, 'articles');
}
