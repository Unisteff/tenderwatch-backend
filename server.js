import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DEFAULT_KEYWORDS = [
  'digital examination','e-eksamen','eksamenssystem','digital eksamensplatform',
  'online examination','exam management system','assessment platform',
  'proctoring','remote proctoring','AI proctoring',
  'item banking','item bank','question authoring',
  'plagiarism detection','academic integrity',
  'e-assessment','summative assessment','formative assessment',
  'LMS integration','learning management system',
  'higher education','videregaende uddannelse','hogskole',
  'university','profesjonshojskole',
  'SaaS','software as a service',
  'rammeaftale','rammeavtale','framework agreement',
  'IT-system','IT-losning','licens'
];

const CPV_CODES = ['48190000','48000000','72000000','80000000','48900000'];

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'TenderWatch/1.0' },
    ...opts
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.json();
}

async function scoreWithClaude(notices, source, keywords) {
  if (!notices.length) return [];
  const kws = (keywords || DEFAULT_KEYWORDS).slice(0, 14).join(', ');
  const prompt = `You are a tender analyst for UNIwise (WISEflow digital examination SaaS for higher education).
Analyse these procurement notices and return ONLY a JSON array. Each item:
- id: string
- title: clean English title max 120 chars (translate if needed)
- org: contracting authority
- country: 2-letter ISO code
- deadline: YYYY-MM-DD or "unknown"
- published: YYYY-MM-DD or "unknown"
- value: string e.g. "NOK 8.5M" or "N/A"
- url: direct link or ""
- keywords: 1-3 best tags from: [${kws}]
- relevance: "high"|"medium"|"low" for WISEflow fit
- isNew: true if published within last 7 days
- source: "${source}"
- isLive: true
Only include high or medium. Return ONLY the JSON array, no markdown.
Notices: ${JSON.stringify(notices)}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });
  const raw = msg.content[0].text.trim().replace(/```json|```/g, '');
  return JSON.parse(raw);
}

async function playwrightScrape({ url, searchTerms, extractFromResponse, extractFromDom, label }) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-GB,en;q=0.9,no;q=0.8,da;q=0.7'
  });
  const page = await ctx.newPage();
  const intercepted = [];

  page.on('response', async response => {
    const u = response.url();
    if (!u.includes('/api/') && !u.includes('/search') && !u.includes('notices') && !u.includes('query')) return;
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const body = await response.json();
      const items = extractFromResponse(body, u);
      if (items && items.length) intercepted.push(...items);
    } catch (e) {}
  });

  const allDomResults = [];
  for (const term of searchTerms) {
    const pageUrl = typeof url === 'function' ? url(term) : url;
    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 25000 });
      await page.waitForTimeout(2000);
      const domItems = await page.evaluate(extractFromDom);
      if (domItems && domItems.length) allDomResults.push(...domItems);
    } catch (e) {
      console.warn('[' + label + '] failed for "' + term + '": ' + e.message);
    }
  }

  await browser.close();
  const seen = new Set();
  const merged = [];
  for (const item of [...intercepted, ...allDomResults]) {
    const key = (item.title || '').toLowerCase().slice(0, 60);
    if (key && !seen.has(key)) { seen.add(key); merged.push(item); }
  }
  return merged;
}

async function fetchDoffinBelowThreshold(keywords) {
  const terms = (keywords || DEFAULT_KEYWORDS)
    .filter(k => k.split(' ').length <= 3).slice(0, 4);
  const raw = await playwrightScrape({
    label: 'Doffin',
    url: term => 'https://doffin.no/search?q=' + encodeURIComponent(term) + '&noticeType=NATIONAL',
    searchTerms: terms,
    extractFromResponse: (body) => {
      const list = body && (body.notices || body.results || body.data || (Array.isArray(body) ? body : null));
      if (!list || !list.length) return [];
      return list.map(n => ({
        id: n.noticeId || n.id || String(Math.random()).slice(2,10),
        title: n.title || n.noticeName || n.subject || n.tittel || '',
        org: (n.contractingAuthority && n.contractingAuthority.name) || (n.buyer && n.buyer.name) || n.publisherName || '',
        country: 'NO',
        deadline: n.deadlineForSubmission || n.submissionDeadline || n.frist || 'unknown',
        published: n.publicationDate || n.publishedDate || 'unknown',
        value: n.estimatedValue ? 'NOK ' + (n.estimatedValue/1000000).toFixed(1) + 'M' : 'N/A',
        url: n.noticeId ? 'https://doffin.no/notices/' + n.noticeId : (n.id ? 'https://doffin.no/notices/' + n.id : '')
      })).filter(n => n.title);
    },
    extractFromDom: () => {
      const cards = Array.from(document.querySelectorAll('[data-notice-id],.notice-card,.notice-item,.search-result-item'));
      return cards.slice(0,15).map(el => {
        const title = (el.querySelector('h1,h2,h3,.title,.notice-title') || {}).textContent || '';
        const org = (el.querySelector('.authority,.buyer,.organisation') || {}).textContent || '';
        const deadline = ((el.querySelector('[data-deadline],.deadline,time') || {}).getAttribute && el.querySelector('[data-deadline],.deadline,time').getAttribute('datetime')) || '';
        const href = ((el.querySelector('a') || {}).href) || '';
        const id = el.dataset.noticeId || href.split('/').pop() || Math.random().toString(36).slice(2,10);
        if (!title.trim()) return null;
        return { id, title: title.trim(), org: org.trim(), country: 'NO', deadline, published: 'unknown', value: 'N/A', url: href };
      }).filter(Boolean);
    }
  });
  if (!raw.length) return [];
  return scoreWithClaude(raw, 'doffin', keywords);
}

async function fetchUdbudBelowThreshold(keywords) {
  const terms = (keywords || DEFAULT_KEYWORDS)
    .filter(k => k.split(' ').length <= 3).slice(0, 4);
  const raw = await playwrightScrape({
    label: 'udbud',
    url: term => 'https://udbud.dk/find-udbud?q=' + encodeURIComponent(term) + '&type=national',
    searchTerms: terms,
    extractFromResponse: (body) => {
      const list = body && (body.notices || body.content || body.items || body.results || (Array.isArray(body) ? body : null));
      if (!list || !list.length) return [];
      return list.map(n => ({
        id: n.id || n.noticeId || String(Math.random()).slice(2,10),
        title: n.title || n.subject || n.titel || '',
        org: (n.contractingAuthority && n.contractingAuthority.name) || n.buyer || n.ordregiver || '',
        country: 'DK',
        deadline: n.deadline || n.submissionDeadline || n.frist || 'unknown',
        published: n.publicationDate || n.publishedDate || 'unknown',
        value: n.estimatedValue ? 'DKK ' + (n.estimatedValue/1000000).toFixed(1) + 'M' : 'N/A',
        url: n.id ? 'https://udbud.dk/find-udbud/' + n.id : ''
      })).filter(n => n.title);
    },
    extractFromDom: () => {
      const cards = Array.from(document.querySelectorAll('[data-notice-id],.notice-card,.tender-card,.result-item'));
      return cards.slice(0,15).map(el => {
        const title = (el.querySelector('h1,h2,h3,.title,.notice-title') || {}).textContent || '';
        const org = (el.querySelector('.authority,.buyer,.organisation,.ordregiver') || {}).textContent || '';
        const deadline = ((el.querySelector('time[datetime],.deadline') || {}).getAttribute && el.querySelector('time[datetime],.deadline').getAttribute('datetime')) || '';
        const href = ((el.querySelector('a') || {}).href) || '';
        const id = el.dataset.noticeId || href.split('/').pop() || Math.random().toString(36).slice(2,10);
        if (!title.trim()) return null;
        return { id, title: title.trim(), org: org.trim(), country: 'DK', deadline, published: 'unknown', value: 'N/A', url: href };
      }).filter(Boolean);
    }
  });
  if (!raw.length) return [];
  return scoreWithClaude(raw, 'udbud', keywords);
}

async function fetchTED(countryFilter, keywords) {
  const kws = (keywords || DEFAULT_KEYWORDS).filter(k => k.split(' ').length <= 3).slice(0, 8);
  const kwQuery = kws.map(k => 'TD="' + k + '"').join(' OR ');
  const cpvQuery = CPV_CODES.map(c => 'CPV=' + c).join(' OR ');
  const country = countryFilter ? ' AND CY=' + countryFilter : '';
  const data = await fetchJson('https://api.ted.europa.eu/v3/notices/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '(' + kwQuery + ' OR ' + cpvQuery + ')' + country,
      fields: ['ND','TI','CY','CA-NAME','PC','DT','RD','DI'],
      page: 1, limit: 25, scope: 'ACTIVE', paginationMode: 'PAGE_NUMBER'
    })
  });
  const raw = (data.results || []).map(r => ({
    id: r.ND && r.ND[0] || '',
    title: (r.TI && r.TI[0]) || (r['TI-EN'] && r['TI-EN'][0]) || '',
    org: r['CA-NAME'] && r['CA-NAME'][0] || '',
    country: r.CY && r.CY[0] || countryFilter || '',
    deadline: r.DT && r.DT[0] || 'unknown',
    published: r.RD && r.RD[0] || 'unknown',
    value: r.DI && r.DI[0] || 'N/A',
    url: r.ND && r.ND[0] ? 'https://ted.europa.eu/en/notice/' + r.ND[0] + '/html' : ''
  }));
  const src = countryFilter === 'NO' ? 'doffin' : countryFilter === 'DK' ? 'udbud' : 'ted';
  return scoreWithClaude(raw, src, keywords);
}

async function fetchFindATender(keywords) {
  const from = daysAgo(60).replace(/-/g,'/');
  const to = new Date().toISOString().split('T')[0].replace(/-/g,'/');
  const data = await fetchJson(
    'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?publishedFrom=' + from + '&publishedTo=' + to + '&stages=active&cpvCodes=' + CPV_CODES.join(',')
  );
  const raw = (data.releases || []).slice(0,25).map(r => {
    const tender = r.tender || {};
    const buyer = (r.parties || []).find(p => p.roles && p.roles.includes('buyer'));
    return {
      id: r.id || '',
      title: tender.title || '',
      org: (buyer && buyer.name) || '',
      country: 'GB',
      deadline: (tender.tenderPeriod && tender.tenderPeriod.endDate && tender.tenderPeriod.endDate.split('T')[0]) || 'unknown',
      published: (r.date && r.date.split('T')[0]) || 'unknown',
      value: (tender.value && tender.value.amount) ? 'GBP ' + (tender.value.amount/1000000).toFixed(2) + 'M' : 'N/A',
      url: r.id ? 'https://www.find-tender.service.gov.uk/Notice/' + r.id : ''
    };
  });
  return scoreWithClaude(raw, 'fat', keywords);
}

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.post('/search', async (req, res) => {
  const sources = req.body.sources || ['ted','doffin','udbud','fat'];
  const keywords = req.body.keywords || DEFAULT_KEYWORDS;
  const results = { ted:[], doffin:[], udbud:[], fat:[] };
  const errors = {};

  console.log('[search] sources=' + sources.join(','));

  await Promise.allSettled([
    sources.includes('ted') && fetchTED(null, keywords)
      .then(r => { results.ted = r; console.log('[TED] ' + r.length); })
      .catch(e => { errors.ted = e.message; console.error('[TED]', e.message); }),

    sources.includes('doffin') && Promise.all([fetchTED('NO', keywords), fetchDoffinBelowThreshold(keywords)])
      .then(([above, below]) => {
        const seen = new Set(above.map(t => t.id));
        results.doffin = [...above, ...below.filter(t => !seen.has(t.id))];
        console.log('[Doffin] ' + results.doffin.length);
      })
      .catch(e => { errors.doffin = e.message; console.error('[Doffin]', e.message); }),

    sources.includes('udbud') && Promise.all([fetchTED('DK', keywords), fetchUdbudBelowThreshold(keywords)])
      .then(([above, below]) => {
        const seen = new Set(above.map(t => t.id));
        results.udbud = [...above, ...below.filter(t => !seen.has(t.id))];
        console.log('[udbud] ' + results.udbud.length);
      })
      .catch(e => { errors.udbud = e.message; console.error('[udbud]', e.message); }),

    sources.includes('fat') && fetchFindATender(keywords)
      .then(r => { results.fat = r; console.log('[FAT] ' + r.length); })
      .catch(e => { errors.fat = e.message; console.error('[FAT]', e.message); })
  ]);

  res.json({ results, errors, fetchedAt: new Date().toISOString() });
});

app.get('/search/:source', async (req, res) => {
  const { source } = req.params;
  const keywords = req.query.keywords ? req.query.keywords.split(',').map(k => k.trim()) : DEFAULT_KEYWORDS;
  try {
    let data;
    if (source === 'ted') { data = await fetchTED(null, keywords); }
    else if (source === 'doffin') {
      const [a,b] = await Promise.all([fetchTED('NO',keywords),fetchDoffinBelowThreshold(keywords)]);
      const seen = new Set(a.map(t=>t.id));
      data = [...a,...b.filter(t=>!seen.has(t.id))];
    } else if (source === 'udbud') {
      const [a,b] = await Promise.all([fetchTED('DK',keywords),fetchUdbudBelowThreshold(keywords)]);
      const seen = new Set(a.map(t=>t.id));
      data = [...a,...b.filter(t=>!seen.has(t.id))];
    } else if (source === 'fat') { data = await fetchFindATender(keywords); }
    else return res.status(400).json({ error: 'Unknown source' });
    res.json({ results: data, fetchedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('TenderWatch backend on http://localhost:' + PORT));
