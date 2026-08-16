'use strict';

const { PassThrough } = require('stream');
const path = require('path');

/**
 * Reads a request/response body into memory. If it grows past `limit`, collection is
 * abandoned and a stream containing everything (buffered + remaining) is returned so the
 * payload can still be forwarded without buffering it all.
 */
function collectBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('aborted', onEnd);
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        settled = true;
        cleanup();
        const passthrough = new PassThrough();
        for (const c of chunks) passthrough.write(c);
        stream.pipe(passthrough);
        stream.resume();
        resolve({ body: Buffer.alloc(0), truncated: true, size, stream: passthrough });
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ body: Buffer.concat(chunks), truncated: false, size, stream: null });
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('aborted', onEnd);
    stream.on('error', onError);
  });
}

const EXT_TYPES = {
  '.js': 'script', '.mjs': 'script', '.cjs': 'script', '.ts': 'script',
  '.css': 'stylesheet',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.svg': 'image', '.ico': 'image', '.bmp': 'image', '.avif': 'image',
  '.woff': 'font', '.woff2': 'font', '.ttf': 'font', '.otf': 'font', '.eot': 'font',
  '.mp4': 'media', '.webm': 'media', '.mp3': 'media', '.ogg': 'media', '.wav': 'media',
  '.json': 'xhr',
  '.html': 'document', '.htm': 'document'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.zip': 'application/zip'
};

const RESOURCE_TYPES = [
  'document', 'stylesheet', 'script', 'image', 'font', 'xhr', 'media', 'websocket', 'other'
];

function mimeForPath(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** Best-effort classification of a request, mirroring the DevTools "type" column. */
function detectResourceType(method, url, headers) {
  const h = lowerKeys(headers);
  if (String(h.upgrade || '').toLowerCase() === 'websocket') return 'websocket';

  const dest = h['sec-fetch-dest'];
  if (dest && dest !== 'empty') {
    const map = {
      document: 'document', iframe: 'document', frame: 'document', embed: 'document',
      style: 'stylesheet', script: 'script', worker: 'script', sharedworker: 'script',
      serviceworker: 'script', image: 'image', font: 'font', audio: 'media',
      video: 'media', track: 'media', manifest: 'other', object: 'other'
    };
    if (map[dest]) return map[dest];
  }
  if (dest === 'empty') return 'xhr';

  const requestedWith = String(h['x-requested-with'] || '').toLowerCase();
  if (requestedWith === 'xmlhttprequest') return 'xhr';

  const accept = String(h.accept || '');
  if (accept.includes('text/css')) return 'stylesheet';
  if (accept.includes('image/')) return 'image';
  if (accept.includes('application/json')) return 'xhr';
  if (accept.includes('text/html') && method === 'GET') return 'document';

  const pathname = safePathname(url);
  const ext = path.extname(pathname).toLowerCase();
  if (EXT_TYPES[ext]) return EXT_TYPES[ext];
  if (method !== 'GET') return 'xhr';
  return 'other';
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url).split('?')[0];
  }
}

function lowerKeys(obj) {
  const out = {};
  for (const key of Object.keys(obj || {})) out[key.toLowerCase()] = obj[key];
  return out;
}

/** Converts a Node raw header array into an ordered list of [name, value] pairs. */
function rawToPairs(raw) {
  const pairs = [];
  for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
  return pairs;
}

function pairsToObject(pairs) {
  const out = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

function getHeader(pairs, name) {
  const target = name.toLowerCase();
  for (const [key, value] of pairs) if (key.toLowerCase() === target) return value;
  return undefined;
}

function setHeader(pairs, name, value) {
  const target = name.toLowerCase();
  let replaced = false;
  for (let i = pairs.length - 1; i >= 0; i--) {
    if (pairs[i][0].toLowerCase() !== target) continue;
    if (replaced) pairs.splice(i, 1);
    else {
      pairs[i] = [pairs[i][0], String(value)];
      replaced = true;
    }
  }
  if (!replaced) pairs.push([name, String(value)]);
  return pairs;
}

function addHeader(pairs, name, value) {
  pairs.push([name, String(value)]);
  return pairs;
}

function removeHeader(pairs, name) {
  const target = name.toLowerCase();
  for (let i = pairs.length - 1; i >= 0; i--) {
    if (pairs[i][0].toLowerCase() === target) pairs.splice(i, 1);
  }
  return pairs;
}

const BINARY_HINTS = /^(image|audio|video|font)\//i;

function isProbablyText(contentType, buffer) {
  const type = String(contentType || '').toLowerCase();
  if (BINARY_HINTS.test(type)) return false;
  if (/^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|graphql))/.test(type)) return true;
  if (!buffer || buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

function wildcardToRegExp(pattern, flags) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = '^' + escaped.replace(/\*/g, '(.*)').replace(/\?/g, '(.)') + '$';
  return new RegExp(source, flags);
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

let counter = 0;
function nextId(prefix = 'f') {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

module.exports = {
  collectBody,
  detectResourceType,
  mimeForPath,
  lowerKeys,
  rawToPairs,
  pairsToObject,
  getHeader,
  setHeader,
  addHeader,
  removeHeader,
  isProbablyText,
  wildcardToRegExp,
  formatBytes,
  nextId,
  RESOURCE_TYPES,
  MIME_TYPES
};
