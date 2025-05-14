import { chromium } from 'playwright';
import { isProductPageOptimized, launchBrowser, closeBrowser } from './services/playwright-config.js';

async function testProductPageDetection(url) {
  const browser = await launchBrowser();

  try {
    const result = await isProductPageOptimized(url, browser);
    console.log(`Is "${url}" a product page?`, result);
  } catch (err) {
    console.error(`Error testing URL ${url}:`, err);
  } finally {
    await closeBrowser();
  }
}

const testUrl = 'https://www.virgio.com/products/brightlinen-viscose-linen-mini-dress'; // Replace with your URL

testProductPageDetection(testUrl);
