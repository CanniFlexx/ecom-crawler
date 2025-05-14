import { chromium } from 'playwright';

let browser;

async function launchBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function isProductPageOptimized(url, browserInstance) {
  const context = await browserInstance.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });
  
  const page = await context.newPage();
  
  try {
    await page.route('**/*.{png,jpg,jpeg,svg,gif,woff2,woff,ttf}', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const [hasTitle, hasAddToCart, hasPrice] = await Promise.all([
      page.getByRole('heading', { level: 1 }).count().then(c => c > 0),
      page.getByRole('button', { name: /add to cart/i }).count().then(c => c > 0),
      page.getByText(/\$\s?\d{1,3}(,\d{3})*(\.\d{2})?/).count().then(c => c > 0),
    ]);

    return hasAddToCart && (hasTitle || hasPrice);
  } catch (err) {
    console.error(`Playwright error on ${url}: ${err.message}`);
    return false;
  } finally {
    await context.close();
  }
}

export { launchBrowser, closeBrowser, isProductPageOptimized };
