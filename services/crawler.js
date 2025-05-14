import axios from 'axios';
import * as cheerio from 'cheerio';
import PQueue from 'p-queue';
import pool from '../db/index.js';
import config from '../config/index.js';
import { isProductPageOptimized, launchBrowser, closeBrowser, checkMultipleUrls } from './playwright-config.js';

// Create separate queues with different concurrency levels for different tasks
const playwrightQueue = new PQueue({ concurrency: 5 }); // Increased from 2 to 5
const httpQueue = new PQueue({ concurrency: 10 }); // New queue for HTTP requests

// Cache for known product URL patterns to avoid redundant checks
const patternMatchCache = new Map();

/**
 * Checks if a URL is within the target domain or its subdomains.
 * @param {string} url - The URL to check.
 * @param {string} targetDomain - The base URL or domain to match.
 * @returns {boolean}
 */
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
 * Pre-filters URLs that are likely to be product pages based on patterns
 * @param {string} url - URL to check
 * @returns {boolean} - True if URL matches product patterns
 */
function isLikelyProductByPattern(url) {
  // Check cache first
  if (patternMatchCache.has(url)) {
    return patternMatchCache.get(url);
  }
  
  // Common product URL patterns
  const result = config.productPatterns.some(p => p.test(url)) || 
                 /\/p\/|\/product\/|\/item\/|\/pd\/|[?&](pid|product_id|productid|itemid|sku)=/i.test(url);
  
  // Cache the result
  patternMatchCache.set(url, result);
  return result;
}

/**
 * Extracts all links from HTML content
 * @param {string} html - HTML content
 * @param {string} baseUrl - Base URL for resolving relative links
 * @returns {string[]} - Array of normalized URLs
 */
function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = new Set();
  
  $('a[href]').each((_, el) => {
    try {
      const href = new URL($(el).attr('href'), baseUrl).href;
      const protocol = new URL(href).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        links.add(href);
      }
    } catch (_) {
      // Invalid URL, skip
    }
  });
  
  return Array.from(links);
}

/**
 * Process URLs in batches for both crawling and product detection
 * @param {string[]} urls - URLs to fetch
 * @param {string} baseUrl - Base domain URL
 * @param {Set} visited - Set of already visited URLs
 * @returns {Promise<{crawlUrls: string[], productUrls: string[]}>}
 */
async function processBatch(urls, baseUrl, visited) {
  // Filter URLs to only process those in domain and not yet visited
  const filteredUrls = urls.filter(url => 
    isUrlInDomain(url, baseUrl) && !visited.has(url)
  );
  
  if (filteredUrls.length === 0) return { crawlUrls: [], productUrls: [] };
  
  // First pass: identify likely product pages by URL pattern
  const likelyProductUrls = [];
  const needCheckUrls = [];
  
  for (const url of filteredUrls) {
    if (isLikelyProductByPattern(url)) {
      likelyProductUrls.push(url);
    } else {
      needCheckUrls.push(url);
    }
  }
  
  // Second pass: use Playwright to check uncertain URLs in parallel
  let confirmedProductUrls = [];
  if (needCheckUrls.length > 0) {
    const browser = await launchBrowser();
    const results = await playwrightQueue.add(() => 
      checkMultipleUrls(needCheckUrls, 5) // Using our batch processing function
    );
    
    // Convert results object to array of confirmed product URLs
    confirmedProductUrls = Object.entries(results)
      .filter(([_, isProduct]) => isProduct)
      .map(([url]) => url);
  }
  
  // Combine all product URLs
  const allProductUrls = [...likelyProductUrls, ...confirmedProductUrls];
  
  // URLs to crawl are those that aren't products
  const crawlUrls = filteredUrls.filter(url => 
    !allProductUrls.includes(url)
  );
  
  return { crawlUrls, productUrls: allProductUrls };
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
  const pagesToCrawl = new Set([baseUrl]);
  
  console.time('Total crawl time');

  // Registering domains at the "domains" table of the database
  const { rows: [domain] } = await pool.query(
    `INSERT INTO domains (url) VALUES ($1)
     ON CONFLICT (url) DO UPDATE SET crawled_at=NOW()
     RETURNING id`,
    [baseUrl]
  );

  // Initialize browser once for the entire crawl
  await launchBrowser();
  
  // Batch processing
  const batchSize = 20; // Process 20 URLs at a time
  
  try {
    while (pagesToCrawl.size > 0) {
      // Get a batch of URLs to process
      const currentBatch = Array.from(pagesToCrawl).slice(0, batchSize);
      
      // Remove these from the set
      currentBatch.forEach(url => pagesToCrawl.delete(url));
      
      // Mark as visited
      currentBatch.forEach(url => visited.add(url));
      
      // Fetch pages in parallel
      const pagePromises = currentBatch.map(url => 
        httpQueue.add(() => 
          axios.get(url, {
            timeout: 8000, // Reduced timeout
            headers: { 
              'User-Agent': 'Mozilla/5.0 (compatible; MyCrawler/1.0)',
              // Only request HTML, no images or other assets
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            // Abort the request if it takes too long to start receiving data
            maxContentLength: 1024 * 1024, // 1MB max size
          })
          .then(response => {
            onCrawlUrl(url); // Report progress
            return { url, data: response.data, success: true };
          })
          .catch(error => {
            console.error(`Failed to fetch ${url}: ${error.message}`);
            return { url, data: null, success: false };
          })
        )
      );
      
      const responses = await Promise.all(pagePromises);
      
      // Extract all links from successful responses
      const allExtractedLinks = [];
      for (const response of responses.filter(r => r.success)) {
        const links = extractLinks(response.data, response.url);
        allExtractedLinks.push(...links);
      }
      
      // Process links to identify products and new URLs to crawl
      const { crawlUrls, productUrls: newProductUrls } = await processBatch(
        allExtractedLinks, 
        baseUrl, 
        visited
      );
      
      // Add new product URLs to our set
      newProductUrls.forEach(url => productUrls.add(url));
      
      // Add new URLs to crawl, but only if we haven't exceeded max depth
      if (visited.size <= config.maxDepth * 100) { // Rough estimate of max pages
        crawlUrls.forEach(url => pagesToCrawl.add(url));
      }
      
      // Batch insert discovered product URLs periodically
      if (productUrls.size > 0 && productUrls.size % 50 === 0) {
        await batchInsertProductUrls(Array.from(productUrls), domain.id);
        console.log(`Inserted ${productUrls.size} product URLs so far`);
      }
    }
    
    // Final insert of any remaining product URLs
    if (productUrls.size > 0) {
      await batchInsertProductUrls(Array.from(productUrls), domain.id);
    }
    
  } finally {
    await closeBrowser();
    console.timeEnd('Total crawl time');
  }

  return Array.from(productUrls);
}

/**
 * Insert product URLs in batches to avoid large queries
 * @param {string[]} urls - URLs to insert
 * @param {number} domainId - Domain ID  
 */
async function batchInsertProductUrls(urls, domainId) {
  try {
    // Using unnest() for efficient bulk insert
    await pool.query(
      `INSERT INTO product_urls (url, domain_id)
       SELECT unnest($1::text[]), $2
       ON CONFLICT (url) DO NOTHING`,
      [urls, domainId]
    );
  } catch (error) {
    console.error(`Failed to insert product URLs: ${error.message}`);
  }
}

export { crawlDomain };