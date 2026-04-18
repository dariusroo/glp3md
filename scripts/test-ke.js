'use strict';

const fetch = require('node-fetch');

async function main() {
  const key = process.env.KE_API_KEY;
  if (!key) { console.error('KE_API_KEY not set'); process.exit(1); }

  console.log('Calling Keywords Everywhere with keyword: "retatrutide"...');

  const res = await fetch('https://api.keywordseverywhere.com/v1/get_keyword_data', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ country: 'us', currency: 'usd', dataSource: 'gkp', kw: ['retatrutide'] }),
    timeout: 30000
  });

  console.log('HTTP status:', res.status);
  const text = await res.text();
  console.log('Raw response:', text);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
