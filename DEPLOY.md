# SkillBot Camp — despliegue en Vercel

Sitio estático (landing + generador de credencial) con una función serverless
para el muro de la comunidad.

```
index.html          Landing
credencial.html     Generador de credencial + muro
api/wall.js         API del muro (GET / POST / DELETE)
assets/             Imágenes, favicon y portada social
vendor/             React y ReactDOM servidos desde este dominio
scripts/            Servidor de desarrollo y pruebas (no se despliegan)
```

---

## 1. Antes del primer despliegue: cambiar el dominio

Las etiquetas Open Graph necesitan URLs **absolutas** — LinkedIn y WhatsApp no
ejecutan JavaScript, así que leen el HTML tal cual. Ahora apuntan a un dominio
de ejemplo. Sustitúyelo por el real:

```bash
sed -i 's|https://skillbot-camp.vercel.app|https://TU-DOMINIO.vercel.app|g' index.html credencial.html
```

Si no lo haces, la página funciona igual, pero al compartir el enlace la tarjeta
de vista previa saldrá con la imagen equivocada.

## 2. Desplegar

```bash
npx vercel --prod
```

Vercel detecta `package.json`, instala `@vercel/blob` y publica `api/wall.js`
como función. No hace falta elegir framework.

## 3. Crear el almacén del muro

En el panel de Vercel: **Storage → Create Database → Blob**, y conéctalo al
proyecto. Eso inyecta `BLOB_READ_WRITE_TOKEN` automáticamente.

**Hasta que hagas esto, el muro no falla**: la sección muestra "El muro estará
disponible muy pronto" y el resto de la página funciona con normalidad.

## 4. Variable para moderar

En **Settings → Environment Variables** añade:

| Variable | Valor | Para qué |
|---|---|---|
| `ADMIN_TOKEN` | una cadena larga y aleatoria | Permite borrar credenciales del muro |

Para borrar una publicación inapropiada:

```bash
curl -X DELETE "https://TU-DOMINIO.vercel.app/api/wall?id=<id>" \
  -H "x-admin-token: TU_ADMIN_TOKEN"
```

El `id` de cada credencial sale de `GET /api/wall`.

> Ten el token a mano **durante** el evento. Es la única forma de bajar algo del
> muro rápido.

---

## Desarrollo local

```bash
npm install
node scripts/dev-server.mjs     # http://localhost:3000
```

Sin `BLOB_READ_WRITE_TOKEN`, el muro se guarda en `.wall-local/` (carpeta
ignorada por git). Ese camino está desactivado en Vercel a propósito: allí el
disco es efímero y los datos se perderían entre peticiones.

Pruebas del endpoint del muro, con el servidor levantado:

```bash
node scripts/test-wall.mjs
```

---

## Cómo funciona el muro

Al pulsar "Publicar en el muro", el navegador compone la credencial completa en
un canvas (plantilla + foto recortada + nombre), la exporta como JPEG de
542×726 y la envía a `POST /api/wall`. El servidor la valida y la guarda en
Vercel Blob.

No hay base de datos: el nombre viaja codificado en base64url dentro del
pathname del blob, así que un solo `list()` devuelve el muro entero.

```
wall/<timestamp 13 dígitos>-<id 8 hex>-<base64url(nombre)>.jpg
```

### Qué se valida en cada publicación

| Comprobación | Regla |
|---|---|
| Nombre | 3–60 caracteres, solo letras, tildes, ñ, apóstrofos, guiones y puntos |
| Duplicados | Rechaza nombres repetidos ignorando mayúsculas y tildes |
| Formato | Debe ser JPEG real, verificado por firma y por marcador SOF |
| Dimensiones | Exactamente 542×726 |
| Tamaño | Máximo 400 KB |
| Origen | `Origin` debe coincidir con el host |
| Intentos | 20 cada 10 min por IP |
| Publicaciones | 3 cada 10 min por IP, y **solo** se descuentan las que salen bien |
| Capacidad | Máximo 500 credenciales |

**Lo que esto no impide:** alguien decidido puede redimensionar una imagen
cualquiera a 542×726 y publicarla, y el límite por IP vive en memoria, así que
varias instancias de la función lo cuentan por separado. Para eso está
`ADMIN_TOKEN`.

---

## Qué no se despliega

`.vercelignore` excluye `uploads/` (15 MB de duplicados), `.thumbnail` y los dos
HTML autocontenidos (`SkillBot Camp.html`, `SkillBot Camp standalone-src.html`).
Ese bundle de 10 MB solo trae la landing y su enlace al muro daría 404;
producción usa `index.html` + `assets/`.
