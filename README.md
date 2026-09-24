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

- **Música de fondo** (v3): una URL (YouTube, SoundCloud, un mp3 directo...)
  o un archivo de la carpeta `audio/` del repo. Se puede **mezclar** con el
  audio original o **reemplazarlo**, con volumen de cada pista, punto de inicio
  de la música, repetición si es más corta que el clip y fade out de 2 s al final.

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

## Ver online, compartir y música propia (v3)

- **Ver sin descargar:** al terminar, el panel muestra el clip en un reproductor
  y un enlace **▶ Ver online** que lo reproduce en el navegador (con saltos por
  la línea de tiempo). Es un enlace del Worker (`/v/<job>`) firmado y con
  caducidad de **7 días**; también sirve para **copiar** y **compartir**
  (botón 📤 en móvil). Cualquiera que tenga el enlace puede verlo hasta que caduque.
  Si YouTube/Twitch bloquean el reproductor incrustado, usa "Ver online".
- **Descargar** sigue disponible (enlace directo al Release de GitHub).
- **Música propia:** sube tus pistas (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`...)
  a la carpeta `audio/` del repo y en el panel escribe solo el nombre
  (ej. `tema.mp3`). Los nombres no pueden llevar rutas (`/`).
- Formato de salida: siempre **H.264 (yuv420p) + AAC**, con `faststart`, para que
  se vea en navegadores, móviles y redes sociales. Si el resultado no cumple, el
  workflow falla en vez de publicar un archivo que no se ve.
- Tras actualizar: `cd worker && npm run deploy` y reinstala el userscript
  (recuerda volver a poner `WORKER_URL` y `CLIENT_TOKEN` en `CONFIG`).

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
están en datacenter y YouTube las bloquea sin cookies de sesión. Para que
no caduquen rápido, expórtalas desde una ventana de incógnito (entra en
YouTube, abre `https://www.youtube.com/robots.txt`, exporta y cierra la
ventana sin volver a usar esa sesión). Si un día vuelve a fallar con
"Sign in to confirm you're not a bot", renueva este secret.
- `SECRETS_PAT` (opcional, recomendado): renueva `YTDL_COOKIES` automáticamente
después de cada ejecución, para que las cookies no caduquen. Crea un token
fine-grained en <https://github.com/settings/personal-access-tokens/new>,
con acceso solo a este repo y el permiso **Secrets: Read and write**
(el `GITHUB_TOKEN` automático no puede modificar secrets). Si no lo defines,
el paso se omite y tendrás que renovar las cookies a mano cuando caduquen.
- `PROXY_URL` (opcional): proxy `http://usuario:clave@host:puerto` para
pasarlo a `yt-dlp` si las cookies solas no bastan.

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
