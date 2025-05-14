//This is the old crawler code that inserts product URLs into the database as soon as a product page is detected.

import axios from 'axios';
import * as cheerio from 'cheerio';
import PQueue from 'p-queue';
import pool from '../db/index.js';
import config from '../config/index.js';
import { isProductPageOptimized, launchBrowser, closeBrowser } from './playwright-config.js';

const playwrightQueue = new PQueue({ concurrency: 2 }); // Throttle Playwright concurrency

function isUrlInDomain(url, targetDomain) {
  try {
    const urlHostname = new URL(url).hostname.toLowerCase();
    const targetHostname = new URL(targetDomain).hostname.toLowerCase();
    return (
      urlHostname === targetHostname ||
      urlHostname.endsWith('.' + targetHostname)
    );
  } catch {
    return false; // Invalid URL
  }
}

async function insertProductUrl(url, domainId) {
  try {
    await pool.query(
      `INSERT INTO product_urls (url, domain_id)
       VALUES ($1, $2)
       ON CONFLICT (url) DO NOTHING`,
      [url, domainId]
    );
  } catch (err) {
    console.error(`DB insert failed for ${url}: ${err.message}`);
  }
}

async function oldCrawlDomain(baseUrl, onCrawlUrl = () => {}) {
  const visited = new Set();
  const productUrls = new Set();
  const queue = [{ url: baseUrl, depth: 0 }];

  // Domain registration
  const { rows: [domain] } = await pool.query(
    `INSERT INTO domains (url) VALUES ($1)
     ON CONFLICT (url) DO UPDATE SET crawled_at=NOW()
     RETURNING id`,
    [baseUrl]
  );

  const browser = await launchBrowser();

  while (queue.length > 0) {
    const { url, depth } = queue.shift();

    if (depth > config.maxDepth || visited.has(url)) continue;

    visited.add(url); // Mark visited immediately to avoid duplicates

    // Invoke progress callback
    onCrawlUrl(url);

    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyCrawler/1.0)' }
      });
      const $ = cheerio.load(data);
      const rawLinks = [];

      $('a[href]').each((_, el) => {
        try {
          const href = new URL($(el).attr('href'), baseUrl).href;
          const protocol = new URL(href).protocol;
          if ((protocol === 'http:' || protocol === 'https:') && !visited.has(href)) {
            rawLinks.push(href);
          }
        } catch (_) {
        }
      });

      for (const href of rawLinks) {
        if (!isUrlInDomain(href, baseUrl)) continue;
        if (productUrls.has(href) || visited.has(href)) continue;

        if (config.productPatterns.some(p => p.test(href))) {
          productUrls.add(href);
          visited.add(href);
          // Insert when discovered
          await insertProductUrl(href, domain.id);
        } else {
          try {
            const isLikelyProduct = await playwrightQueue.add(() =>
              isProductPageOptimized(href, browser)
            );
            if (isLikelyProduct) {
              productUrls.add(href);
              visited.add(href);
              // Insert when discovered
              await insertProductUrl(href, domain.id);
            } else {
              queue.push({ url: href, depth: depth + 1 });
            }
          } catch (err) {
            console.error(`Playwright check failed for ${href}: ${err.message}`);
          }
        }
      }

    } catch (error) {
      console.error(`Failed to crawl ${url}: ${error.message}`);
    }
  }

  await closeBrowser();

  return Array.from(productUrls);
}

export { oldCrawlDomain };
