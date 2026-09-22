// Persistencia del muro.
//
// No hay base de datos a propósito: el nombre de la persona viaja dentro del
// pathname del blob codificado en base64url, así una sola llamada a list()
// devuelve el muro completo (nombre + URL + fecha) sin N+1 ni servicios extra.
//
//   wall/<ts 13 dígitos>-<id 8 hex>-<base64url(nombre)>.jpg
//
// El prefijo es de ancho fijo, así que el parseo es inequívoco aunque el
// alfabeto base64url incluya "-" y "_".
//
// En producción el almacén es Vercel Blob. En local, si se define WALL_LOCAL_DIR
// se usa el disco, para poder desarrollar sin un token real. Ese camino está
// cerrado en Vercel: allí el filesystem es efímero y los datos se perderían.

import path from 'node:path';
import fs from 'node:fs/promises';

export const PREFIX = 'wall/';

/** Dimensiones exactas que produce el canvas del cliente. Ver WALL en credencial.html. */
export const IMAGE_W = 542;
export const IMAGE_H = 726;

/** Tope duro de credenciales publicadas. Evita crecimiento sin control del almacén. */
export const MAX_ENTRIES = 500;

const LOCAL_DIR = !process.env.VERCEL && process.env.WALL_LOCAL_DIR
  ? path.resolve(process.env.WALL_LOCAL_DIR)
  : null;

/** Ruta pública con la que el servidor de desarrollo sirve WALL_LOCAL_DIR. */
export const LOCAL_URL_PREFIX = '/__wall/';

export function isConfigured() {
  return Boolean(LOCAL_DIR || process.env.BLOB_READ_WRITE_TOKEN);
}

export function isLocal() {
  return Boolean(LOCAL_DIR);
}

// --- Codificación del nombre en el pathname -------------------------------

function encodeName(name) {
  return Buffer.from(name, 'utf8').toString('base64url');
}

function decodeName(b64) {
  try {
    const s = Buffer.from(b64, 'base64url').toString('utf8');
    // Un base64 truncado decodifica sin lanzar, pero deja U+FFFD.
    return s.includes('�') ? null : s;
  } catch {
    return null;
  }
}

const PATHNAME_RE = /^wall\/(\d{13})-([0-9a-f]{8})-(.+)\.jpg$/;

export function parsePathname(pathname, url) {
  const m = PATHNAME_RE.exec(pathname);
  if (!m) return null;
  const fullName = decodeName(m[3]);
  if (!fullName) return null;
  return { id: pathname, fullName, url, createdAt: Number(m[1]) };
}

function newPathname(fullName) {
  let id = '';
  for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 16).toString(16);
  return `${PREFIX}${String(Date.now()).padStart(13, '0')}-${id}-${encodeName(fullName)}.jpg`;
}

// --- Backend: Vercel Blob -------------------------------------------------

async function blobApi() {
  return import('@vercel/blob');
}

const blobBackend = {
  async list() {
    const { list } = await blobApi();
    const out = [];
    let cursor;
    do {
      const page = await list({ prefix: PREFIX, limit: 1000, cursor });
      for (const b of page.blobs) {
        const entry = parsePathname(b.pathname, b.url);
        if (entry) out.push(entry);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },

  async add(pathname, buffer) {
    const { put } = await blobApi();
    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType: 'image/jpeg',
      addRandomSuffix: false,
      cacheControlMaxAge: 31536000,
    });
    return parsePathname(pathname, blob.url);
  },

  async remove(id) {
    const { list, del } = await blobApi();
    // del() acepta la URL en todas las versiones del SDK; el pathname no.
    const page = await list({ prefix: id, limit: 1 });
    const blob = page.blobs.find((b) => b.pathname === id);
    if (!blob) return false;
    await del(blob.url);
    return true;
  },
};

// --- Backend: disco local (solo desarrollo) -------------------------------

const localBackend = {
  async list() {
    let names;
    try {
      names = await fs.readdir(LOCAL_DIR);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const entry = parsePathname(PREFIX + name, LOCAL_URL_PREFIX + name);
      if (entry) out.push(entry);
    }
    return out;
  },

  async add(pathname, buffer) {
    const name = pathname.slice(PREFIX.length);
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, name), buffer);
    return parsePathname(pathname, LOCAL_URL_PREFIX + name);
  },

  async remove(id) {
    const name = id.slice(PREFIX.length);
    try {
      await fs.unlink(path.join(LOCAL_DIR, name));
      return true;
    } catch {
      return false;
    }
  },
};

function backend() {
  return LOCAL_DIR ? localBackend : blobBackend;
}

// --- API del módulo -------------------------------------------------------

/** Devuelve el muro completo, más reciente primero. */
export async function listEntries() {
  const entries = await backend().list();
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return entries;
}

/** Sube la credencial ya compuesta y devuelve la entrada creada. */
export async function addEntry(fullName, buffer) {
  return backend().add(newPathname(fullName), buffer);
}

/** Borra una credencial del muro (moderación). */
export async function removeEntry(id) {
  if (!PATHNAME_RE.test(id)) return false;
  return backend().remove(id);
}
