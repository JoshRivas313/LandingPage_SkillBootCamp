// Pruebas del endpoint publico del muro.
//
// Levanta antes el servidor de desarrollo y ejecuta:
//   node scripts/dev-server.mjs
//   node scripts/test-wall.mjs
//
// La imagen "huge" se genera aqui para no versionar un fixture de 900 KB.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const BASE = 'http://localhost:3000';
const ORIGIN = BASE;

const img = {
  ok: fs.readFileSync(path.join(DIR, 'ok.b64'), 'utf8'),
  wrongsize: fs.readFileSync(path.join(DIR, 'wrongsize.b64'), 'utf8'),
  png: fs.readFileSync(path.join(DIR, 'png.b64'), 'utf8'),
  huge: null, // se rellena abajo
};

img.huge = img.ok + 'A'.repeat(900000);

let pass = 0, fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASA  ' + label); }
  else { fail++; console.log('  FALLA ' + label + (detail ? '  <- ' + detail : '')); }
}

// Cada caso usa una IP distinta para que el limite de frecuencia de uno no
// contamine al siguiente (y de paso comprueba la lectura de x-forwarded-for).
let ipSeq = 0;
function nextIp() { return '203.0.113.' + (++ipSeq % 250); }

async function post(body, headers = {}) {
  const res = await fetch(BASE + '/api/wall', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'x-forwarded-for': nextIp(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

console.log('\n--- Validación del nombre ---');
for (const [label, name] of [
  ['vacío', ''],
  ['muy corto', 'Jo'],
  ['muy largo', 'A'.repeat(61)],
  ['con dígitos', 'Jose 123'],
  ['una URL', 'http://spam.example.com'],
  ['con emoji', 'Jose 😀 Perez'],
  ['sólo espacios', '     '],
]) {
  const r = await post({ fullName: name, image: img.ok });
  check('rechaza nombre ' + label, r.status === 400, 'status ' + r.status);
}

// Un salto de linea no se rechaza: se normaliza a un espacio, que es lo que
// queremos (el nombre guardado queda limpio, sin caracteres de control).
{
  const r = await post({ fullName: 'Jose\nPerez', image: img.ok });
  check('normaliza el salto de linea a un espacio',
        r.status === 201 && r.data?.entry?.fullName === 'Jose Perez',
        JSON.stringify(r.data?.entry?.fullName));
}

console.log('\n--- Validación de la imagen ---');
for (const [label, image] of [
  ['sin imagen', undefined],
  ['un PNG disfrazado', img.png],
  ['dimensiones incorrectas', img.wrongsize],
  ['imagen enorme', img.huge],
  ['base64 basura', 'data:image/jpeg;base64,####'],
  ['data URL de otro tipo', 'data:text/html;base64,PGh0bWw+'],
]) {
  const r = await post({ fullName: 'Ana Torres', image });
  check('rechaza ' + label, r.status === 400, 'status ' + r.status);
}

console.log('\n--- Origen cruzado ---');
{
  const r = await post({ fullName: 'Ana Torres', image: img.ok }, { origin: 'https://evil.example.com' });
  check('rechaza Origin de otro dominio', r.status === 403, 'status ' + r.status);
}

console.log('\n--- Publicación válida y duplicados ---');
{
  const r = await post({ fullName: 'Ana  Torres ', image: img.ok });
  check('acepta un nombre válido', r.status === 201, 'status ' + r.status + ' ' + JSON.stringify(r.data));
  check('normaliza espacios', r.data?.entry?.fullName === 'Ana Torres', r.data?.entry?.fullName);

  const dup = await post({ fullName: 'ANA TÓRRES', image: img.ok });
  check('rechaza duplicado ignorando mayúsculas y tildes', dup.status === 409, 'status ' + dup.status);
}

console.log('\n--- Límite de frecuencia ---');
{
  const ip = '198.51.100.7';
  let publicadas = 0, limited = false;
  for (let i = 0; i < 6; i++) {
    const r = await post({ fullName: 'Persona Prueba' + 'x'.repeat(i + 1), image: img.ok },
                         { 'x-forwarded-for': ip });
    if (r.status === 201) publicadas++;
    if (r.status === 429) { limited = true; break; }
  }
  check('corta tras varias publicaciones seguidas', limited);
  check('deja publicar 3 veces antes de cortar', publicadas === 3, 'publicadas=' + publicadas);

  // Los rechazos no deben gastar la cuota de publicacion.
  const ip2 = '198.51.100.8';
  for (let i = 0; i < 4; i++) {
    await post({ fullName: 'Nombre Con 123', image: img.ok }, { 'x-forwarded-for': ip2 });
  }
  const tras = await post({ fullName: 'Valido Correcto', image: img.ok }, { 'x-forwarded-for': ip2 });
  check('los rechazos no gastan cuota de publicacion', tras.status === 201, 'status ' + tras.status);
}

console.log('\n--- Moderación ---');
{
  const res = await fetch(BASE + '/api/wall?id=wall/x', { method: 'DELETE' });
  check('DELETE sin token no autoriza', res.status === 401 || res.status === 503, 'status ' + res.status);
}

console.log('\n--- Métodos ---');
{
  const res = await fetch(BASE + '/api/wall', { method: 'PUT' });
  check('PUT devuelve 405', res.status === 405, 'status ' + res.status);
}

console.log(`\n=== ${pass} pasan, ${fail} fallan ===`);
process.exit(fail ? 1 : 0);
