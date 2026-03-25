// Netlify Function: Proxy for downloading a single audio channel from Genesys Cloud.
// This bypasses CORS - the server fetches from S3, returns to browser.
// Frontend calls this twice (once per channel), then merges in-browser.

const https = require('https');
const http = require('http');

function fetchBuffer(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location, {}).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { url, token } = params;

  // Mode 1: Proxy a direct audio URL (S3 pre-signed URL)
  if (url) {
    try {
      const audio = await fetchBuffer(url);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        },
        body: audio.toString('base64'),
        isBase64Encoded: true
      };
    } catch (e) {
      return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Mode 2: Get metadata (channel URLs)
  const { cid, rid, region } = params;
  if (cid && rid && token && region) {
    try {
      const apiUrl = `https://api.${region}/api/v2/conversations/${cid}/recordings/${rid}?formatId=WAV`;
      const buf = await fetchBuffer(apiUrl, { 'Authorization': 'Bearer ' + token });
      const data = JSON.parse(buf.toString());
      const uris = data.mediaUris || {};
      const keys = Object.keys(uris).sort();
      const urls = keys.map(k => uris[k]?.mediaUri).filter(Boolean);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ urls, sampleRate: 8000 })
      };
    } catch (e) {
      return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Missing params. Use ?url= or ?cid=&rid=&token=&region=' }) };
};
