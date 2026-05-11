'use strict';

// One-time script to get a GSC refresh token.
// Usage: GSC_CLIENT_ID=xxx GSC_CLIENT_SECRET=xxx node scripts/get-gsc-token.js

const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID     = process.env.GSC_CLIENT_ID;
const CLIENT_SECRET = process.env.GSC_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3456';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GSC_CLIENT_ID and GSC_CLIENT_SECRET env vars first.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/indexing',
  ]
});

console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Authorize the app. You will be redirected to localhost:3456.');
console.log('   Waiting for callback...\n');

const server = http.createServer(async (req, res) => {
  const code = url.parse(req.url, true).query.code;
  if (!code) {
    res.end('No code found. Try again.');
    return;
  }

  res.end('<h2>Done! Check your terminal for the refresh token.</h2>');
  server.close();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('✅ Success!\n');
    console.log('Add these to your GitHub Secrets:\n');
    console.log(`GSC_CLIENT_ID:     ${CLIENT_ID}`);
    console.log(`GSC_CLIENT_SECRET: ${CLIENT_SECRET}`);
    console.log(`GSC_REFRESH_TOKEN: ${tokens.refresh_token}`);
    console.log('');
  } catch (e) {
    console.error('Error getting tokens:', e.message);
  }
});

server.listen(3456);
