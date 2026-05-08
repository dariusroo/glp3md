const fs = require('fs');
const path = require('path');

function getPublishDate(blogDir, slug) {
  try {
    const html = fs.readFileSync(path.join(blogDir, slug, 'index.html'), 'utf8');
    const match = html.match(/"datePublished":\s*"([^"]+)"/);
    return match?.[1] || null;
  } catch { return null; }
}

module.exports = function handler(req, res) {
  const today = new Date().toISOString().split('T')[0];

  const staticPages = [
    { url: 'https://www.glp3md.com/', priority: '1.0', changefreq: 'weekly', lastmod: today },
    { url: 'https://www.glp3md.com/blog/', priority: '0.8', changefreq: 'weekly', lastmod: today },
    { url: 'https://www.glp3md.com/terms.html', priority: '0.3', changefreq: 'monthly', lastmod: today },
    { url: 'https://www.glp3md.com/privacy.html', priority: '0.3', changefreq: 'monthly', lastmod: today },
  ];

  const blogDir = path.join(process.cwd(), 'blog');
  let blogPages = [];

  try {
    const entries = fs.readdirSync(blogDir, { withFileTypes: true });
    blogPages = entries
      .filter(e => e.isDirectory())
      .map(e => ({
        url: `https://www.glp3md.com/blog/${e.name}/`,
        priority: '0.7',
        changefreq: 'monthly',
        lastmod: getPublishDate(blogDir, e.name) || today,
      }));
  } catch (e) {
    // blog directory not found, skip
  }

  const allPages = [...staticPages, ...blogPages];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allPages.map(p => `  <url>
    <loc>${p.url}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml');
  res.status(200).send(xml);
}
