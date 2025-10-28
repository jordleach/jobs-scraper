import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const BASE_URL = 'https://jobs.ardaghgroup.com/global/en/search-results?s=1';
const PAGE_SIZE = 10;

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function normaliseText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function extractCountry(location) {
  const text = normaliseText(location);
  const parts = text.split(',').map(p => p.trim());
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

async function scrapePage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 });

  const cardSelector = 'a[href*="/job/"]';
  await page.waitForSelector(cardSelector, { timeout: 45000 });

  const jobs = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('a[href*="/job/"]'));
    const map = new Map();
    for (const a of cards) {
      const href = a.href;
      const title = a.textContent?.trim();
      const card = a.closest('article, li, div');
      const locEl = card?.querySelector('[data-ph-at-id="location"], [class*="location" i]');
      const catEl = card?.querySelector('[data-ph-at-id="category"], [class*="category" i]');
      const teamEl = card?.querySelector('[data-ph-at-id="team"], [class*="team" i]');
      const location = locEl?.textContent?.trim() || '';
      const category = catEl?.textContent?.trim() || '';
      const team = teamEl?.textContent?.trim() || '';
      if (href && title) map.set(href, { title, href, location, category, team });
    }
    return Array.from(map.values());
  });

  return jobs;
}

async function scrapeJobs() {
  console.log('Starting job scrape...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 }
  });
  const page = await context.newPage();

  try {
    const allJobsMap = new Map();
    let pageOffset = 0;
    let hasMore = true;

    while (hasMore) {
      const url = pageOffset === 0
        ? BASE_URL
        : `https://jobs.ardaghgroup.com/global/en/search-results?from=${pageOffset}&s=1`;

      console.log(`Scraping page ${pageOffset / PAGE_SIZE + 1}...`);
      const jobs = await scrapePage(page, url);

      if (jobs.length === 0) {
        hasMore = false;
        break;
      }

      jobs.forEach(j => allJobsMap.set(j.href, j));
      pageOffset += PAGE_SIZE;

      if (jobs.length < PAGE_SIZE) {
        hasMore = false;
      }
    }

    const allJobs = Array.from(allJobsMap.values());

    const payload = {
      scraped_at: new Date().toISOString(),
      source: BASE_URL,
      count: allJobs.length,
      jobs: allJobs.map(j => {
        const location = normaliseText(j.location);
        return {
          title: normaliseText(j.title),
          location: location,
          country: extractCountry(location),
          category: normaliseText(j.category),
          team: normaliseText(j.team),
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
  console.log(`Updating database with ${payload.count} jobs...`);

  await supabase
    .from('jobs')
    .update({ is_active: false })
    .eq('is_active', true);

  for (const job of payload.jobs) {
    await supabase
      .from('jobs')
      .upsert({
        title: job.title,
        location: job.location,
        description: `${job.category || ''} ${job.team || ''}`.trim(),
        url: job.href,
        is_active: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'url',
        ignoreDuplicates: false
      });
  }

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
