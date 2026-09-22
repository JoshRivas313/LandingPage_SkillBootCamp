// Servidor de desarrollo: sirve los archivos estáticos y enruta /api/wall al
// mismo handler que usará Vercel. Solo para trabajar en local — en producción
// esto no se despliega (lo enruta Vercel).
//
//   node scripts/dev-server.mjs [puerto]
//
// Si no hay BLOB_READ_WRITE_TOKEN, define WALL_LOCAL_DIR para guardar el muro
// en disco (ver api/_wall-store.js).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 3000);

if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.WALL_LOCAL_DIR) {
  process.env.WALL_LOCAL_DIR = path.join(ROOT, '.wall-local');
}

const { default: wallHandler } = await import('../api/wall.js');
const { LOCAL_URL_PREFIX } = await import('../api/_wall-store.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Da al handler la forma de respuesta que espera (estilo Express/Vercel). */
function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };
  return res;
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  // cleanUrls: /credencial -> credencial.html (igual que vercel.json)
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';

  try {
    const data = await fsp.readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(data);
  } catch {
    send(res, 404, 'No encontrado: ' + rel);
  }
}

function send(res, code, text) {
  res.statusCode = code;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/wall') {
    try {
      await wallHandler(req, decorate(res));
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'Error');
    }
    return;
  }

  // Sirve el muro guardado en disco por el backend local.
  if (url.pathname.startsWith(LOCAL_URL_PREFIX)) {
    const name = path.basename(url.pathname);
    try {
      const data = await fsp.readFile(path.join(process.env.WALL_LOCAL_DIR, name));
      res.statusCode = 200;
      res.setHeader('content-type', 'image/jpeg');
      res.end(data);
    } catch {
      send(res, 404, 'No encontrado');
    }
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`dev  → http://localhost:${PORT}/`);
  console.log(`muro → ${process.env.WALL_LOCAL_DIR}`);
});
