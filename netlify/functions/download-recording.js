// Netlify Function: Proxy for Genesys Cloud recording download
// Fetches recording metadata, downloads both audio channels server-side,
// merges them into a single WAV file, and returns to browser.
// This bypasses CORS because server-to-server requests have no CORS restrictions.

const https = require('https');
const http = require('http');

function fetchUrl(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: headers || {} }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, {}).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJson(url, headers) {
  return fetchUrl(url, headers).then(buf => JSON.parse(buf.toString()));
}

// Simple WAV parser - extract raw PCM samples
function parseWav(buf) {
  // Find "data" chunk
  let offset = 12; // skip RIFF header
  let sampleRate = 8000, bitsPerSample = 16, numChannels = 1, dataStart = 44, dataSize = 0;
  
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      numChannels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataStart = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }
  
  const samples = [];
  const bytesPerSample = bitsPerSample / 8;
  for (let i = 0; i < dataSize; i += bytesPerSample) {
    if (dataStart + i + bytesPerSample > buf.length) break;
    if (bitsPerSample === 16) {
      samples.push(buf.readInt16LE(dataStart + i));
    } else if (bitsPerSample === 8) {
      samples.push((buf.readUInt8(dataStart + i) - 128) * 256);
    }
  }
  
  return { sampleRate, bitsPerSample: 16, numChannels, samples };
}

// Create stereo WAV from two mono channels
function createStereoWav(ch0, ch1, sampleRate) {
  const numSamples = Math.max(ch0.length, ch1.length);
  const numChannels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const bufSize = 44 + dataSize;
  
  const buf = Buffer.alloc(bufSize);
  
  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(bufSize - 8, 4);
  buf.write('WAVE', 8);
  
  // fmt chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  
  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    // Left channel (ch0)
    const s0 = i < ch0.length ? ch0[i] : 0;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, s0)), offset);
    offset += 2;
    // Right channel (ch1)
    const s1 = i < ch1.length ? ch1[i] : 0;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, s1)), offset);
    offset += 2;
  }
  
  return buf;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { cid, rid, token, region } = params;
  
  if (!cid || !rid || !token || !region) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters: cid, rid, token, region' }) };
  }
  
  try {
    // Step 1: Get recording metadata with WAV format (to get both channel URLs)
    const apiUrl = `https://api.${region}/api/v2/conversations/${cid}/recordings/${rid}?formatId=WAV`;
    const metadata = await fetchJson(apiUrl, { 'Authorization': 'Bearer ' + token });
    
    if (!metadata.mediaUris) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No mediaUris found' }) };
    }
    
    const keys = Object.keys(metadata.mediaUris).sort();
    const urls = keys.map(k => metadata.mediaUris[k]?.mediaUri).filter(Boolean);
    
    if (urls.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No audio URLs found' }) };
    }
    
    if (urls.length === 1) {
      // Single channel - just proxy it through
      const audio = await fetchUrl(urls[0]);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Disposition': `attachment; filename="recording_${cid}.wav"`,
          'Access-Control-Allow-Origin': '*'
        },
        body: audio.toString('base64'),
        isBase64Encoded: true
      };
    }
    
    // Step 2: Download both channels
    const [buf0, buf1] = await Promise.all(urls.map(u => fetchUrl(u)));
    
    // Step 3: Parse WAV files
    const wav0 = parseWav(buf0);
    const wav1 = parseWav(buf1);
    
    // Step 4: Merge into stereo WAV
    const merged = createStereoWav(wav0.samples, wav1.samples, wav0.sampleRate);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Disposition': `attachment; filename="recording_${cid}.wav"`,
        'Access-Control-Allow-Origin': '*'
      },
      body: merged.toString('base64'),
      isBase64Encoded: true
    };
    
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
