import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const BASE_URL = 'https://jobs.ardaghgroup.com/global/en/search-results?s=1';
const PAGE_SIZE = 10;            // search-results uses ?from=<offset> in steps of 10
const MAX_PAGES = 60;            // hard safety cap
const WAIT_MOUNT_MS = 5000;      // quick “is there anything here?” check
const COOKIE_WAIT_MS = 1500;

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey =
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_SERVICE_ROLE || // prefer in CI if available
  process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const norm = s => (s || '').replace(/\s+/g, ' ').trim();

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
    if (await btn.count()) { await btn.click({ timeout: COOKIE_WAIT_MS }).catch(()=>{}); break; }
  }
}

async function scrapePage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptCookies(page);
  await page.waitForLoadState('networkidle').catch(()=>{});

  const anchorSel = 'a[href*="/job/"]';
  const mounted = await page.locator(anchorSel).first().waitFor({ timeout: WAIT_MOUNT_MS }).then(() => true).catch(() => false);
  if (!mounted) return [];

  const jobs = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/job/"]'));
    const map = new Map();
    for (const a of anchors) {
      const href = a.href;
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

async function scrapeJobs() {
  console.log('Starting job scrape...');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();

  try {
    const allJobsMap = new Map();
    const seenOffsets = new Set();

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const offset = pageIndex * PAGE_SIZE;
      if (seenOffsets.has(offset)) { console.log('Offset repeated — stopping.'); break; }
      seenOffsets.add(offset);

      const url = offset === 0 ? BASE_URL : `https://jobs.ardaghgroup.com/global/en/search-results?from=${offset}&s=1`;
      console.log(`Scraping page ${pageIndex + 1} (offset ${offset})...`);

      const jobs = await scrapePage(page, url);

      // Stop when the page has no jobs (prevents “phantom page 23”)
      if (jobs.length === 0) { console.log('No jobs on this page — stopping.'); break; }

      jobs.forEach(j => allJobsMap.set(j.href, j));

      // If the page yields fewer than PAGE_SIZE, we’ve hit the end
      if (jobs.length < PAGE_SIZE) { console.log('Last page reached (short page).'); break; }
    }

    const allJobs = Array.from(allJobsMap.values());

    const payload = {
      scraped_at: new Date().toISOString(),
      source: BASE_URL,
      count: allJobs.length,
      jobs: allJobs.map(j => {
        const location = norm(j.location);
        return {
          title: norm(j.title),
          location,
          country: extractCountry(location),
          category: norm(j.category),
          team: norm(j.team),
          href: j.href
        };
      })
    };
    return payload;
  } finally {
    await page.close().catch(()=>{});
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

async function updateDatabase(payload) {
  console.log(`Upserting ${payload.count} jobs...`);
  const seenAt = payload.scraped_at;

  // Batch upsert
  const rows = payload.jobs.map(j => ({
    title: j.title,
    location: j.location,
    description: `${j.category || ''} ${j.team || ''}`.trim(),
    url: j.href,
    is_active: true,
    updated_at: seenAt
  }));

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('jobs')
      .upsert(slice, { onConflict: 'url', ignoreDuplicates: false });
    if (error) throw error;
  }

  // Deactivate jobs not refreshed this run (safer than flipping everything inactive first)
  const { error: deactErr } = await supabase
    .from('jobs')
    .update({ is_active: false })
    .eq('is_active', true)
    .lt('updated_at', seenAt);
  if (deactErr) throw deactErr;

  console.log('Database updated successfully');
}

async function main() {
  try {
    const payload = await scrapeJobs();
    await updateDatabase(payload);
    console.log(`✓ Successfully scraped ${payload.count} jobs at ${payload.scraped_at}`);
    process.exit(0);
  } catch (err) {
    console.error('Scrape failed:', err?.message || err);
    process.exit(1);
  }
}

main();
