'use strict';

const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// ─── Paths ───────────────────────────────────────────────────────────────────
const ROOT          = path.resolve(__dirname, '..');
const CLUSTERS_PATH = path.join(__dirname, 'clusters.json');
const NEWS_PATH     = path.join(__dirname, 'processed_news.json');
const BLOG_DIR      = path.join(ROOT, 'blog');
const TEMPLATE_PATH = path.join(BLOG_DIR, 'retatrutide-vs-tirzepatide', 'index.html');
const BLOG_INDEX    = path.join(BLOG_DIR, 'index.html');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FETCH_TIMEOUT = 30000; // 30s — prevents hung network calls from blocking the pipeline

// ─── Helpers ─────────────────────────────────────────────────────────────────
function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return []; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function parseClaudeJSON(raw) {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    console.error('⚠️  Claude returned invalid JSON. Raw (first 400 chars):', raw.slice(0, 400));
    return null;
  }
}

function countWords(html) {
  return html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeJson(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function loadResearch() {
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'research.json'), 'utf8'));
    return entries.map(e =>
      `[${e.title}]\nSource: ${e.source}\n${e.key_data.map(d => `• ${d}`).join('\n')}`
    ).join('\n\n');
  } catch { return ''; }
}

function deriveCategory(slug, newsTriggered) {
  if (newsTriggered) return 'News';
  if (/fda|approval|regulatory/.test(slug)) return 'Regulatory';
  if (/vs-|-versus-/.test(slug)) return 'Comparison';
  if (/side-effect|safety|adverse/.test(slug)) return 'Safety';
  if (/cost|price|access|insurance/.test(slug)) return 'Access';
  if (/trial|study|phase|triumph/.test(slug)) return 'Clinical Trials';
  return 'Research';
}

function readProcessedNews() {
  const raw = readJSON(NEWS_PATH);
  // Migrate from old array format to {urls, trials} object
  if (Array.isArray(raw)) return { urls: raw, trials: {} };
  return { urls: raw.urls || [], trials: raw.trials || {} };
}

// ─── Stage 1: News Monitoring ─────────────────────────────────────────────────
async function stage1_newsMonitoring() {
  console.log('\n=== STAGE 1: News Monitoring ===');

  const processedNews = readProcessedNews();
  const processedUrls = new Set(processedNews.urls.map(n => n.url));
  const newItems = [];

  // 1a. PubMed
  try {
    console.log('  Fetching PubMed...');
    const searchRes = await fetch(
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi' +
      '?db=pubmed&term=retatrutide&reldate=7&datetype=pdat&retmode=json',
      { timeout: FETCH_TIMEOUT }
    );
    const searchData = await searchRes.json();
    const ids = searchData?.esearchresult?.idlist || [];

    if (ids.length > 0) {
      const summaryRes = await fetch(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`,
        { timeout: FETCH_TIMEOUT }
      );
      const summaryData = await summaryRes.json();
      for (const id of ids) {
        const article = summaryData?.result?.[id];
        if (!article) continue;
        const url = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
        if (processedUrls.has(url)) continue;
        newItems.push({ url, title: article.title || '', source: 'pubmed', priority: 'normal', date: article.pubdate || '' });
        processedUrls.add(url);
      }
    }
    console.log(`  PubMed: ${ids.length} results, ${newItems.filter(i => i.source === 'pubmed').length} new`);
  } catch (e) {
    console.error('  PubMed error:', e.message);
  }

  // 1b. SEC EDGAR
  const beforeEdgar = newItems.length;
  try {
    console.log('  Fetching SEC EDGAR...');
    const startdt = isoDate(daysAgo(7));
    const today   = isoDate(new Date());
    const edgarRes = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22retatrutide%22&dateRange=custom&startdt=${startdt}&enddt=${today}&forms=8-K`,
      { headers: { 'User-Agent': 'glp3md pipeline hello@glp3md.com' }, timeout: FETCH_TIMEOUT }
    );
    const edgarData = await edgarRes.json();
    const hits = edgarData?.hits?.hits || [];

    for (const hit of hits) {
      const accessionNo = (hit._id || '').replace(/-/g, '');
      const entityId    = hit._source?.entity_id || '';
      const url = accessionNo && entityId
        ? `https://www.sec.gov/Archives/edgar/data/${entityId}/${accessionNo}/`
        : `https://efts.sec.gov/LATEST/search-index?q=%22retatrutide%22&forms=8-K&accno=${hit._id || ''}`;
      const key = hit._id || url;
      if (processedUrls.has(key)) continue;
      const companyName = hit._source?.display_names?.[0]?.name || 'Unknown';
      newItems.push({
        url,
        title: `SEC 8-K: ${companyName} — ${hit._source?.file_date || 'n/d'}`,
        source: 'sec_edgar',
        priority: 'high',
        date: hit._source?.file_date || ''
      });
      processedUrls.add(key);
    }
    console.log(`  SEC EDGAR: ${hits.length} hits, ${newItems.length - beforeEdgar} new (HIGH PRIORITY)`);
  } catch (e) {
    console.error('  SEC EDGAR error:', e.message);
  }

  // 1c. NewsAPI
  const beforeNewsApi = newItems.length;
  if (process.env.NEWS_API_KEY) {
    try {
      console.log('  Fetching NewsAPI...');
      const from = isoDate(daysAgo(7));
      const newsRes = await fetch(
        `https://newsapi.org/v2/everything?q=retatrutide&language=en&sortBy=publishedAt&pageSize=10&from=${from}`,
        { headers: { 'X-Api-Key': process.env.NEWS_API_KEY }, timeout: FETCH_TIMEOUT }
      );
      const newsData = await newsRes.json();
      const articles = newsData?.articles || [];
      const cutoff = daysAgo(7);
      for (const article of articles) {
        const url = article.url;
        if (!url || processedUrls.has(url)) continue;
        if (new Date(article.publishedAt) < cutoff) continue;
        newItems.push({
          url,
          title: article.title || '',
          description: article.description || '',
          source: 'newsapi',
          priority: 'normal',
          date: article.publishedAt || ''
        });
        processedUrls.add(url);
      }
      console.log(`  NewsAPI: ${articles.length} articles, ${newItems.length - beforeNewsApi} new`);
    } catch (e) {
      console.error('  NewsAPI error:', e.message);
    }
  } else {
    console.log('  NewsAPI: skipped (NEWS_API_KEY not set)');
  }

  // 1d. Google Alerts RSS — GOOGLE_ALERT_RSS (retatrutide) + GOOGLE_ALERT_RSS_2 (LY3437943)
  const rssFeedEnvVars = ['GOOGLE_ALERT_RSS', 'GOOGLE_ALERT_RSS_2'];
  const activeFeeds = rssFeedEnvVars.filter(v => process.env[v]);

  if (activeFeeds.length > 0) {
    const parser = new Parser({ timeout: FETCH_TIMEOUT });
    for (const envVar of activeFeeds) {
      const beforeFeed = newItems.length;
      try {
        console.log(`  Fetching Google Alerts RSS (${envVar})...`);
        const feed   = await parser.parseURL(process.env[envVar]);
        const cutoff = daysAgo(7);
        for (const item of feed.items || []) {
          const url = item.link || item.guid;
          if (!url || processedUrls.has(url)) continue;
          if (item.pubDate && new Date(item.pubDate) < cutoff) continue;
          newItems.push({
            url,
            title: item.title || '',
            description: item.contentSnippet || '',
            source: 'google_alerts',
            priority: 'normal',
            date: item.pubDate || ''
          });
          processedUrls.add(url);
        }
        console.log(`    ${envVar}: ${newItems.length - beforeFeed} new items`);
      } catch (e) {
        console.error(`  Google Alerts RSS (${envVar}) error:`, e.message);
      }
    }
  } else {
    console.log('  Google Alerts RSS: skipped (no GOOGLE_ALERT_RSS env vars set)');
  }

  // 1e. FDA Press Releases RSS
  const beforeFda = newItems.length;
  try {
    console.log('  Fetching FDA Press Releases RSS...');
    const fdaKeywords = ['retatrutide', 'ly3437943', 'lilly obesity', 'triple agonist'];
    const fdaParser = new Parser({ timeout: FETCH_TIMEOUT });
    const fdaFeed   = await fdaParser.parseURL('https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml');
    const cutoff    = daysAgo(7);
    for (const item of fdaFeed.items || []) {
      const url = item.link || item.guid;
      if (!url || processedUrls.has(url)) continue;
      if (item.pubDate && new Date(item.pubDate) < cutoff) continue;
      const text = `${item.title || ''} ${item.contentSnippet || item.content || ''}`.toLowerCase();
      if (!fdaKeywords.some(kw => text.includes(kw))) continue;
      console.log(`  ⚠️  HIGH PRIORITY: FDA — ${item.title}`);
      newItems.push({
        url,
        title: item.title || '',
        description: item.contentSnippet || '',
        source: 'fda_rss',
        priority: 'high',
        date: item.pubDate || ''
      });
      processedUrls.add(url);
    }
    console.log(`  FDA RSS: ${newItems.length - beforeFda} new matched items`);
  } catch (e) {
    console.error('  FDA RSS error:', e.message);
  }

  // 1f. Eli Lilly Investor Relations RSS
  const beforeLilly = newItems.length;
  try {
    console.log('  Fetching Eli Lilly IR RSS...');
    const lillyKeywords = ['retatrutide', 'ly3437943', 'triumph', 'triple agonist obesity'];
    const lillyParser = new Parser({ timeout: FETCH_TIMEOUT });
    const lillyFeed   = await lillyParser.parseURL('https://investor.lilly.com/rss/news-releases.xml');
    const cutoff      = daysAgo(7);
    for (const item of lillyFeed.items || []) {
      const url = item.link || item.guid;
      if (!url || processedUrls.has(url)) continue;
      if (item.pubDate && new Date(item.pubDate) < cutoff) continue;
      const text = `${item.title || ''} ${item.contentSnippet || item.content || ''}`.toLowerCase();
      if (!lillyKeywords.some(kw => text.includes(kw))) continue;
      console.log(`  ⚠️  HIGH PRIORITY: Eli Lilly IR — ${item.title}`);
      newItems.push({
        url,
        title: item.title || '',
        description: item.contentSnippet || '',
        source: 'lilly_ir_rss',
        priority: 'high',
        date: item.pubDate || ''
      });
      processedUrls.add(url);
    }
    console.log(`  Lilly IR RSS: ${newItems.length - beforeLilly} new matched items`);
  } catch (e) {
    console.error('  Lilly IR RSS error:', e.message);
  }

  // 1e. ClinicalTrials.gov
  let trialsMonitored = 0;
  let trialChanges = 0;
  const trialChangeItems = [];
  try {
    console.log('  Fetching ClinicalTrials.gov...');
    const ctEndpoints = [
      'https://clinicaltrials.gov/api/v2/studies?query.term=retatrutide&filter.overallStatus=COMPLETED&pageSize=20&format=json',
      'https://clinicaltrials.gov/api/v2/studies?query.term=retatrutide&filter.overallStatus=ACTIVE_NOT_RECRUITING,RECRUITING&pageSize=20&format=json'
    ];
    const allStudies = [];
    for (const ctUrl of ctEndpoints) {
      const ctRes  = await fetch(ctUrl, { headers: { 'User-Agent': 'glp3md pipeline hello@glp3md.com' }, timeout: FETCH_TIMEOUT });
      const ctData = await ctRes.json();
      allStudies.push(...(ctData?.studies || []));
    }
    const storedTrials = { ...processedNews.trials };
    for (const study of allStudies) {
      const nctId             = study.protocolSection?.identificationModule?.nctId;
      const briefTitle        = study.protocolSection?.identificationModule?.briefTitle || '';
      const overallStatus     = study.protocolSection?.statusModule?.overallStatus || '';
      const primaryCompletion = study.protocolSection?.statusModule?.primaryCompletionDateStruct?.date || '';
      const lastUpdate        = study.protocolSection?.statusModule?.lastUpdatePostDateStruct?.date || '';
      if (!nctId) continue;
      trialsMonitored++;
      processedNews.trials[nctId] = overallStatus;
      const prevStatus = storedTrials[nctId];
      if (prevStatus && prevStatus !== overallStatus) {
        trialChanges++;
        const isNewlyCompleted = overallStatus === 'COMPLETED';
        const item = {
          url: `https://clinicaltrials.gov/study/${nctId}`,
          title: `TRIUMPH trial ${nctId} status changed to ${overallStatus}`,
          description: `${briefTitle} — status changed from ${prevStatus} to ${overallStatus}. Primary completion: ${primaryCompletion}`,
          source: 'clinicaltrials',
          priority: 'high',
          date: lastUpdate,
          _autoGenerate: isNewlyCompleted,
          _triumphTitle: `TRIUMPH ${briefTitle} Phase 3 Complete: What It Means for Retatrutide`
        };
        newItems.push(item);
        trialChangeItems.push(item);
      }
    }
    console.log(`  🔬 ClinicalTrials.gov: ${trialsMonitored} trials monitored, ${trialChanges} status changes detected`);
  } catch (e) {
    console.error('  ClinicalTrials.gov error:', e.message);
  }

  console.log(`\n  📰 Total new items: ${newItems.length}`);

  // Always persist — captures trial status updates even on quiet news weeks
  const updatedUrls = [
    ...processedNews.urls,
    ...newItems.map(i => ({ url: i.url, processedAt: new Date().toISOString() }))
  ];
  writeJSON(NEWS_PATH, { urls: updatedUrls, trials: processedNews.trials });

  let newClusters = [];

  if (newItems.length > 0) {
    // Newly-completed trials bypass Claude — always generate
    const autoItems   = newItems.filter(i => i._autoGenerate);
    const claudeItems = newItems.filter(i => !i._autoGenerate);

    for (const item of autoItems) {
      const slug = item._triumphTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      newClusters.push({
        slug,
        title: item._triumphTitle,
        primary_keyword: 'retatrutide clinical trial results',
        secondary_keywords: ['retatrutide phase 3', 'TRIUMPH trial', 'retatrutide FDA approval'],
        h2_questions: [
          'What did this TRIUMPH trial study?',
          'What were the key results from this trial?',
          'What does trial completion mean for FDA approval?',
          'When could retatrutide be available to patients?'
        ],
        key_data_points: [item.description],
        source_url: item.url,
        priority: 'high',
        news_triggered: true,
        status: 'pending'
      });
    }

    if (claudeItems.length > 0) {
      try {
        console.log('  Sending to Claude for analysis...');
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content:
`You are an SEO strategist for glp3md.com, a retatrutide waitlist and information platform. Here are recent news items about retatrutide: ${JSON.stringify(claudeItems, null, 2)}

For each item determine if it warrants a dedicated blog post.
New trial data, FDA milestones, Lilly announcements = YES.
Minor mentions = NO.

For YES items generate an article brief.

Return ONLY a JSON array, no other text:
[
  {
    "slug": "url-friendly-slug",
    "title": "Article title",
    "primary_keyword": "main keyword",
    "secondary_keywords": ["kw1", "kw2"],
    "h2_questions": ["Q1?", "Q2?", "Q3?"],
    "key_data_points": ["data point 1", "data point 2"],
    "source_url": "url",
    "priority": "high or normal",
    "news_triggered": true,
    "status": "pending"
  }
]

Return empty array [] if no items warrant a post.
IMPORTANT: Only include data points explicitly stated in the source. Never infer or add data from memory.`
          }]
        });

        const raw = msg.content[0]?.text || '';
        const parsed = parseClaudeJSON(raw);
        if (parsed && Array.isArray(parsed)) {
          newClusters = [...newClusters, ...parsed];
          console.log(`  Claude identified ${parsed.length} article briefs from news`);
        }
      } catch (e) {
        console.error('  Claude news analysis error:', e.message);
      }
    }
  }

  // Merge into clusters.json, skip existing slugs
  const clusters = readJSON(CLUSTERS_PATH);
  const existingSlugs = new Set(clusters.map(c => c.slug));
  const toAdd = newClusters.filter(c => c.slug && !existingSlugs.has(c.slug));
  writeJSON(CLUSTERS_PATH, [...clusters, ...toAdd]);
  if (toAdd.length > 0) console.log(`  Added ${toAdd.length} news-triggered clusters`);

  return { newsItemsProcessed: newItems.length, newClusters: toAdd.length, trialsMonitored, trialChanges, trialChangeItems };
}

// ─── Queue Top-Up ────────────────────────────────────────────────────────────
async function topUpQueue(clusters, count) {
  console.log(`  Queue top-up: requesting ${count} new article idea(s)...`);
  const existingTitles = clusters.map(c => c.title).join('\n');
  const research = loadResearch();

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content:
`You are an SEO strategist for glp3md.com, a retatrutide waitlist and information platform.

The following clinical research data is available to ground your article ideas:
${research}

Generate exactly ${count} new blog post idea(s) about retatrutide that are meaningfully different from these existing articles:
${existingTitles}

Stay within these topic areas: retatrutide clinical data, dosing, safety, side effects, patient eligibility, comparisons with other GLP-1/GIP/glucagon medications, FDA regulatory pathway, NDA filing, clinical trial readouts, obesity medicine, metabolic health.
Prioritize topics related to FDA approval, NDA filing, Phase 3 results, TRIUMPH trial, and retatrutide availability — set priority "high" for those, "normal" for all others.
Do not invent trial data. No gray market or compounding topics.

Return ONLY a JSON array, no other text:
[
  {
    "slug": "url-friendly-slug",
    "title": "Article title",
    "primary_keyword": "main keyword",
    "secondary_keywords": ["kw1", "kw2", "kw3"],
    "h2_questions": ["Q1?", "Q2?", "Q3?", "Q4?"],
    "key_data_points": [],
    "source_url": "",
    "priority": "normal",
    "news_triggered": false,
    "status": "pending"
  }
]`
      }]
    });

    const raw = msg.content[0]?.text || '';
    const parsed = parseClaudeJSON(raw);
    if (!parsed || !Array.isArray(parsed)) return;

    const existingSlugs = new Set(clusters.map(c => c.slug));
    const toAdd = parsed.filter(c => c.slug && !existingSlugs.has(c.slug));
    if (toAdd.length > 0) {
      writeJSON(CLUSTERS_PATH, [...clusters, ...toAdd]);
      console.log(`  Queue top-up: added ${toAdd.length} new topic(s)`);
    }
  } catch (e) {
    console.error('  Queue top-up error:', e.message);
  }
}

// ─── Stage 2: Keyword Research ─────────────────────────────────────────────────
async function stage2_keywordResearch() {
  console.log('\n=== STAGE 2: Keyword Research ===');

  // Skip expensive API calls if queue is already healthy
  const queueCheck = readJSON(CLUSTERS_PATH);
  const pendingCount = queueCheck.filter(c => c.status === 'pending').length;
  if (pendingCount >= 3) {
    console.log(`  Queue has ${pendingCount} pending articles — skipping keyword API calls`);
    return { newClusters: 0 };
  }

  // Seeds split into two pools — alternated each Stage 2 call to cap credits at ~120/call
  // Pool A: retatrutide-specific (always high intent)
  // Pool B: broad GLP-1/obesity gateway keywords (funnel traffic)
  const seedPoolA = [
    'retatrutide',
    'retatrutide FDA approval',
    'retatrutide NDA filing',
    'retatrutide approval date 2026',
    'retatrutide phase 3 results',
    'retatrutide TRIUMPH trial',
    'retatrutide side effects',
    'retatrutide vs tirzepatide',
    'retatrutide vs semaglutide',
    'retatrutide vs ozempic',
    'retatrutide vs wegovy',
    'retatrutide cost',
    'retatrutide insurance coverage',
    'retatrutide results',
    'retatrutide dosing',
    'retatrutide weight loss',
    'retatrutide eligibility',
    'retatrutide cardiovascular',
    'retatrutide before and after'
  ];
  const seedPoolB = [
    'retatrutide',
    'best weight loss injection 2026',
    'strongest GLP-1 drug',
    'triple agonist weight loss',
    'new obesity drug better than ozempic',
    'GLP-1 comparison 2026',
    'best GLP-1 for weight loss',
    'new weight loss drug 2026',
    'GLP-1 weight loss results comparison',
    'obesity drug clinical trial 2026',
    'weight loss drug NDA filing 2026',
    'retatrutide vs tirzepatide',
    'retatrutide vs semaglutide',
    'retatrutide FDA approval',
    'retatrutide weight loss',
    'retatrutide results',
    'retatrutide side effects',
    'retatrutide cost',
    'retatrutide phase 3 results'
  ];

  // Alternate pools by week number so each run uses ~19 seeds instead of 30
  const weekNum = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7));
  const seeds = weekNum % 2 === 0 ? seedPoolA : seedPoolB;
  console.log(`  Seed pool: ${weekNum % 2 === 0 ? 'A (retatrutide-specific)' : 'B (broad GLP-1/obesity)'}`);

  let allKeywords = [...seeds];
  // keEnriched stores { keyword, vol, cpc, competition } for keywords where KE returned data
  let keEnriched = [];
  let keCreditsRemaining = null;

  // 2a. Keywords Everywhere
  if (process.env.KE_API_KEY) {
    try {
      console.log('  Fetching Keywords Everywhere...');
      const keRes = await fetch('https://api.keywordseverywhere.com/v1/get_keyword_data', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.KE_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ country: 'us', currency: 'usd', dataSource: 'gkp', kw: seeds }),
        timeout: FETCH_TIMEOUT
      });
      const keData = await keRes.json();
      for (const kw of keData?.data || []) {
        if (!kw.keyword) continue;
        const entry = {
          keyword: kw.keyword,
          vol: kw.vol || 0,
          cpc: kw.cpc?.value || '0',
          competition: kw.competition || 0
        };
        keEnriched.push(entry);
        if (!allKeywords.includes(kw.keyword)) allKeywords.push(kw.keyword);
        for (const rel of kw.related || []) {
          if (!rel.keyword) continue;
          keEnriched.push({
            keyword: rel.keyword,
            vol: rel.vol || 0,
            cpc: rel.cpc?.value || '0',
            competition: rel.competition || 0
          });
          if (!allKeywords.includes(rel.keyword)) allKeywords.push(rel.keyword);
        }
      }
      // Sort enriched list by volume descending, deduplicate by keyword
      const seen = new Set();
      keEnriched = keEnriched
        .filter(e => { if (seen.has(e.keyword)) return false; seen.add(e.keyword); return true; })
        .sort((a, b) => b.vol - a.vol);
      console.log(`  Keywords Everywhere: ${keData?.data?.length || 0} seed results, ${keEnriched.length} enriched keywords`);

      // Check remaining credit balance
      try {
        const balRes = await fetch('https://api.keywordseverywhere.com/v1/account/credits', {
          headers: { 'Authorization': `Bearer ${process.env.KE_API_KEY}`, 'Accept': 'application/json' },
          timeout: FETCH_TIMEOUT
        });
        const balData = await balRes.json();
        const credits = balData?.data?.credits;
        if (credits !== undefined) {
          console.log(`  Keywords Everywhere: ${credits.toLocaleString()} credits remaining`);
          keCreditsRemaining = credits;
        }
      } catch { /* balance check is non-critical */ }
    } catch (e) {
      console.error('  Keywords Everywhere error:', e.message);
    }
  } else {
    console.log('  Keywords Everywhere: skipped (KE_API_KEY not set)');
  }

  // 2b. Google Search Console
  if (process.env.GSC_CLIENT_ID && process.env.GSC_CLIENT_SECRET && process.env.GSC_REFRESH_TOKEN) {
    try {
      console.log('  Fetching Google Search Console...');
      const oauth2Client = new google.auth.OAuth2(
        process.env.GSC_CLIENT_ID,
        process.env.GSC_CLIENT_SECRET
      );
      oauth2Client.setCredentials({ refresh_token: process.env.GSC_REFRESH_TOKEN });

      const webmasters = google.webmasters({ version: 'v3', auth: oauth2Client });
      const gscRes = await webmasters.searchanalytics.query({
        siteUrl: 'sc-domain:glp3md.com',
        requestBody: {
          startDate: isoDate(daysAgo(90)),
          endDate:   isoDate(new Date()),
          dimensions: ['query'],
          rowLimit: 250
        }
      });

      const gscRows = gscRes.data?.rows || [];
      // Capture all queries — sorted by impressions desc, skip navigational/branded non-content queries
      const gscKws = gscRows
        .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
        .map(r => r.keys?.[0])
        .filter(k => k && !['glp3md', 'glp 3 md', 'glp3md.com'].includes(k.toLowerCase()));

      for (const kw of gscKws) {
        if (!allKeywords.includes(kw)) allKeywords.push(kw);
      }
      console.log(`  GSC: ${gscKws.length} queries (all intents, sorted by impressions)`);
    } catch (e) {
      console.error('  Google Search Console error:', e.message);
    }
  } else {
    console.log('  Google Search Console: skipped (GSC credentials not set)');
  }

  // Deduplicate
  allKeywords = [...new Set(allKeywords.map(k => k.toLowerCase().trim()))];
  console.log(`  Total unique keywords: ${allKeywords.length}`);

  // Ask Claude to cluster
  let newClusters = [];
  try {
    console.log('  Sending to Claude for clustering...');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content:
(() => {
  const questionKws = keEnriched
    .filter(e => /^(how|what|when|why|is|can|does|will|which|where)\b/i.test(e.keyword))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 30);

  return `You are an SEO strategist for glp3md.com, a retatrutide waitlist and information platform that only covers legitimate FDA-approval-track access — no gray market, no compounding.

${keEnriched.length > 0
  ? `Here are keywords with real search volume data (vol = monthly US searches, cpc = cost-per-click in USD, competition = 0–1):\n${JSON.stringify(keEnriched.slice(0, 60), null, 2)}\n\nAdditional keywords without volume data:\n${JSON.stringify(allKeywords.filter(k => !keEnriched.find(e => e.keyword === k)), null, 2)}`
  : `Here are keywords: ${JSON.stringify(allKeywords, null, 2)}`
}

${questionKws.length > 0 ? `The following are real search queries people type (sorted by monthly volume). Use them VERBATIM as H2 headings where they match the cluster topic — do not paraphrase:\n${questionKws.map(e => `• "${e.keyword}" (vol: ${e.vol})`).join('\n')}` : ''}

Group into article clusters. Each cluster = one article. Rules:
- Ignore any keywords related to: buying, peptides, gray market, compounding, 'for sale', 'where to buy', 'near me', 'online'
- Choose the highest-volume keyword in each cluster as the primary_keyword
- For h2_questions: use verbatim search queries from the list above where they fit; only invent questions if no matching query exists
- Set priority to "high" for any cluster covering: FDA approval, NDA filing, regulatory timeline, Phase 3 readouts, TRIUMPH trial results, or retatrutide availability date
- Set priority to "normal" for all other topics
- Aim for topics with meaningful search volume (vol > 100) where possible

Return ONLY a JSON array, no other text:
[
  {
    "slug": "url-friendly-slug",
    "title": "Article title",
    "primary_keyword": "highest-volume keyword for this cluster",
    "secondary_keywords": ["kw1", "kw2", "kw3"],
    "h2_questions": ["verbatim search query as H2?", "Q2?", "Q3?", "Q4?"],
    "key_data_points": [],
    "source_url": "",
    "priority": "high or normal — high only for FDA/NDA/approval/Phase3/TRIUMPH topics",
    "news_triggered": false,
    "status": "pending"
  }
]`;
})()
      }]
    });

    const raw = msg.content[0]?.text || '';
    const parsed = parseClaudeJSON(raw);
    if (parsed && Array.isArray(parsed)) {
      // Enrich each cluster with KE score and top keywords
      newClusters = parsed.map(cluster => {
        const allClusterKws = [cluster.primary_keyword, ...(cluster.secondary_keywords || [])];
        const matched = allClusterKws
          .map(kw => keEnriched.find(e => e.keyword.toLowerCase() === kw.toLowerCase()))
          .filter(Boolean)
          .sort((a, b) => b.vol - a.vol);

        const topKw = matched[0];
        const ke_score = topKw
          ? Math.round(topKw.vol * parseFloat(topKw.cpc) * (1 - topKw.competition))
          : 0;
        const ke_top_keywords = matched.slice(0, 3).map(e => ({
          keyword: e.keyword, vol: e.vol, cpc: e.cpc
        }));

        return { ...cluster, ke_score, ke_top_keywords };
      });
      console.log(`  Claude identified ${newClusters.length} keyword clusters`);
    }
  } catch (e) {
    console.error('  Claude keyword clustering error:', e.message);
  }

  // Merge into clusters.json — skip any slug that already has a published file
  const clusters = readJSON(CLUSTERS_PATH);
  const existingSlugs = new Set(clusters.map(c => c.slug));
  const toAdd = newClusters.filter(c => {
    if (!c.slug) return false;
    if (existingSlugs.has(c.slug)) return false;
    if (fs.existsSync(path.join(BLOG_DIR, c.slug, 'index.html'))) {
      console.log(`  ⚠️  Skipping cluster "${c.slug}" — blog file already exists`);
      return false;
    }
    return true;
  });
  writeJSON(CLUSTERS_PATH, [...clusters, ...toAdd]);
  if (toAdd.length > 0) console.log(`  Added ${toAdd.length} keyword-driven clusters`);

  // Top-up: one Claude call to fill queue to 3 pending if still short
  const updatedClusters = readJSON(CLUSTERS_PATH);
  const stillPending = updatedClusters.filter(c => c.status === 'pending').length;
  const topUpNeeded = Math.max(3 - stillPending, 0);
  if (topUpNeeded > 0) await topUpQueue(updatedClusters, topUpNeeded);

  return { newClusters: toAdd.length, keCreditsRemaining };
}

// ─── Stage 3.5: Internal Linking Engine ──────────────────────────────────────
async function injectInternalLinks(cluster, outputPath, clusters) {
  const linkable = clusters.filter(c =>
    c.slug !== cluster.slug && ['review', 'published'].includes(c.status)
  );
  if (linkable.length === 0) return;

  let html = fs.readFileSync(outputPath, 'utf8');

  // Extract article body text for Claude
  const bodyMatch = html.match(/<p class="post-meta">[\s\S]*?<\/p>([\s\S]*?)<div class="post-cta">/);
  if (!bodyMatch) return;
  const bodyText = bodyMatch[1];

  try {
    const linkableArticles = linkable.map(c => ({
      title: c.title,
      primary_keyword: c.primary_keyword,
      url: `/blog/${c.slug}/`
    }));

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content:
`You are an SEO specialist. Find up to 5 internal link opportunities in this article body.

Article body:
${bodyText.slice(0, 3000)}

Existing articles to link to:
${JSON.stringify(linkableArticles, null, 2)}

Match natural phrases from the article body to the most relevant existing article.

Return ONLY a JSON array (no other text):
[{"anchor": "exact phrase from article body", "url": "/blog/slug/"}]

Rules:
- anchor must be an exact substring present in the article body
- Each url used at most once
- Only suggest links where the match is genuinely relevant
- Return [] if no good matches exist`
      }]
    });

    const raw = msg.content[0]?.text || '';
    const suggestions = parseClaudeJSON(raw);
    if (!suggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
      console.log('  🔗 Internal links: no opportunities found');
      return;
    }

    // Inject links — split around existing <a> blocks to avoid nesting
    let injectedCount = 0;
    for (const { anchor, url } of suggestions) {
      if (!anchor || !url || !html.includes(anchor)) continue;
      const segments = html.split(/(<a[\s\S]*?<\/a>)/i);
      let done = false;
      for (let i = 0; i < segments.length; i++) {
        if (/^<a/i.test(segments[i])) continue;
        if (!done && segments[i].includes(anchor)) {
          segments[i] = segments[i].replace(anchor, `<a href="${url}">${anchor}</a>`);
          done = true;
        }
      }
      if (done) { html = segments.join(''); injectedCount++; }
    }

    if (injectedCount > 0) {
      fs.writeFileSync(outputPath, html, 'utf8');
      console.log(`  🔗 Internal links injected: ${injectedCount}`);
    }
  } catch (e) {
    console.error('  Internal linking error:', e.message);
  }
}

// ─── Stage 3: Article Generation ─────────────────────────────────────────────
async function stage3_articleGeneration() {
  console.log('\n=== STAGE 3: Article Generation ===');

  const clusters = readJSON(CLUSTERS_PATH);
  const template  = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  // Sort: high priority → news_triggered → original order
  const pending = clusters
    .map((c, i) => ({ ...c, _idx: i }))
    .filter(c => c.status === 'pending')
    .sort((a, b) => {
      if (a.priority === 'high' && b.priority !== 'high') return -1;
      if (b.priority === 'high' && a.priority !== 'high') return 1;
      if (a.news_triggered && !b.news_triggered) return -1;
      if (b.news_triggered && !a.news_triggered) return 1;
      // Score by vol × cpc × (1 - competition) — highest commercial intent first
      const scoreA = a.ke_score || 0;
      const scoreB = b.ke_score || 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a._idx - b._idx;
    });

  console.log(`  Found ${pending.length} pending clusters`);

  const generated = [];
  let updatedBlogIndex = fs.readFileSync(BLOG_INDEX, 'utf8');

  for (const cluster of pending.slice(0, 1)) {
    console.log(`\n  Generating: "${cluster.title}"`);

    // Safety: never overwrite a cluster already in review/published
    const live = clusters.find(c => c.slug === cluster.slug);
    if (live && ['review', 'published'].includes(live.status)) {
      console.log(`  ⚠️  Skipping ${cluster.slug} — already '${live.status}'`);
      continue;
    }

    const outputDir  = path.join(BLOG_DIR, cluster.slug);
    const outputPath = path.join(outputDir, 'index.html');

    if (fs.existsSync(outputPath)) {
      console.log(`  ⚠️  File already exists — skipping /blog/${cluster.slug}/index.html`);
      continue;
    }

    try {
      // Generate article body
      const research = loadResearch();
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content:
`You are a board-certified obesity medicine physician writing for glp3md.com, a retatrutide waitlist and information platform. Write a clinical blog post.

The following peer-reviewed clinical data is provided for accuracy. Use these figures when relevant — do not invent alternatives:
${research}

Title: ${cluster.title}
Primary keyword: ${cluster.primary_keyword}
Secondary keywords: ${JSON.stringify(cluster.secondary_keywords)}
${cluster.ke_top_keywords?.length ? `Top keywords by search volume (use naturally in headings and body): ${cluster.ke_top_keywords.map(k => `"${k.keyword}" (${k.vol.toLocaleString()}/mo)`).join(', ')}` : ''}
H2 sections to cover: ${JSON.stringify(cluster.h2_questions)}
Key data points to include: ${JSON.stringify(cluster.key_data_points)}
Source to cite: ${cluster.source_url || 'none'}

Requirements:
- 900-1100 words
- Clinical accuracy — reference TRIUMPH-4 data where relevant (28.7% mean weight loss, 68 weeks, Phase 3)
- Patient-friendly prose using terms like 'reta', 'food noise', 'triple agonist'
- Include one comparison table where relevant
- Never mention compounding, gray market, or peptide vendors
- Never fabricate statistics — only use data provided above or well-known TRIUMPH-4 figures
- End with one paragraph encouraging readers to join the waitlist
- Never use first-person language (I, me, we, our physicians)
- Never write "clinicians use reta" — only patient communities use this shorthand; write "commonly referred to as reta in patient communities"
- Brand name is always "glp3md" — never "GLP-3 MD", "GLP3MD", or "GLP-3MD"
- Semaglutide STEP-1 trial duration is 68 weeks, not 72
- Tirzepatide SURMOUNT-1 mean weight loss is 20.9% at 15mg, not 22.5%
- All CTA links must use https://www.glp3md.com (never http or non-www)
- Never fabricate company names, study authors, or citation details
- If citing a source_url, only include data explicitly stated in that source — never infer or add data from memory
- Never describe glp3md as a "physician-supervised platform" or any variant of that phrase
- Never promise or imply that readers will receive medication, treatment, or a prescription — retatrutide is not FDA-approved; the waitlist is for informational purposes only
- When encouraging readers to join the waitlist, include a clear disclaimer that no promises are made about treatment or medication availability

Return ONLY the article body HTML using these tags only:
<h2>, <h3>, <p>, <ul>, <li>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <strong>, <em>, <a>
No <html>, <head>, <body>, <nav>, <footer> tags.
No inline styles.`
        }]
      });

      const articleBody = msg.content[0]?.text?.trim() || '';
      if (!articleBody) {
        console.error(`  ⚠️  Claude returned empty body — skipping ${cluster.slug}`);
        continue;
      }

      // Date strings
      const today      = new Date();
      const todayISO   = isoDate(today);
      const todayLong  = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const todayShort = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const readMin    = Math.ceil(countWords(articleBody) / 200);
      const category   = deriveCategory(cluster.slug, cluster.news_triggered);
      const canonical  = `https://www.glp3md.com/blog/${cluster.slug}/`;

      // Meta description ≤155 chars — seed with top KE keywords by volume when available
      const topKwTerms = cluster.ke_top_keywords?.length
        ? cluster.ke_top_keywords.map(k => k.keyword)
        : cluster.secondary_keywords?.slice(0, 2) || [];
      let metaDesc = topKwTerms.length
        ? `${cluster.title} — ${topKwTerms.slice(0, 2).join(', ')}. Learn more at glp3md.com.`
        : `${cluster.title}. Learn more at glp3md.com.`;
      if (metaDesc.length > 155) metaDesc = metaDesc.slice(0, 152) + '...';

      // Build page HTML from template
      let html = template;

      html = html.replace(/<title>[^<]*<\/title>/,
        `<title>${escapeHtml(cluster.title)} | glp3md</title>`);

      html = html.replace(/<meta name="description" content="[^"]*"/,
        `<meta name="description" content="${escapeHtml(metaDesc)}"`);

      html = html.replace(/<link rel="canonical" href="[^"]*"/,
        `<link rel="canonical" href="${canonical}"`);

      html = html.replace(/<meta property="og:url" content="[^"]*"/,
        `<meta property="og:url" content="${canonical}"`);

      // Add or update og:title
      if (html.includes('<meta property="og:title"')) {
        html = html.replace(/<meta property="og:title" content="[^"]*"/,
          `<meta property="og:title" content="${escapeHtml(cluster.title)}"`);
      } else {
        html = html.replace(/<meta property="og:image"/,
          `<meta property="og:title" content="${escapeHtml(cluster.title)}">\n  <meta property="og:image"`);
      }

      // Update JSON-LD
      html = html.replace(/"headline":\s*"[^"]*"/,
        `"headline": "${escapeJson(cluster.title)}"`);
      html = html.replace(
        /("description":\s*)"[^"]*"(,\s*"url")/,
        `$1"${escapeJson(metaDesc)}"$2`
      );
      html = html.replace(
        /"url":\s*"https:\/\/glp3md\.com\/blog\/[^"]*"/,
        `"url": "${canonical}"`
      );
      html = html.replace(/"datePublished":\s*"[^"]*"/, `"datePublished": "${todayISO}"`);
      html = html.replace(/"dateModified":\s*"[^"]*"/,  `"dateModified": "${todayISO}"`);

      // Update visible content
      html = html.replace(/<div class="post-eyebrow">[^<]*<\/div>/,
        `<div class="post-eyebrow">${category}</div>`);

      html = html.replace(/<h1>[^<]*<\/h1>/,
        `<h1>${escapeHtml(cluster.title)}</h1>`);

      html = html.replace(/<p class="post-meta">[^<]*<\/p>/,
        `<p class="post-meta">${todayLong} &nbsp;·&nbsp; ${readMin} min read</p>`);

      // Replace article body (between closing post-meta and opening post-cta)
      html = html.replace(
        /(<p class="post-meta">.*?<\/p>)([\s\S]*?)(<div class="post-cta">)/,
        `$1\n\n    ${articleBody}\n\n    $3`
      );

      // Save file
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, html, 'utf8');

      // Inject internal links
      await injectInternalLinks(cluster, outputPath, clusters);

      // Mark cluster as 'review'
      const idx = clusters.findIndex(c => c.slug === cluster.slug);
      if (idx !== -1) clusters[idx].status = 'review';
      writeJSON(CLUSTERS_PATH, clusters);

      // Prepend card to blog/index.html
      const newCard =
`
      <a class="article-card" href="/blog/${cluster.slug}/">
        <div class="card-tag">${category}</div>
        <div class="card-title">${escapeHtml(cluster.title)}</div>
        <p class="card-excerpt">${escapeHtml(metaDesc)}</p>
        <div class="card-meta">${todayShort} &nbsp;·&nbsp; ${readMin} min read</div>
      </a>`;

      updatedBlogIndex = updatedBlogIndex.replace(
        /(<div class="article-grid">)/,
        `$1\n${newCard}`
      );

      generated.push(cluster.title);
      console.log(`  ✅ Generated: ${cluster.title}`);
      console.log(`  📁 File: /blog/${cluster.slug}/index.html`);
      console.log(`  🔍 Review before publishing`);

    } catch (e) {
      console.error(`  ❌ Error generating "${cluster.slug}":`, e.message);
    }
  }

  // Write updated blog index once after all articles
  if (generated.length > 0) {
    fs.writeFileSync(BLOG_INDEX, updatedBlogIndex, 'utf8');
    console.log(`\n  Updated blog/index.html with ${generated.length} new card(s)`);
  }

  return { articlesGenerated: generated };
}

// ─── Stage 4: Summary ─────────────────────────────────────────────────────────
function stage4_summary(newsResult, kwResult, genResult, pingResult) {
  const all          = readJSON(CLUSTERS_PATH);
  const review       = all.filter(c => c.status === 'review');
  const highPriority = review.filter(c => c.priority === 'high');

  const lines = [
    '',
    '=== PIPELINE COMPLETE ===',
    `📰 News items processed: ${newsResult.newsItemsProcessed}`,
    `🔬 TRIUMPH trials monitored: ${newsResult.trialsMonitored}`,
    `📡 Trial status changes: ${newsResult.trialChanges}` +
      (newsResult.trialChanges ? '\n   ' + newsResult.trialChangeItems.map(i => i.title).join('\n   ') : ''),
    `🔍 New keyword clusters identified: ${kwResult.newClusters}`,
    kwResult.keCreditsRemaining != null ? `💳 KE credits remaining: ${kwResult.keCreditsRemaining.toLocaleString()}` : null,
    `✅ Articles generated: ${genResult.articlesGenerated.length}`,
    `⚠️  High priority items: ${highPriority.length}` +
      (highPriority.length ? '\n   ' + highPriority.map(c => c.title).join('\n   ') : ''),
    `📋 Articles awaiting review: ${review.length}` +
      (review.length ? '\n   ' + review.map(c => c.title).join('\n   ') : ''),
    `🗺️  Sitemap pinged: ${pingResult ? 'yes' : 'no'}`,
    '================================'
  ];
  lines.filter(l => l !== null).forEach(l => console.log(l));

  const summaryText = [
    '=== PIPELINE COMPLETE ===',
    `Date: ${new Date().toISOString()}`,
    `News items processed: ${newsResult.newsItemsProcessed}`,
    `TRIUMPH trials monitored: ${newsResult.trialsMonitored}`,
    `Trial status changes: ${newsResult.trialChanges}`,
    ...newsResult.trialChangeItems.map(i => `  - ${i.title}`),
    `New keyword clusters identified: ${kwResult.newClusters}`,
    `Articles generated: ${genResult.articlesGenerated.length}`,
    `High priority items: ${highPriority.length}`,
    ...highPriority.map(c => `  - ${c.title}`),
    `Articles awaiting review: ${review.length}`,
    ...review.map(c => `  - ${c.title}`),
    `Sitemap pinged: ${pingResult ? 'yes' : 'no'}`,
    '================================'
  ].join('\n');

  fs.writeFileSync(path.join(ROOT, 'pipeline-summary.txt'), summaryText, 'utf8');
}

// ─── Stage 5: Notify Google ───────────────────────────────────────────────────
async function stage5_sitemapPing() {
  console.log('\n=== STAGE 5: Notify Google ===');
  try {
    const res = await fetch('https://www.google.com/ping?sitemap=https://www.glp3md.com/api/sitemap', { timeout: FETCH_TIMEOUT });
    if (res.ok) {
      console.log('  ✅ Google notified — sitemap ping successful');
      return true;
    }
    console.log(`  ⚠️  Sitemap ping failed (${res.status}) — Google will crawl on its own schedule`);
    return false;
  } catch (e) {
    console.log('  ⚠️  Sitemap ping failed — Google will crawl on its own schedule');
    return false;
  }
}

// ─── Stage 6: Article Freshness Updater ──────────────────────────────────────
async function stage6_freshnessUpdater() {
  console.log('\n=== STAGE 6: Article Freshness Updater ===');
  const { execSync } = require('child_process');
  const clusters  = readJSON(CLUSTERS_PATH);
  const published = clusters.filter(c => c.status === 'published');

  if (published.length === 0) {
    console.log('  No published articles to check');
    return;
  }

  const threshold = daysAgo(30);
  let updated = 0;

  for (const cluster of published) {
    const filePath = path.join(BLOG_DIR, cluster.slug, 'index.html');
    if (!fs.existsSync(filePath)) continue;

    try {
      const gitDate = execSync(
        `git -C "${ROOT}" log -1 --format="%ai" -- "blog/${cluster.slug}/index.html"`,
        { encoding: 'utf8' }
      ).trim();

      if (!gitDate || new Date(gitDate) > threshold) continue;

      let html = fs.readFileSync(filePath, 'utf8');
      const todayISO  = isoDate(new Date());
      const todayLong = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      // Update JSON-LD dateModified
      html = html.replace(/"dateModified":\s*"[^"]*"/, `"dateModified": "${todayISO}"`);

      // Add or update last-updated paragraph below post-meta
      const freshTag = `<p class="post-meta last-updated">Last updated: ${todayLong}</p>`;
      if (html.includes('class="post-meta last-updated"')) {
        html = html.replace(/<p class="post-meta last-updated">.*?<\/p>/, freshTag);
      } else {
        html = html.replace(
          /(<p class="post-meta">.*?<\/p>)/,
          `$1\n    ${freshTag}`
        );
      }

      fs.writeFileSync(filePath, html, 'utf8');
      updated++;
      console.log(`  🔄 Refreshed: /blog/${cluster.slug}/`);
    } catch (e) {
      console.error(`  Error checking ${cluster.slug}:`, e.message);
    }
  }

  console.log(`  Freshness check complete: ${updated} of ${published.length} articles refreshed`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 glp3md content pipeline starting...');
  console.log(`   ${new Date().toISOString()}`);

  let newsResult = { newsItemsProcessed: 0, newClusters: 0, trialsMonitored: 0, trialChanges: 0, trialChangeItems: [] };
  let kwResult   = { newClusters: 0 };
  let genResult  = { articlesGenerated: [] };
  let pingResult = false;

  try { newsResult = await stage1_newsMonitoring(); }
  catch (e) { console.error('Stage 1 fatal error:', e.message); }

  try { kwResult = await stage2_keywordResearch(); }
  catch (e) { console.error('Stage 2 fatal error:', e.message); }

  try { genResult = await stage3_articleGeneration(); }
  catch (e) { console.error('Stage 3 fatal error:', e.message); }

  if (genResult.articlesGenerated.length > 0) {
    try { pingResult = await stage5_sitemapPing(); }
    catch (e) { console.error('Stage 5 fatal error:', e.message); }
  }

  try { await stage6_freshnessUpdater(); }
  catch (e) { console.error('Stage 6 fatal error:', e.message); }

  stage4_summary(newsResult, kwResult, genResult, pingResult);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('Pipeline failed:', e);
    process.exit(1);
  });
