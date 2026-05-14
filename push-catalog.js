/**
 * push-catalog.js
 * Sube el catalogo_cache.json local a Railway.
 * Uso: node push-catalog.js <url-railway> <session-token>
 *
 * Ejemplo:
 *   node push-catalog.js https://ml-panel-testing-testing.up.railway.app tu-token-aqui
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const url   = require('url');

const CACHE_FILE = path.join(__dirname, 'data', 'catalogo_cache.json');

const railwayUrl = process.argv[2];
const token      = process.argv[3];

if (!railwayUrl || !token) {
  console.error('Uso: node push-catalog.js <url-railway> <session-token>');
  console.error('  Ejemplo: node push-catalog.js https://ml-panel-testing-testing.up.railway.app abc123...');
  process.exit(1);
}

if (!fs.existsSync(CACHE_FILE)) {
  console.error('No se encontró:', CACHE_FILE);
  process.exit(1);
}

const data = fs.readFileSync(CACHE_FILE, 'utf8');
const parsed = JSON.parse(data);
const total = parsed.categories.reduce((s, c) => s + c.items.length, 0);
console.log(`[push] Leyendo cache local: ${parsed.categories.length} categorías, ${total} productos`);
console.log(`[push] Guardado original: ${parsed.savedAt || '?'}`);
console.log(`[push] Enviando a: ${railwayUrl}/api/catalog/import-cache`);

const endpoint = new URL('/api/catalog/import-cache', railwayUrl);
const body = Buffer.from(data);

const options = {
  hostname: endpoint.hostname,
  port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
  path: endpoint.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Authorization': 'Bearer ' + token,
  },
};

const lib = endpoint.protocol === 'https:' ? https : http;
const req = lib.request(options, (res) => {
  let chunks = '';
  res.on('data', d => chunks += d);
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const r = JSON.parse(chunks);
      console.log(`[push] ✓ Éxito — ${r.total} productos, ${r.categories} categorías importadas`);
      console.log(`[push] importedAt: ${r.importedAt}`);
    } else {
      console.error(`[push] Error ${res.statusCode}:`, chunks);
    }
  });
});

req.on('error', e => console.error('[push] Error de red:', e.message));
req.write(body);
req.end();
