# YTDL Clipper — extensión Chrome/Edge

Esta carpeta sustituye al userscript de Tampermonkey.

## Instalación local

1. Abre `chrome://extensions` en Chrome o `edge://extensions` en Edge.
2. Activa **Modo desarrollador**.
3. Pulsa **Cargar descomprimida**.
4. Selecciona esta carpeta `extension`.
5. Abre YouTube o Twitch y recarga la página.

La extensión inyecta automáticamente `content.js`. No necesita Tampermonkey.

## Arquitectura

- `content.js`: lógica del capturador adaptada a extensión MV3.
- `manifest.json`: permisos para YouTube, Twitch y el Worker.
- El editor continúa en el Worker mediante `/editor`.
- La exportación continúa usando `/merge` y el sondeo `/status/:jobId`.
