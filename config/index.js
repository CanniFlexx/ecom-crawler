const config = {
  targetDomains: [
    'https://www.virgio.com/',
    'https://www.tatacliq.com/',
    'https://nykaafashion.com/',
    'https://www.westside.com/'
  ],
  productPatterns: [/\/(product|item|p)\//i],
  concurrency: 5,
  maxDepth: 3
};

export default config;
