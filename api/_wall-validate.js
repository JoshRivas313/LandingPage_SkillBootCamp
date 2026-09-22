// Validación y anti-abuso del endpoint público del muro.
//
// El POST de /api/wall es un endpoint abierto que recibe imágenes y nombres de
// cualquiera en internet. Estas comprobaciones no lo vuelven invulnerable, pero
// sí cortan el abuso casual: subir una foto arbitraria con curl deja de ser
// trivial porque hay que replicar el formato exacto que produce el canvas.
//
// La defensa de último recurso es DELETE /api/wall con ADMIN_TOKEN.

import { IMAGE_W, IMAGE_H } from './_wall-store.js';

/** Tamaño máximo del JPEG ya compuesto. El canvas produce ~40-90 KB. */
export const MAX_IMAGE_BYTES = 400 * 1024;

export const NAME_MIN = 3;
export const NAME_MAX = 60;

// Letras (con acentos y ñ), espacios, apóstrofo, guion y punto. Sin dígitos,
// sin URLs, sin emojis, sin caracteres de control.
const NAME_RE = /^[\p{L}][\p{L}·'’.\- ]*[\p{L}.]$/u;

export function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();

  if (name.length < NAME_MIN || name.length > NAME_MAX) return null;
  if (!NAME_RE.test(name)) return null;
  return name;
}

/** Clave de deduplicación: ignora mayúsculas y acentos. */
export function nameKey(name) {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

const DATA_URL_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;

/**
 * Convierte el data URL recibido en un Buffer, verificando que sea realmente un
 * JPEG con las dimensiones exactas que genera el cliente.
 * Devuelve { buffer } o { error }.
 */
export function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string') return { error: 'La imagen no es válida.' };
  if (dataUrl.length > MAX_IMAGE_BYTES * 2) return { error: 'La imagen pesa demasiado.' };

  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return { error: 'La imagen debe ser un JPEG generado por la página.' };

  let buffer;
  try {
    buffer = Buffer.from(m[1], 'base64');
  } catch {
    return { error: 'La imagen no se pudo decodificar.' };
  }

  if (buffer.length > MAX_IMAGE_BYTES) return { error: 'La imagen pesa demasiado.' };
  if (buffer.length < 1024) return { error: 'La imagen está incompleta.' };

  // Firma JPEG (SOI).
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    return { error: 'El archivo no es un JPEG.' };
  }

  const size = jpegSize(buffer);
  if (!size) return { error: 'No se pudieron leer las dimensiones de la imagen.' };
  if (size.width !== IMAGE_W || size.height !== IMAGE_H) {
    return { error: 'La credencial no tiene el formato esperado.' };
  }

  return { buffer };
}

/** Recorre los segmentos JPEG hasta el marcador SOF y devuelve sus dimensiones. */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }

    const marker = buf[i + 1];

    // Relleno / marcadores sin payload.
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }

    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;

    // SOF0..SOF15, saltando DHT (C4), JPG (C8) y DAC (CC), que no son SOF.
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSof) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }

    // SOS: a partir de aquí empiezan los datos comprimidos, no hay más cabeceras.
    if (marker === 0xda) return null;

    i += 2 + length;
  }
  return null;
}

// --- Límite de frecuencia -------------------------------------------------
//
// Dos niveles, porque mezclarlos castiga a quien no hace nada malo:
//
//   - intentos:      generoso. Frena a quien martillea el endpoint, pero deja
//                    margen para equivocarse escribiendo el nombre.
//   - publicaciones: estricto, y sólo se descuenta cuando la subida sale bien.
//
// Es "best effort": vive en memoria y Vercel puede levantar varias instancias en
// paralelo, así que alguien decidido puede superarlo. El tope real es MAX_ENTRIES
// y el borrado con ADMIN_TOKEN.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 20;
const MAX_PUBLISHES = 3;

const attempts = new Map();
const publishes = new Map();

function prune(store, now) {
  for (const [key, stamps] of store) {
    const alive = stamps.filter((t) => now - t < WINDOW_MS);
    if (alive.length) store.set(key, alive);
    else store.delete(key);
  }
}

function retryAfter(stamps, now) {
  return Math.max(1, Math.ceil((WINDOW_MS - (now - stamps[0])) / 1000));
}

/** Consume un intento. Se llama en cada POST, salga bien o mal. */
export function checkAttempt(ip) {
  const now = Date.now();
  prune(attempts, now);
  const stamps = attempts.get(ip) || [];
  if (stamps.length >= MAX_ATTEMPTS) {
    return { ok: false, retryAfter: retryAfter(stamps, now) };
  }
  stamps.push(now);
  attempts.set(ip, stamps);
  return { ok: true };
}

/** Consulta la cuota de publicaciones sin consumirla. */
export function checkPublishQuota(ip) {
  const now = Date.now();
  prune(publishes, now);
  const stamps = publishes.get(ip) || [];
  if (stamps.length >= MAX_PUBLISHES) {
    return { ok: false, retryAfter: retryAfter(stamps, now) };
  }
  return { ok: true };
}

/** Descuenta una publicación. Sólo tras subir la credencial con éxito. */
export function recordPublish(ip) {
  const stamps = publishes.get(ip) || [];
  stamps.push(Date.now());
  publishes.set(ip, stamps);
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
