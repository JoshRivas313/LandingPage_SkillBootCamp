// Muro de la comunidad — API pública.
//
//   GET    /api/wall            -> { ok, configured, entries: [...] }
//   POST   /api/wall            -> { ok, entry } | { ok:false, error }
//   DELETE /api/wall?id=<id>    -> moderación, requiere cabecera x-admin-token
//
// Sin BLOB_READ_WRITE_TOKEN el endpoint no revienta: responde configured:false
// y la página muestra un aviso en vez de romperse.

import {
  isConfigured,
  listEntries,
  addEntry,
  removeEntry,
  MAX_ENTRIES,
} from './_wall-store.js';

import {
  normalizeName,
  nameKey,
  decodeImage,
  checkAttempt,
  checkPublishQuota,
  recordPublish,
  clientIp,
} from './_wall-validate.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  } catch (err) {
    console.error('[wall] error no controlado:', err);
    return res.status(500).json({ ok: false, error: 'Error del servidor. Intenta de nuevo.' });
  }
}

async function handleGet(req, res) {
  if (!isConfigured()) {
    return res.status(200).json({ ok: true, configured: false, entries: [] });
  }
  const entries = await listEntries();
  return res.status(200).json({ ok: true, configured: true, entries });
}

async function handlePost(req, res) {
  if (!isConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'El muro todavía no está configurado. Avisa al equipo organizador.',
    });
  }

  // Si el navegador manda Origin (siempre lo hace en POST), exigimos que sea el
  // mismo host. Corta hotlinking y envíos desde otras páginas.
  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* Origin inválido */ }
    if (originHost !== req.headers.host) {
      return res.status(403).json({ ok: false, error: 'Origen no permitido.' });
    }
  }

  const ip = clientIp(req);

  const attempt = checkAttempt(ip);
  if (!attempt.ok) {
    res.setHeader('Retry-After', String(attempt.retryAfter));
    return res.status(429).json({
      ok: false,
      error: 'Demasiados intentos seguidos. Espera unos minutos.',
    });
  }

  // Se consulta antes de componer y subir nada, pero no se descuenta hasta que
  // la publicación sale bien: equivocarse escribiendo el nombre no gasta cuota.
  const quota = checkPublishQuota(ip);
  if (!quota.ok) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).json({
      ok: false,
      error: 'Ya publicaste hace poco. Espera unos minutos antes de intentarlo de nuevo.',
    });
  }

  const body = await readJson(req);
  if (!body) return res.status(400).json({ ok: false, error: 'Petición mal formada.' });

  const fullName = normalizeName(body.fullName);
  if (!fullName) {
    return res.status(400).json({
      ok: false,
      error: 'Revisa tu nombre y apellido: solo letras, entre 3 y 60 caracteres.',
    });
  }

  const image = decodeImage(body.image);
  if (image.error) return res.status(400).json({ ok: false, error: image.error });

  const entries = await listEntries();

  if (entries.length >= MAX_ENTRIES) {
    return res.status(409).json({
      ok: false,
      error: 'El muro alcanzó su capacidad máxima. Escríbenos para ampliarlo.',
    });
  }

  const key = nameKey(fullName);
  if (entries.some((e) => nameKey(e.fullName) === key)) {
    return res.status(409).json({
      ok: false,
      error: 'Ya hay una credencial publicada con ese nombre.',
    });
  }

  const entry = await addEntry(fullName, image.buffer);
  recordPublish(ip);
  return res.status(201).json({ ok: true, entry });
}

async function handleDelete(req, res) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    return res.status(503).json({ ok: false, error: 'Moderación no configurada.' });
  }
  if (req.headers['x-admin-token'] !== token) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  const id = new URL(req.url, `http://${req.headers.host}`).searchParams.get('id');
  if (!id) return res.status(400).json({ ok: false, error: 'Falta el parámetro id.' });

  const removed = await removeEntry(id);
  if (!removed) return res.status(404).json({ ok: false, error: 'No existe esa credencial.' });

  return res.status(200).json({ ok: true });
}

/**
 * Vercel suele parsear el JSON por nosotros, pero no siempre (depende de
 * runtime y cabeceras), así que caemos al stream crudo cuando hace falta.
 */
async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  let raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;

  if (typeof raw !== 'string') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) return null;
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
