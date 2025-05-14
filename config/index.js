const config = {
  targetDomains: [
    'https://www.snitch.com/',
    'https://www.virgio.com/'
  ],
  productPatterns: [/\/(product|item|p)\//i],
  concurrency: 5,
  maxDepth: 3
};

export default config;
