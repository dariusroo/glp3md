import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const today = new Date().toISOString().split('T')[0];

  const staticPages = [
    { loc: 'https://www.glp3md.com/',            priority: '1.0', changefreq: 'weekly'  },
    { loc: 'https://www.glp3md.com/blog/',        priority: '0.8', changefreq: 'weekly'  },
    { loc: 'https://www.glp3md.com/terms.html',   priority: '0.3', changefreq: 'monthly' },
    { loc: 'https://www.glp3md.com/privacy.html', priority: '0.3', changefreq: 'monthly' },
  ];

  const blogDir = path.join(process.cwd(), 'blog');
  const blogPosts = fs.readdirSync(blogDir).filter(name =>
    fs.statSync(path.join(blogDir, name)).isDirectory()
  ).map(name => ({
    loc: `https://www.glp3md.com/blog/${name}/`,
    priority: '0.7',
    changefreq: 'monthly',
  }));

  const urls = [...staticPages, ...blogPosts].map(({ loc, priority, changefreq }) => `
  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`).join('');

  res.setHeader('Content-Type', 'application/xml');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`);
}
