import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

let browser;
let browserContext;

// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function launchBrowser() {
  if (!browser) {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox']
    });
    
    // Create and reuse a single browser context for better performance
    browserContext = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      // Disable permissions prompts, cookies acceptance, etc.
      permissions: [],
      // Enable JavaScript since we need it for evaluations
      javaScriptEnabled: true
    });
  }
  return browser;
}

async function closeBrowser() {
  if (browserContext) {
    await browserContext.close();
    browserContext = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function isProductPageOptimized(url, browserInstance) {
  // Create a context with JavaScript enabled or disabled as needed
  if (!browserContext) {
    // Start with JavaScript disabled for faster initial page load
    browserContext = await browserInstance.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      permissions: [],
      javaScriptEnabled: true // Changed to true since we can't toggle it later
    });
  }

  const page = await browserContext.newPage();
  let isProductPage = false;

  try {
    // Block unnecessary resources for faster loading
    await page.route('**/*.{png,jpg,jpeg,svg,gif,woff2,woff,ttf,css}', (route) => route.abort());
    await page.route('**/analytics/**', (route) => route.abort());
    await page.route('**/tracking/**', (route) => route.abort());

    // Set a shorter timeout for faster failure
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

    // Check URL patterns common for product pages
    const urlPatterns = ['/product/', '/p/', '/item/', '/pd/', '/shop/', '/buy/'];
    const urlLowerCase = url.toLowerCase();
    const hasProductUrlPattern = urlPatterns.some(pattern => urlLowerCase.includes(pattern));

    // 1. Fast checks first - these don't require much DOM traversal
    // Check for common product page URL parameters
    const hasProductIdParam = /[?&](pid|product_id|productid|itemid|sku|id)=/i.test(url);
    
    // Check Open Graph and other metadata (faster than DOM traversal)
    const metaChecks = await page.evaluate(() => {
      // Check meta tags
      const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute('content');
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
      const productMeta = document.querySelector('meta[property="product:price:amount"]') !== null;
      const itemProp = document.querySelector('[itemprop="price"]') !== null;

      // Check for schema.org JSON-LD
      const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const hasSchemaProduct = jsonLdScripts.some(script => {
        try {
          const json = JSON.parse(script.textContent);
          return json['@type'] === 'Product' || 
                 (json['@graph'] && json['@graph'].some(item => item['@type'] === 'Product'));
        } catch (e) {
          return false;
        }
      });

      // Check for standard microdata
      const hasMicrodata = document.querySelector('[itemtype*="schema.org/Product"]') !== null;

      return {
        isOgProduct: ogType?.toLowerCase().includes('product'),
        hasProductTitle: ogTitle && /buy|shop|product|item/i.test(ogTitle),
        hasSchemaProduct,
        hasProductMeta: productMeta,
        hasItemProp: itemProp,
        hasMicrodata
      };
    });

    // If these fast checks identify a product page, we can return early
    if (metaChecks.hasSchemaProduct || metaChecks.isOgProduct || metaChecks.hasMicrodata) {
      isProductPage = true;
      return isProductPage;
    }

    // 2. More thorough DOM checks if needed
    const productIndicators = await page.evaluate(() => {
      // Product title detection with expanded selectors
      const titleSelectors = [
        'h1', 
        'h2', 
        '.product-title', 
        '.product-name', 
        '.product-heading',
        '.pdp-title',
        '#product-title',
        '[data-testid*="product-title"]',
        '[data-testid*="productTitle"]',
        '[data-product-title]'
      ];
      
      const hasTitle = titleSelectors.some(selector => 
        document.querySelector(selector) !== null
      );

      // Price detection
      const priceSelectors = [
        '.price', 
        '.product-price', 
        '.pdp-price', 
        '.current-price', 
        '[data-testid*="price"]',
        '[data-price]',
        '.price-tag',
        '[itemprop="price"]'
      ];
      
      const hasPrice = priceSelectors.some(selector => 
        document.querySelector(selector) !== null
      );

      // Add to cart detection
      const addToCartSelectors = [
        'button:not([disabled])',
        'input[type="submit"]:not([disabled])',
        'a.add-to-cart',
        'a.add-to-bag',
        '.add-to-cart',
        '.add-to-bag',
        '.buy-now',
        '.purchase-button',
        '[data-testid*="add-to-cart"]',
        '[data-testid*="buy-now"]'
      ];
      
      // Check for add to cart buttons by text content
      const buttonTexts = Array.from(
        document.querySelectorAll(addToCartSelectors.join(', '))
      ).map(el => el.textContent.trim().toLowerCase());
      
      const cartRegex = /add\s*to\s*cart|add\s*to\s*bag|buy\s*now|purchase|add\s*item|order\s*now|checkout/i;
      const hasAddToCart = buttonTexts.some(text => cartRegex.test(text));

      // Check for product options (size, color, etc.)
      const hasOptions = document.querySelector('select[name*="size"], select[name*="color"], .size-selector, .color-selector') !== null;

      // Check for product images
      const hasProductImages = document.querySelector('.product-images, .pdp-images, .carousel, .slider, [data-images], .product-gallery') !== null;

      // Check for breadcrumbs with product category
      const hasBreadcrumbs = document.querySelector('.breadcrumbs, .breadcrumb, nav[aria-label*="breadcrumb"]') !== null;

      // Check for product details or description
      const hasDescription = document.querySelector('.product-description, .description, .details, [data-testid*="description"]') !== null;

      // Check for reviews section
      const hasReviews = document.querySelector('.reviews, .ratings, .stars, [data-testid*="review"]') !== null;

      // Check for related products section
      const hasRelatedProducts = document.querySelector('.related-products, .you-may-also-like, .similar-products') !== null;

      return {
        hasTitle,
        hasPrice,
        hasAddToCart,
        hasOptions,
        hasProductImages,
        hasBreadcrumbs,
        hasDescription,
        hasReviews,
        hasRelatedProducts
      };
    });

    // Decision logic - calculate a confidence score
    let confidenceScore = 0;
    if (hasProductUrlPattern) confidenceScore += 2;
    if (hasProductIdParam) confidenceScore += 2;
    if (metaChecks.hasProductTitle) confidenceScore += 1;
    if (metaChecks.hasProductMeta) confidenceScore += 2;
    if (metaChecks.hasItemProp) confidenceScore += 2;
    if (productIndicators.hasTitle) confidenceScore += 3;
    if (productIndicators.hasPrice) confidenceScore += 3;
    if (productIndicators.hasAddToCart) confidenceScore += 4;
    if (productIndicators.hasOptions) confidenceScore += 2;
    if (productIndicators.hasProductImages) confidenceScore += 1;
    if (productIndicators.hasBreadcrumbs) confidenceScore += 1;
    if (productIndicators.hasDescription) confidenceScore += 2;
    if (productIndicators.hasReviews) confidenceScore += 1;
    if (productIndicators.hasRelatedProducts) confidenceScore += 1;

    // Consider it a product page if confidence is high enough
    isProductPage = confidenceScore >= 7;

    // Save screenshot for debugging only if needed
    if (process.env.DEBUG_SCREENSHOTS === 'true') {
      const screenshotPath = path.join(__dirname, `screenshot-${new URL(url).hostname}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }

    return isProductPage;
  } catch (err) {
    console.error(`Error analyzing ${url}: ${err.message}`);
    return false;
  } finally {
    await page.close();
  }
}

// Helper function to check multiple URLs in parallel
async function checkMultipleUrls(urls, concurrency = 5) {
  const browser = await launchBrowser();
  const results = {};
  
  // Process URLs in batches for controlled concurrency
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const promises = batch.map(url => 
      isProductPageOptimized(url, browser)
        .then(isProduct => {
          results[url] = isProduct;
          return { url, isProduct };
        })
        .catch(err => {
          console.error(`Failed to process ${url}: ${err.message}`);
          results[url] = false;
          return { url, isProduct: false, error: err.message };
        })
    );
    
    await Promise.all(promises);
  }
  
  return results;
}

export { launchBrowser, closeBrowser, isProductPageOptimized, checkMultipleUrls };