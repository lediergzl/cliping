# YTDL Clipper

Marca trozos de un vídeo/directo de YouTube o Twitch desde el navegador y
únelos en un clip, sin usar tu PC como servidor y sin coste.

## Efectos (v2)

Ya implementados — se configuran desde el propio panel del userscript:

- **Aspecto**: original, 16:9, 9:16 (vertical, con fondo difuminado) o 1:1.
- **Zoom por trozo**, estático o Ken Burns (zoom lento animado).
- **Transición entre trozos**: fade, dissolve o wipe, con duración ajustable.
- **Fade in / fade out** globales al inicio y final del clip.
- **Título**: solo en el primer trozo, o solo sus primeros 5s.
- **Marca de agua**: texto superpuesto en todos los trozos.
- **Normalizar volumen** (loudnorm) entre trozos.

Si no activas ningún efecto, el workflow usa la ruta rápida de v1
(concat sin recodificar). En cuanto configuras cualquier efecto, el
workflow recodifica con `scripts/build_clip.py`, tarda más
(aprox. lo mismo que la duración total del clip, a veces más) y consume
más minutos de Actions.

Limitaciones conocidas: el título solo cubre el primer trozo (no todo el
clip final); los fades se calculan sobre la duración de cada trozo antes
de acortar por transiciones, así que si el fade y una transición
contigua duran casi lo mismo pueden solaparse de forma rara — para
evitarlo, deja algo de margen entre ambos valores.

## Estructura

```
.github/workflows/merge.yml   → recorta, une y publica el Release
scripts/build_clip.py         → arma el grafo de ffmpeg (v1 rápido o v2 con efectos)
worker/                       → Cloudflare Worker (API intermedia)
userscript/ytdl-clipper.user.js → panel flotante en YouTube/Twitch
```

## 1. Crear el repositorio en GitHub

Sube toda esta carpeta a un repo nuevo, público o privado. Anota `usuario/repo`.

## 2. Configurar los secrets del repo (para el workflow)

**Settings → Secrets and variables → Actions → New repository secret**:

- `YTDL_COOKIES`: contenido del `cookies.txt` (formato Netscape) exportado
  de tu navegador logueado en YouTube (extensión "Get cookies.txt LOCALLY"
  o similar). Necesario porque las IPs de los runners de GitHub Actions
  están en datacenter y YouTube las bloquea sin cookies de sesión.

No hace falta crear `GITHUB_TOKEN` aquí: el workflow usa el token
automático que GitHub Actions inyecta (por eso declara
`permissions: contents: write`).

## 3. Desplegar el Worker

```bash
cd worker
npm install
wrangler login
```

Edita `wrangler.toml` y pon tu `GITHUB_OWNER` / `GITHUB_REPO` reales.

Crea los dos secrets del Worker (interactivo, nunca en texto plano ni en
un archivo):

```bash
wrangler secret put GITHUB_TOKEN
wrangler secret put CLIENT_TOKEN
```

- `GITHUB_TOKEN`: Personal Access Token fine-grained, con scope solo a
  este repo, permisos **Actions: Read and write** y **Contents: Read**.
  > Si algún token ya lo compartiste en un chat o log, revócalo en
  > https://github.com/settings/tokens y genera uno nuevo — un token
  > expuesto se considera comprometido, úsalo o no.
- `CLIENT_TOKEN`: una cadena aleatoria propia (ej. generada con
  `openssl rand -hex 32`). Es el candado del Worker: sin ella, cualquiera
  que descubra la URL podría disparar workflows y gastar tus minutos de
  Actions y tu cuota de GitHub API.

Despliega:

```bash
npm run deploy
```

Copia la URL (`https://ytdl-clipper-worker.TU-SUBDOMINIO.workers.dev`).

## 4. Instalar el userscript

1. Instala la extensión Tampermonkey y activa, si aplica en tu navegador,
   el permiso **"Permitir scripts de usuario"** en `chrome://extensions`
   → Detalles de Tampermonkey (requerido en Chrome/Edge recientes con
   Manifest V3; si no lo activas, el script no se inyecta y no hay
   ningún error visible).
2. Crea un script nuevo en Tampermonkey con el contenido de
   `userscript/ytdl-clipper.user.js`.
3. Edita en la sección `CONFIG`:
   ```js
   WORKER_URL: 'https://ytdl-clipper-worker.TU-SUBDOMINIO.workers.dev',
   CLIENT_TOKEN: 'la-misma-cadena-que-pusiste-como-secret-CLIENT_TOKEN',
   ```
4. Ve a un vídeo de YouTube o Twitch, marca trozos con el panel y pulsa
   "Unir y descargar".

## Límites de producción (configurables en `worker/src/index.ts`)

- Máx. 20 trozos por clip (`MAX_SEGMENTS`)
- Máx. 30 min por trozo (`MAX_SEGMENT_SECONDS`)
- Máx. 60 min sumando todos los trozos (`MAX_TOTAL_SECONDS`)

Existen para evitar runs de Actions descontrolados; súbelos si los
necesitas más grandes.

## Notas

- v1 no recorta con precisión de fotograma perfecta en todos los casos:
  `--force-keyframes-at-cuts` mejora la exactitud, pero el ajuste fino
  post-marcado al unir queda pendiente (anotado para cuando se aborde).
- Los Releases de GitHub no caducan (a diferencia de los artifacts, que
  expiran a los 90 días), por eso se usan como almacenamiento del clip
  final.
- Para directos en vivo de Twitch, `currentTime` no coincide con el
  tiempo real del stream — pendiente para v3.
