import { crawlDomain } from './services/crawler.js';
import { oldCrawlDomain } from './services/oldcrawler.js';
import config from './config/index.js';

(async () => {
  try {
    for (const domain of config.targetDomains) {
      console.log(`🕷️  Crawling ${domain}`);

      const results = await crawlDomain(domain, (url) => {
        console.log(`➡️ Crawling URL: ${url}`);
      });

      console.log(`✅ Found ${results.length} product URLs`);
    }
    console.log('Crawling complete!');
  } catch (error) {
    console.error('🚨 Critical error:', error);
  }
})();
