//Improvised code logic that inserts the product URLs into th db at once when a webssite is completely crawled

import axios from 'axios';
import * as cheerio from 'cheerio';
import PQueue from 'p-queue';
import pool from '../db/index.js';
import config from '../config/index.js';
import { isProductPageOptimized, launchBrowser, closeBrowser } from './playwright-config.js';

const playwrightQueue = new PQueue({ concurrency: 2 }); // Throttle Playwright concurrency

/**
 * Checks if a URL is within the target domain or its subdomains.
 * @param {string} url - The URL to check.
 * @param {string} targetDomain - The base URL or domain to match.
 * @returns {boolean}
 */

//Fuction to check if a URL is within the target domain or its subdomains
// For example, if the target domain is "snitch.com", it will return true for "www.snitch.com" and "subdomain.snitch.com"
// This is useful for ensuring that we only crawl URLs that are relevant to the target domain and not external links like linkedin.com or google.com
function isUrlInDomain(url, targetDomain) {
  try {
    const urlHostname = new URL(url).hostname.toLowerCase();
    const targetHostname = new URL(targetDomain).hostname.toLowerCase();
    return (
      urlHostname === targetHostname ||
      urlHostname.endsWith('.' + targetHostname)
    );
  } catch {
    return false;
  }
}

/**
 * Crawl a domain starting from baseUrl.
 * @param {string} baseUrl - The root URL to start crawling from.
 * @param {(url: string) => void} onCrawlUrl - Optional callback invoked with each URL crawled.
 * @returns {Promise<string[]>} - Array of discovered product URLs.
 */
async function crawlDomain(baseUrl, onCrawlUrl = () => {}) {
  const visited = new Set();
  const productUrls = new Set();
  const queue = [{ url: baseUrl, depth: 0 }];

  // Registering domains at the "domains" table of the database
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

    visited.add(url); // Mark visited to avoid duplicates

    // Invoke progress callback
    onCrawlUrl(url);

    try {
      const { data } = await axios.get(url, {
        timeout: 10000,
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
        // Only process URLs within the target domain
        if (!isUrlInDomain(href, baseUrl)) continue;
        if (productUrls.has(href) || visited.has(href)) continue;

        if (config.productPatterns.some(p => p.test(href))) {
          productUrls.add(href);
          visited.add(href);
        } else {
          try {
            const isLikelyProduct = await playwrightQueue.add(() =>
              isProductPageOptimized(href, browser)
            );
            if (isLikelyProduct) {
              productUrls.add(href);
              visited.add(href);
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

  // Insert all product URLs at once after crawling
  if (productUrls.size > 0) {
    const urlsArray = Array.from(productUrls);
    await pool.query(
      `INSERT INTO product_urls (url, domain_id)
       SELECT unnest($1::text[]), $2
       ON CONFLICT (url) DO NOTHING`,
      [urlsArray, domain.id]
    );
  }

  await closeBrowser();

  return Array.from(productUrls);
}

export { crawlDomain };
