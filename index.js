// index.js — Scrape Ardagh jobs (search-results), write JSON, POST to Bolt for ingestion
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

// ===== Config (env with sensible defaults) =====
const BASE_URL = process.env.BASE_URL
  || 'https://jobs.ardaghgroup.com/global/en/search-results?s=1'; // keep your current URL

const PAGE_SIZE = Number(process.env.PAGE_SIZE || 10);        // search-results uses ?from=<offset> in steps of 10
const MAX_PAGES = Number(process.env.MAX_PAGES || 60);        // safety cap
const WAIT_MOUNT_MS = Number(process.env.WAIT_MOUNT_MS || 5000); // short wait: "are there jobs on this page?"

// ===== Next button support for pages where URL doesn't change between pages =====
const PAGINATION_MODE = (process.env.PAGINATION_MODE || 'offset').toLowerCase(); // 'offset' or 'next'
const NEXT_SELECTOR = process.env.NEXT_SELECTOR || 'a[aria-label="Next"],button[aria-label="Next"],a:has-text("Next"),button:has-text("Next")';
const TENANT_ID = process.env.TENANT_ID || 'default';

// Bolt ingestion endpoint + shared secret header (required)
const BOLT_INGEST_URL = process.env.BOLT_INGEST_URL;          // e.g. https://your-bolt-app.vercel.app/api/ingest-jobs
const INGEST_KEY = process.env.INGEST_KEY;                    // same value you added in Bolt + GitHub secrets

// ===== Helpers =====
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

function extractCountry(location) {
  const parts = norm(location).split(',').map(p => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

async function acceptCookies(page) {
  const sels = [
    'button:has-text("Accept")',
    'button:has-text("I Accept")',
    'button:has-text("Agree")',
    '[aria-label*="accept" i]',
  ];
  for (const s of sels) {
    const btn = page.locator(s).first();
    if (await btn.count()) {
      await btn.click({ timeout: 1500 }).catch(() => {});
      break;
    }
  }
}

async function scrapePage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptCookies(page);
  await page.waitForLoadState('networkidle').catch(() => {});

  const anchorSel = 'a[href*="/job/"]';
  const mounted = await page.locator(anchorSel).first().waitFor({ timeout: WAIT_MOUNT_MS })
    .then(() => true).catch(() => false);
  if (!mounted) return [];

  const jobs = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/job/"]'));
    const map = new Map();
    for (const a of anchors) {
      const href = a.href || a.getAttribute('href');
      const title = a.textContent?.trim();
      const card = a.closest('article, li, div');
      const pick = q => card?.querySelector(q)?.textContent?.trim() || '';
      const location = pick('[data-ph-at-id="location"], [class*="location" i]');
      const category = pick('[data-ph-at-id="category"], [class*="category" i]');
      const team = pick('[data-ph-at-id="team"], [class*="team" i]');
      if (href && title) map.set(href, { title, href, location, category, team });
    }
    return Array.from(map.values());
  });

  return jobs;
}

async function scrapeAll() {
  console.log('Starting job scrape...');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });

  // Block heavy assets to speed things up
  await context.route('**/*', route => {
    const u = route.request().url();
    if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i.test(u)) return route.abort();
    if (/googletagmanager|analytics|doubleclick|facebook|hotjar|fullstory|segment/i.test(u)) return route.abort();
    route.continue();
  });

  const page = await context.newPage();

  try {
    const allJobsMap = new Map();

    if (PAGINATION_MODE === 'next') {
      // --- Next-button pagination (for sites like Spirax where URL doesn't change)
      console.log('Scraping page 1 (Next mode)…');
      let jobs = await scrapePage(page, BASE_URL);
      if (jobs.length === 0) console.log('No jobs on first page (Next mode).');
      jobs.forEach(j => allJobsMap.set(j.href, j));

      for (let p = 2; p <= MAX_PAGES; p++) {
        const next = page.locator(NEXT_SELECTOR).first();
        const exists = (await next.count()) > 0;
        const enabled = exists && await next.isEnabled().catch(() => false);
        if (!exists || !enabled) { console.log('No Next button — last page reached.'); break; }

        await Promise.all([
          next.click().catch(()=>{}),
          page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{})
        ]);

        console.log(`Scraping page ${p} (Next mode)…`);
        const more = await scrapePage(page, page.url());
        if (more.length === 0) { console.log('No jobs on this page — stopping.'); break; }
        const before = allJobsMap.size;
        more.forEach(j => allJobsMap.set(j.href, j));
        if (allJobsMap.size === before) { console.log('No new jobs detected — stopping.'); break; }
      }
    } else {
      // --- Offset pagination (current Ardagh behaviour)
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        const offset = pageIndex * PAGE_SIZE;
        const url = offset === 0 ? BASE_URL
          : `${BASE_URL.includes('?') ? BASE_URL + '&' : BASE_URL + '?'}from=${offset}&s=1`;
        console.log(`Scraping page ${pageIndex + 1} (offset ${offset})…`);

        const jobs = await scrapePage(page, url);

        if (jobs.length === 0) {
          console.log('No jobs on this page — stopping.');
          break;
        }

        jobs.forEach(j => allJobsMap.set(j.href, j));

        if (jobs.length < PAGE_SIZE) {
          console.log('Last page reached (short page).');
          break;
        }
      }
    }

    const allJobs = Array.from(allJobsMap.values()).map(j => {
      const location = norm(j.location);
      return {
        title: norm(j.title),
        location,
        country: extractCountry(location),
        category: norm(j.category),
        team: norm(j.team),
        href: j.href
      };
    });

    const payload = {
      scraped_at: new Date().toISOString(),
      source: BASE_URL,
      count: allJobs.length,
      jobs: allJobs
    };

    return payload;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}


function saveJson(payload) {
  const outDir = path.join(process.cwd(), 'public');
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, 'jobs.json');
  fs.writeFileSync(outfile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Saved ${payload.count} jobs to ${outfile}`);
  return outfile;
}

async function postToBolt(payload) {
  if (!BOLT_INGEST_URL || !INGEST_KEY) {
    throw new Error('Missing BOLT_INGEST_URL or INGEST_KEY env vars');
  }

  const auth = process.env.SUPABASE_ANON_KEY; // from GitHub secret
  const headers = {
    'Content-Type': 'application/json',
    'x-ingest-key': INGEST_KEY,
    'x-tenant-id': TENANT_ID
  };
  if (auth) {
    headers['Authorization'] = `Bearer ${auth}`; // required for Edge Function JWT
    headers['apikey'] = auth;                    // optional, some setups expect it
  }

  const res = await fetch(BOLT_INGEST_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bolt ingest failed: HTTP ${res.status} — ${text}`);
  }

  const json = await res.json().catch(() => ({}));
  console.log('Bolt ingest response:', json);
}


async function main() {
  try {
    const payload = await scrapeAll();
    saveJson(payload);
    await postToBolt(payload);
    console.log(`✓ Successfully scraped ${payload.count} jobs at ${payload.scraped_at}`);
    process.exit(0);
  } catch (err) {
    console.error('Scrape failed:', err?.message || err);
    process.exit(1);
  }
}

main();
