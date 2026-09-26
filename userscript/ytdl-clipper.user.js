// ==UserScript==
// @name         YTDL Clipper
// @namespace    ytdl-clipper
// @version      0.9.1
// @description  Marca trozos de un directo/VOD de YouTube o Twitch y los une en un clip
// @match        https://www.youtube.com/*
// @match        https://www.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

// ================== CONFIG ==================
    const CONFIG = {
        WORKER_URL: 'https://ytdl-clipper-worker.yode86.workers.dev', // ← pon tu URL real del Worker
        CLIENT_TOKEN: '1821519060a3dadc417f5a918f7b99c94b6278249194a900e204e980e90a6e7f',                // ← igual al secret CLIENT_TOKEN del Worker
        POLL_INTERVAL_MS: 5000,
        MOCK_MODE: false,  // v1 real: llama al Worker
    };


    // ================== ESTADO ==================
    const state = {
        segments: [],      // [{ start, end, ...efectos }]
        marking: null,     // null | { start }
        jobId: null,
        pollTimer: null,
        editingIndex: null, // índice del trozo abierto para ajuste fino, o null
        tlView: null,       // { a, b }: ventana de tiempo que muestra la barra de recorte
    };

    // ================== ANCHO DEL PANEL ==================
    const PANEL_WIDTH_KEY = 'ytdl-clipper-panel-width';
    const PANEL_WIDTH_MIN = 300;
    const PANEL_WIDTH_MAX = 900;
    const PANEL_WIDTH_DEFAULT = 340;

    // ================== PERSISTENCIA (GM_*) ==================
    // Usamos GM_setValue/GM_getValue en vez de localStorage: es la API pensada
    // para persistencia de userscripts y, a diferencia de localStorage, no
    // depende del origin de la página ni de si el user script corre en un
    // contexto aislado (algo que puede pasar en Chrome/Edge con Tampermonkey
    // en Manifest V3). Si por lo que sea GM_setValue/GM_getValue no están
    // disponibles (otro gestor de userscripts más antiguo), caemos a
    // localStorage como red de seguridad.
    function gmGet(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
        } catch (e) { /* ignorar */ }
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : raw;
        } catch (e) { return fallback; }
    }

    function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
        } catch (e) { /* ignorar */ }
        try { localStorage.setItem(key, String(value)); } catch (e) { /* ignorar */ }
    }

    function gmDelete(key) {
        try {
            if (typeof GM_deleteValue === 'function') { GM_deleteValue(key); return; }
        } catch (e) { /* ignorar */ }
        try { localStorage.removeItem(key); } catch (e) { /* ignorar */ }
    }

    function getSavedPanelWidth() {
        const raw = parseInt(gmGet(PANEL_WIDTH_KEY, PANEL_WIDTH_DEFAULT), 10);
        if (Number.isNaN(raw)) return PANEL_WIDTH_DEFAULT;
        return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, raw));
    }

    function savePanelWidth(px) {
        gmSet(PANEL_WIDTH_KEY, px);
    }

    // ---- Respaldo de trozos por vídeo ----
    // Guarda los trozos marcados bajo una clave por vídeo (getVideoKey()), para
    // que un cambio de vídeo (real o mal detectado) o un recargo de página no
    // borre el trabajo del usuario sin remedio. Se descartan respaldos de más
    // de 6h para no resucitar trozos de una sesión de marcado ya olvidada.
    const SEGMENTS_KEY_PREFIX = 'ytdl-clipper-segments:';
    const SEGMENTS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

    function saveSegmentsFor(videoKey) {
        if (!videoKey) return;
        if (!state.segments || state.segments.length === 0) {
            gmDelete(SEGMENTS_KEY_PREFIX + videoKey);
            return;
        }
        try {
            gmSet(SEGMENTS_KEY_PREFIX + videoKey, JSON.stringify({
                segments: state.segments,
                savedAt: Date.now(),
            }));
        } catch (e) { /* ignorar */ }
    }

    function loadSegmentsFor(videoKey) {
        const raw = gmGet(SEGMENTS_KEY_PREFIX + videoKey, null);
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.segments) || parsed.segments.length === 0) return null;
            if (Date.now() - (parsed.savedAt || 0) > SEGMENTS_MAX_AGE_MS) {
                gmDelete(SEGMENTS_KEY_PREFIX + videoKey);
                return null;
            }
            return parsed.segments;
        } catch (e) { return null; }
    }

    // ================== UTILIDADES ==================
    function getVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) return null;
        return videos.find(v => v.offsetWidth > 400 && v.offsetHeight > 200) || videos[0];
    }

    function getCurrentUrl() {
        if (location.hostname.includes('youtube.com')) {
            const v = new URLSearchParams(location.search).get('v');
            if (v) return 'https://www.youtube.com/watch?v=' + v;
        }
        return location.href;
    }

    function formatTime(sec) {
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        return m + ':' + String(s).padStart(2, '0');
    }

    function formatTimePrecise(sec) {
        return formatTime(sec) + '.' + String(Math.floor((sec % 1) * 10));
    }

    function log(...args) { console.log('[YTDL Clipper]', ...args); }

    // YouTube exige Trusted Types: innerHTML directo queda bloqueado sin esto.
    let ttPolicy = null;
    if (window.trustedTypes && trustedTypes.createPolicy) {
        try {
            ttPolicy = trustedTypes.createPolicy('ytdl-clipper', { createHTML: (s) => s });
        } catch (e) {
            log('No se pudo crear la política Trusted Types:', e);
        }
    }
    function setHTML(el, html) {
        el.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html;
    }

    // ================== PANEL: REDIMENSIONADO ==================
    function setupPanelResize(panel) {
        const handle = document.getElementById('ytdl-resize-handle');
        if (!handle) return;
        let dragging = false;
        let startX = 0;
        let startWidth = 0;

        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            startX = e.clientX;
            startWidth = panel.getBoundingClientRect().width;
            panel.classList.add('ytdl-resizing');
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            // El panel está anclado a la derecha, así que arrastrar a la izquierda lo ensancha.
            const deltaX = e.clientX - startX;
            const newWidth = Math.min(
                Math.min(PANEL_WIDTH_MAX, window.innerWidth - 40),
                Math.max(PANEL_WIDTH_MIN, startWidth - deltaX)
            );
            panel.style.width = newWidth + 'px';
        });

        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            panel.classList.remove('ytdl-resizing');
            savePanelWidth(Math.round(panel.getBoundingClientRect().width));
        });

        // Doble clic en el tirador: alterna entre ancho normal y ancho amplio
        handle.addEventListener('dblclick', () => {
            const current = panel.getBoundingClientRect().width;
            const target = current > PANEL_WIDTH_DEFAULT + 40 ? PANEL_WIDTH_DEFAULT : 560;
            panel.style.width = Math.min(target, window.innerWidth - 40) + 'px';
            savePanelWidth(Math.round(panel.getBoundingClientRect().width));
        });
    }

    // ================== PANEL: MARCUP ==================
    function injectPanel() {
        if (document.getElementById('ytdl-clipper-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'ytdl-clipper-panel';
        setHTML(panel, `
            <div class="ytdl-resize-handle" id="ytdl-resize-handle" title="Arrastra para ensanchar"></div>

            <header class="ytdl-header">
                <div class="ytdl-brand">
                    <span class="ytdl-brand-name">YTDL Clipper</span>
                    <span class="ytdl-brand-sub">Editor de clips</span>
                </div>
                <button class="ytdl-icon-btn ytdl-toggle" title="Ocultar panel" aria-label="Ocultar panel">−</button>
            </header>

            <div class="ytdl-body">

                <section class="ytdl-section">
                    <div class="ytdl-section-head">
                        <h3 class="ytdl-section-title">Marcar</h3>
                        <div class="ytdl-status" id="ytdl-status"><span class="ytdl-dot"></span><span id="ytdl-status-text">Listo</span></div>
                    </div>
                    <div class="ytdl-mark-area">
                        <button id="ytdl-mark-start" class="ytdl-btn ytdl-btn-primary">Iniciar trozo</button>
                        <button id="ytdl-mark-end" class="ytdl-btn ytdl-btn-secondary" disabled>Cerrar trozo</button>
                    </div>
                </section>

                <section class="ytdl-section">
                    <div class="ytdl-section-head">
                        <h3 class="ytdl-section-title">Trozos</h3>
                        <span class="ytdl-count" id="ytdl-count">0 trozos · 0:00</span>
                    </div>
                    <div class="ytdl-segments" id="ytdl-segments"></div>
                </section>

                <section class="ytdl-section">
                    <details class="ytdl-effects" id="ytdl-campaign" open>
                        <summary class="ytdl-section-head ytdl-summary">
                            <h3 class="ytdl-section-title">Campaña</h3>
                            <span class="ytdl-chevron">▾</span>
                        </summary>
                        <div class="ytdl-hint">Reglas y recompensa de la campaña que estés siguiendo ahora mismo — edítalas cuando cambies de brief.</div>

                        <div class="ytdl-group">
                            <div class="ytdl-group-title">Checklist antes de publicar</div>
                            <div class="ytdl-segments" id="ytdl-checklist"></div>
                            <div class="ytdl-field">
                                <input type="text" id="ytdl-cl-new-text" class="ytdl-input" placeholder="Nueva regla del brief…">
                                <button id="ytdl-cl-add" class="ytdl-btn ytdl-btn-secondary">Añadir</button>
                            </div>
                        </div>

                        <div class="ytdl-group">
                            <div class="ytdl-group-title">Calculadora de recompensa</div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="ytdl-calc-rate">$ por 1.000 visitas</label>
                                <input type="number" id="ytdl-calc-rate" class="ytdl-input ytdl-input-num" min="0" step="0.1" placeholder="0">
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="ytdl-calc-cap">Tope por vídeo ($)</label>
                                <input type="number" id="ytdl-calc-cap" class="ytdl-input ytdl-input-num" min="0" step="1" placeholder="Sin tope">
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="ytdl-calc-min">Mínimo del perfil</label>
                                <input type="number" id="ytdl-calc-min" class="ytdl-input ytdl-input-num" min="0" step="100" placeholder="0">
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="ytdl-calc-video">Visitas de este vídeo</label>
                                <input type="number" id="ytdl-calc-video" class="ytdl-input ytdl-input-num" min="0" step="100" placeholder="0">
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="ytdl-calc-total">Total en tu perfil</label>
                                <input type="number" id="ytdl-calc-total" class="ytdl-input ytdl-input-num" min="0" step="100" placeholder="0">
                            </div>
                            <div class="ytdl-hint" id="ytdl-calc-out">Rellena las reglas de arriba para estimar tu recompensa.</div>
                        </div>
                    </details>
                </section>

                <section class="ytdl-section">
                    <details class="ytdl-effects">
                        <summary class="ytdl-section-head ytdl-summary">
                            <h3 class="ytdl-section-title">Efectos</h3>
                            <span class="ytdl-chevron">▾</span>
                        </summary>

                        <div class="ytdl-group">
                            <div class="ytdl-group-title">Imagen</div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="eff-aspect">Formato</label>
                                <select id="eff-aspect" class="ytdl-input">
                                    <option value="original">Original</option>
                                    <option value="16:9">16:9</option>
                                    <option value="9:16">9:16 (vertical)</option>
                                    <option value="1:1">1:1</option>
                                </select>
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label"><input type="checkbox" id="eff-fadein"> Fade in</label>
                                <span class="ytdl-inline">
                                    <input type="number" id="eff-fadein-s" class="ytdl-input ytdl-input-num" min="0" max="5" step="0.5" value="1"> s
                                </span>
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label"><input type="checkbox" id="eff-fadeout"> Fade out</label>
                                <span class="ytdl-inline">
                                    <input type="number" id="eff-fadeout-s" class="ytdl-input ytdl-input-num" min="0" max="5" step="0.5" value="1"> s
                                </span>
                            </div>
                        </div>

                        <div class="ytdl-group">
                            <div class="ytdl-group-title">Texto</div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="eff-title-text">Título</label>
                                <input type="text" id="eff-title-text" class="ytdl-input" placeholder="Opcional">
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label">Posición</label>
                                <span class="ytdl-inline ytdl-inline-grow">
                                    <select id="eff-title-pos" class="ytdl-input">
                                        <option value="top">Arriba</option>
                                        <option value="center">Centro</option>
                                        <option value="bottom" selected>Abajo</option>
                                    </select>
                                    <select id="eff-title-dur" class="ytdl-input">
                                        <option value="start" selected>Solo 5s</option>
                                        <option value="full">Primer trozo</option>
                                    </select>
                                </span>
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="eff-watermark-text">Marca de agua</label>
                                <input type="text" id="eff-watermark-text" class="ytdl-input" placeholder="Opcional">
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label">Posición</label>
                                <select id="eff-watermark-pos" class="ytdl-input">
                                    <option value="top">Arriba</option>
                                    <option value="center">Centro</option>
                                    <option value="bottom" selected>Abajo</option>
                                </select>
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="eff-badge"><input type="checkbox" id="eff-badge"> Insignia (caja pequeña abajo-izq.)</label>
                                <span class="ytdl-inline">
                                    <input type="text" id="eff-badge-text" class="ytdl-input" placeholder="Texto (opcional)">
                                </span>
                            </div>
                            <div class="ytdl-hint">Genérica: úsala si tu brief actual pide marcar la fuente (canal, cuenta, etc.) en el vídeo.</div>
                        </div>

                        <div class="ytdl-group">
                            <div class="ytdl-group-title">Audio</div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="eff-normalize"><input type="checkbox" id="eff-normalize"> Normalizar volumen</label>
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label" for="eff-audio-src">Música</label>
                                <input type="text" id="eff-audio-src" class="ytdl-input" placeholder="URL o archivo de audio/">
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label">Modo</label>
                                <select id="eff-audio-mode" class="ytdl-input">
                                    <option value="mix" selected>Mezclar con el original</option>
                                    <option value="replace">Reemplazar el original</option>
                                </select>
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label">Volumen música</label>
                                <span class="ytdl-inline ytdl-inline-grow">
                                    <input type="range" id="eff-audio-vol" min="0" max="100" value="50">
                                    <span id="eff-audio-vol-v" class="ytdl-value">50%</span>
                                </span>
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label">Volumen original</label>
                                <span class="ytdl-inline ytdl-inline-grow">
                                    <input type="range" id="eff-audio-orig" min="0" max="100" value="100">
                                    <span id="eff-audio-orig-v" class="ytdl-value">100%</span>
                                </span>
                            </div>
                            <div class="ytdl-field">
                                <label class="ytdl-label">Empezar en</label>
                                <span class="ytdl-inline">
                                    <input type="number" id="eff-audio-start" class="ytdl-input ytdl-input-num" min="0" step="1" value="0"> s
                                    <label class="ytdl-check"><input type="checkbox" id="eff-audio-loop" checked> Repetir</label>
                                </span>
                            </div>
                        </div>
                    </details>
                </section>

                <section class="ytdl-section ytdl-section-export">
                    <div class="ytdl-section-head">
                        <h3 class="ytdl-section-title">Exportar</h3>
                    </div>
                    <div class="ytdl-export-row">
                        <button id="ytdl-preview-btn" class="ytdl-btn ytdl-btn-secondary" disabled>Vista previa</button>
                        <button id="ytdl-merge" class="ytdl-btn ytdl-btn-primary" disabled>Unir y descargar</button>
                    </div>
                    <div class="ytdl-result" id="ytdl-result"></div>
                </section>

            </div>
        `);
        document.body.appendChild(panel);

        const style = document.createElement('style');
        style.textContent = `
            #ytdl-clipper-panel {
                --ytdl-bg: #ffffff;
                --ytdl-surface: #f6f6f8;
                --ytdl-border: #e3e3e8;
                --ytdl-text: #18181b;
                --ytdl-muted: #6b6b76;
                --ytdl-accent: #7c3aed;
                --ytdl-accent-hover: #6d28d9;
                --ytdl-danger: #dc2626;
                --ytdl-success: #16a34a;
                --ytdl-radius: 8px;

                position: fixed; top: 80px; right: 20px;
                width: ${getSavedPanelWidth()}px; z-index: 99999;
                max-width: 95vw;
                background: var(--ytdl-bg); color: var(--ytdl-text);
                border: 1px solid var(--ytdl-border); border-radius: 12px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px; line-height: 1.4;
                box-shadow: 0 12px 32px rgba(0,0,0,0.12);
                user-select: none;
            }
            #ytdl-clipper-panel.ytdl-collapsed .ytdl-body { display: none; }
            #ytdl-clipper-panel.ytdl-resizing { user-select: none; transition: none; }
            #ytdl-clipper-panel * { box-sizing: border-box; }
            #ytdl-clipper-panel iframe { pointer-events: none; }

            .ytdl-resize-handle {
                position: absolute; top: 0; left: -4px; bottom: 0; width: 8px;
                cursor: ew-resize; z-index: 2; border-radius: 12px 0 0 12px;
            }
            .ytdl-resize-handle:hover, #ytdl-clipper-panel.ytdl-resizing .ytdl-resize-handle {
                background: rgba(124, 58, 237, 0.25);
            }

            /* ---- Cabecera ---- */
            .ytdl-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 12px 14px; border-bottom: 1px solid var(--ytdl-border);
                border-radius: 12px 12px 0 0; background: var(--ytdl-bg);
            }
            .ytdl-brand { display: flex; flex-direction: column; }
            .ytdl-brand-name { font-weight: 700; font-size: 14px; }
            .ytdl-brand-sub { font-size: 11px; color: var(--ytdl-muted); }
            .ytdl-icon-btn {
                width: 28px; height: 28px; border: 1px solid var(--ytdl-border);
                background: var(--ytdl-bg); color: var(--ytdl-muted);
                border-radius: 6px; cursor: pointer; font-size: 16px; line-height: 1;
                display: flex; align-items: center; justify-content: center;
            }
            .ytdl-icon-btn:hover { color: var(--ytdl-text); background: var(--ytdl-surface); }

            /* ---- Cuerpo y secciones ---- */
            .ytdl-body { padding: 4px 14px 14px; }
            .ytdl-section { padding: 12px 0; border-bottom: 1px solid var(--ytdl-border); }
            .ytdl-section:last-child { border-bottom: none; }
            .ytdl-section-head {
                display: flex; justify-content: space-between; align-items: center;
                gap: 8px; margin-bottom: 8px;
            }
            .ytdl-section-title {
                margin: 0; font-size: 11px; font-weight: 700;
                text-transform: uppercase; letter-spacing: 0.06em; color: var(--ytdl-muted);
            }

            /* ---- Estado ---- */
            .ytdl-status {
                display: inline-flex; align-items: center; gap: 6px;
                font-size: 11px; color: var(--ytdl-muted);
            }
            .ytdl-dot {
                width: 7px; height: 7px; border-radius: 50%;
                background: var(--ytdl-success);
            }
            .ytdl-status.ytdl-status-recording .ytdl-dot {
                background: var(--ytdl-danger);
                animation: ytdl-pulse 1.2s infinite;
            }
            .ytdl-status.ytdl-status-error { color: var(--ytdl-danger); }
            .ytdl-status.ytdl-status-error .ytdl-dot { background: var(--ytdl-danger); }
            @keyframes ytdl-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

            /* ---- Botones ---- */
            .ytdl-mark-area { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
            .ytdl-btn {
                padding: 8px 10px; border: 1px solid transparent; border-radius: 6px;
                cursor: pointer; font-size: 12px; font-weight: 600;
                transition: background 0.15s, opacity 0.15s;
            }
            .ytdl-btn:disabled { opacity: 0.45; cursor: not-allowed; }
            .ytdl-btn-block { width: 100%; }
            .ytdl-btn-primary { background: var(--ytdl-accent); color: #fff; }
            .ytdl-btn-primary:not(:disabled):hover { background: var(--ytdl-accent-hover); }
            .ytdl-btn-secondary {
                background: var(--ytdl-bg); color: var(--ytdl-text); border-color: var(--ytdl-border);
            }
            .ytdl-btn-secondary:not(:disabled):hover { background: var(--ytdl-surface); }
            #ytdl-mark-end:not(:disabled) { color: var(--ytdl-danger); border-color: var(--ytdl-danger); }

            /* ---- Contador de trozos ---- */
            .ytdl-count { font-size: 11px; color: var(--ytdl-muted); font-variant-numeric: tabular-nums; }

            /* ---- Lista de trozos ---- */
            .ytdl-segments {
                max-height: 340px; overflow-y: auto;
                display: flex; flex-direction: column; gap: 6px;
            }
            .ytdl-empty {
                color: var(--ytdl-muted); text-align: center; padding: 18px 0;
                font-size: 12px; background: var(--ytdl-surface); border-radius: var(--ytdl-radius);
            }
            .ytdl-segment {
                padding: 8px 10px; background: var(--ytdl-bg);
                border: 1px solid var(--ytdl-border); border-radius: var(--ytdl-radius);
            }
            .ytdl-segment.ytdl-segment-active { border-color: var(--ytdl-accent); }
            .ytdl-segment-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
            .ytdl-segment-info { display: flex; flex-direction: column; min-width: 0; }
            .ytdl-segment-num { font-size: 11px; color: var(--ytdl-muted); }
            .ytdl-segment-time {
                font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
                font-variant-numeric: tabular-nums; white-space: nowrap;
            }
            .ytdl-segment-dur { color: var(--ytdl-muted); }
            .ytdl-segment-actions { display: flex; gap: 2px; flex-shrink: 0; }
            .ytdl-segment-btn {
                width: 26px; height: 26px; border: none; border-radius: 6px;
                background: transparent; color: var(--ytdl-muted);
                cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center;
            }
            .ytdl-segment-btn:hover { background: var(--ytdl-surface); color: var(--ytdl-text); }
            .ytdl-segment-btn.ytdl-active { background: rgba(124, 58, 237, 0.12); color: var(--ytdl-accent); }
            .ytdl-segment-btn.ytdl-btn-del:hover { color: var(--ytdl-danger); }

            /* ---- Editor de trozo ---- */
            .ytdl-segment-edit {
                margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--ytdl-border);
                display: flex; flex-direction: column; gap: 8px;
            }
            .ytdl-edit-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
            .ytdl-edit-label { width: 64px; font-size: 11px; color: var(--ytdl-muted); }
            .ytdl-edit-time {
                font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px;
                width: 56px; font-variant-numeric: tabular-nums;
            }
            .ytdl-nudge-btn {
                background: var(--ytdl-surface); border: 1px solid var(--ytdl-border);
                color: var(--ytdl-text); border-radius: 5px; cursor: pointer;
                font-size: 10px; padding: 3px 6px; font-family: ui-monospace, Menlo, monospace;
            }
            .ytdl-nudge-btn:hover { border-color: var(--ytdl-accent); color: var(--ytdl-accent); }
            .ytdl-edit-seek {
                background: var(--ytdl-accent); border: none; color: #fff;
                border-radius: 5px; cursor: pointer; font-size: 10px; padding: 3px 8px;
                margin-left: auto;
            }
            .ytdl-edit-seek:hover { background: var(--ytdl-accent-hover); }
            .ytdl-edit-fx { border-top: 1px dashed var(--ytdl-border); padding-top: 8px; }

            /* ---- Timeline arrastrable ---- */
            .ytdl-tl-track {
                position: relative; height: 34px; background: var(--ytdl-surface);
                border: 1px solid var(--ytdl-border); border-radius: 6px;
                cursor: pointer; touch-action: none;
            }
            .ytdl-tl-range {
                position: absolute; top: 0; bottom: 0; background: var(--ytdl-accent);
                opacity: 0.85; pointer-events: none;
            }
            .ytdl-tl-handle {
                position: absolute; top: -4px; bottom: -4px; width: 12px;
                margin-left: -6px; background: #fff;
                border: 2px solid var(--ytdl-accent-hover); border-radius: 4px;
                cursor: ew-resize; box-sizing: border-box; z-index: 2;
            }
            .ytdl-tl-handle::after {
                content: ''; position: absolute; top: 50%; left: 50%;
                width: 2px; height: 10px; margin: -5px 0 0 -1px;
                background: var(--ytdl-accent-hover); border-radius: 1px;
            }
            .ytdl-tl-playhead {
                position: absolute; top: 0; bottom: 0; width: 2px;
                margin-left: -1px; background: var(--ytdl-danger); pointer-events: none; z-index: 1;
            }
            .ytdl-tl-labels {
                display: flex; justify-content: space-between; align-items: center;
                font-family: ui-monospace, Menlo, monospace; font-size: 10px;
                color: var(--ytdl-muted); margin-top: 4px;
            }
            .ytdl-tl-hint { font-size: 10px; color: var(--ytdl-muted); margin-top: 4px; }

            /* ---- Efectos ---- */
            .ytdl-effects summary { list-style: none; cursor: pointer; }
            .ytdl-effects summary::-webkit-details-marker { display: none; }
            .ytdl-summary { margin-bottom: 0; }
            .ytdl-chevron { color: var(--ytdl-muted); transition: transform 0.15s; }
            .ytdl-effects[open] .ytdl-chevron { transform: rotate(180deg); }
            .ytdl-effects[open] .ytdl-summary { margin-bottom: 10px; }
            .ytdl-group {
                background: var(--ytdl-surface); border-radius: var(--ytdl-radius);
                padding: 8px 10px; margin-bottom: 8px;
            }
            .ytdl-group-title {
                font-size: 11px; font-weight: 600; color: var(--ytdl-text); margin-bottom: 6px;
            }
            .ytdl-field {
                display: flex; align-items: center; justify-content: space-between;
                gap: 8px; margin-bottom: 6px; min-height: 26px;
            }
            .ytdl-field:last-child { margin-bottom: 0; }
            .ytdl-label {
                display: flex; align-items: center; gap: 6px;
                font-size: 12px; color: var(--ytdl-muted); white-space: nowrap;
            }
            .ytdl-check { display: inline-flex; align-items: center; gap: 4px; color: var(--ytdl-muted); }
            .ytdl-inline { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--ytdl-muted); }
            .ytdl-inline-grow { flex: 1; justify-content: flex-end; min-width: 0; }
            .ytdl-input {
                background: var(--ytdl-bg); color: var(--ytdl-text);
                border: 1px solid var(--ytdl-border); border-radius: 6px;
                padding: 4px 8px; font-size: 12px; min-width: 0;
                font-family: inherit;
            }
            .ytdl-input:focus { outline: none; border-color: var(--ytdl-accent); }
            .ytdl-field > .ytdl-input, .ytdl-field > input[type="text"], .ytdl-field > select { flex: 1; }
            .ytdl-input-num { width: 52px; }
            .ytdl-inline-grow .ytdl-input { flex: 1; }
            .ytdl-field input[type="range"] { flex: 1; min-width: 0; accent-color: var(--ytdl-accent); }
            .ytdl-value {
                width: 40px; text-align: right; font-family: ui-monospace, Menlo, monospace;
                font-size: 11px; color: var(--ytdl-text);
            }

            .ytdl-export-row { display: grid; grid-template-columns: 1fr 1.4fr; gap: 8px; }

            /* ---- Visor de vista previa (fuera del panel) ---- */
            #ytdl-pv-overlay {
                position: fixed; inset: 0; z-index: 100000;
                background: rgba(0, 0, 0, 0.6);
                display: flex; align-items: center; justify-content: center;
                padding: 20px; user-select: none;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }
            .ytdl-pv-box {
                background: #ffffff; color: #18181b; border-radius: 12px;
                width: min(760px, 100%); padding: 14px;
                box-shadow: 0 20px 48px rgba(0,0,0,0.35);
            }
            .ytdl-pv-head {
                display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;
            }
            .ytdl-pv-title { font-weight: 700; font-size: 14px; }
            .ytdl-pv-stage {
                background: #000; border-radius: 8px; display: flex;
                justify-content: center; align-items: center; padding: 6px;
            }
            .ytdl-pv-stage canvas { display: block; max-width: 100%; max-height: 60vh; }
            .ytdl-pv-controls { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
            .ytdl-pv-controls .ytdl-btn { flex-shrink: 0; min-width: 96px; }
            .ytdl-pv-progress {
                flex: 1; height: 6px; background: #e3e3e8; border-radius: 3px;
                cursor: pointer; position: relative;
            }
            .ytdl-pv-bar { height: 100%; width: 0; background: #7c3aed; border-radius: 3px; }
            .ytdl-pv-time {
                font-family: ui-monospace, Menlo, monospace; font-size: 11px;
                color: #6b6b76; white-space: nowrap; font-variant-numeric: tabular-nums;
            }
            .ytdl-pv-note { margin-top: 8px; font-size: 11px; color: #6b6b76; }

            /* ---- Resultado ---- */
            .ytdl-result { margin-top: 10px; font-size: 12px; }
            .ytdl-result:empty { display: none; }
            .ytdl-result a { color: var(--ytdl-accent); text-decoration: none; font-weight: 600; }
            .ytdl-result a:hover { text-decoration: underline; }
            .ytdl-video {
                width: 100%; max-height: 220px; background: #000;
                border-radius: var(--ytdl-radius); margin-bottom: 8px;
            }
            .ytdl-result-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
            .ytdl-mini-btn {
                background: var(--ytdl-surface); border: 1px solid var(--ytdl-border);
                color: var(--ytdl-text); border-radius: 6px; cursor: pointer;
                font-size: 11px; padding: 4px 8px;
            }
            .ytdl-mini-btn:hover { border-color: var(--ytdl-accent); }
            .ytdl-hint { margin-top: 6px; color: var(--ytdl-muted); font-size: 11px; }
        `;
        document.head.appendChild(style);

        document.querySelector('#ytdl-clipper-panel .ytdl-toggle').onclick = () => {
            panel.classList.toggle('ytdl-collapsed');
        };
        setupPanelResize(panel);
        document.getElementById('ytdl-mark-start').onclick = onMarkStart;
        document.getElementById('ytdl-mark-end').onclick = onMarkEnd;
        document.getElementById('ytdl-merge').onclick = onMerge;
        document.getElementById('ytdl-preview-btn').onclick = openPreview;
        [['eff-audio-vol', 'eff-audio-vol-v'], ['eff-audio-orig', 'eff-audio-orig-v']].forEach(([inp, out]) => {
            const el = document.getElementById(inp);
            el.addEventListener('input', () => { document.getElementById(out).textContent = el.value + '%'; });
        });

        setupCampaignPanel();
        renderSegments();
    }

    // ================== SECCIÓN CAMPAÑA ==================
    // Todo lo de aquí es una plantilla reutilizable, no reglas de una campaña
    // concreta: el checklist se edita a mano (añadir/quitar puntos) y los
    // parámetros de la calculadora (tarifa, tope, mínimo) se guardan tal cual
    // los rellene el usuario, para adaptarse al brief que toque en cada
    // momento. Nada de esto va en el payload al Worker: es solo ayuda local.
    const CAMPAIGN_KEYS = {
        badgeText: 'ytdl-clipper-badge-text',
        checklist: 'ytdl-clipper-checklist-items', // JSON: [{ id, text, done }]
        rate: 'ytdl-clipper-calc-rate',
        cap: 'ytdl-clipper-calc-cap',
        min: 'ytdl-clipper-calc-min',
    };
    const DEFAULT_CHECKLIST = [
        { id: 'c1', text: 'Cuenta/perfil configurados según el brief', done: false },
        { id: 'c2', text: 'Título o gancho añadido al clip', done: false },
        { id: 'c3', text: 'Formato de plataforma respetado (aspecto, duración…)', done: false },
        { id: 'c4', text: 'Clip nuevo, no reutilizado tal cual', done: false },
    ];

    function loadChecklist() {
        try {
            const raw = gmGet(CAMPAIGN_KEYS.checklist, null);
            const parsed = raw ? JSON.parse(raw) : null;
            if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch (e) { /* ignorar */ }
        return DEFAULT_CHECKLIST.slice();
    }

    function saveChecklist(items) {
        gmSet(CAMPAIGN_KEYS.checklist, JSON.stringify(items));
    }

    function renderChecklist(items) {
        const box = document.getElementById('ytdl-checklist');
        if (items.length === 0) {
            setHTML(box, '<div class="ytdl-hint">Sin puntos todavía — añade los del brief que estés siguiendo.</div>');
            return;
        }
        setHTML(box, items.map((it) => `
            <div class="ytdl-field ytdl-cl-row" data-id="${escAttr(it.id)}">
                <label class="ytdl-check" style="flex:1">
                    <input type="checkbox" class="ytdl-cl-check" ${it.done ? 'checked' : ''}>
                    <span>${escAttr(it.text)}</span>
                </label>
                <button class="ytdl-icon-btn ytdl-cl-remove" title="Quitar">✕</button>
            </div>
        `).join(''));
        box.querySelectorAll('.ytdl-cl-row').forEach((row) => {
            const id = row.dataset.id;
            row.querySelector('.ytdl-cl-check').addEventListener('change', (e) => {
                const items2 = loadChecklist();
                const item = items2.find(i => i.id === id);
                if (item) { item.done = e.target.checked; saveChecklist(items2); }
            });
            row.querySelector('.ytdl-cl-remove').addEventListener('click', () => {
                saveChecklist(loadChecklist().filter(i => i.id !== id));
                renderChecklist(loadChecklist());
            });
        });
    }

    function setupCampaignPanel() {
        // Insignia: texto libre, sin valor por defecto atado a ningún canal/marca.
        const badgeCheck = document.getElementById('eff-badge');
        const badgeText = document.getElementById('eff-badge-text');
        const savedBadge = gmGet(CAMPAIGN_KEYS.badgeText, '');
        if (savedBadge) badgeText.value = savedBadge;
        badgeText.addEventListener('change', () => gmSet(CAMPAIGN_KEYS.badgeText, badgeText.value.trim()));
        badgeText.addEventListener('input', () => { if (badgeText.value.trim()) badgeCheck.checked = true; });

        // Checklist editable.
        renderChecklist(loadChecklist());
        document.getElementById('ytdl-cl-add').addEventListener('click', () => {
            const input = document.getElementById('ytdl-cl-new-text');
            const text = input.value.trim();
            if (!text) return;
            const items = loadChecklist();
            items.push({ id: 'c' + Date.now(), text, done: false });
            saveChecklist(items);
            renderChecklist(items);
            input.value = '';
        });

        // Calculadora: tarifa/tope/mínimo son los del brief actual, editables y persistidos.
        const calcRate = document.getElementById('ytdl-calc-rate');
        const calcCap = document.getElementById('ytdl-calc-cap');
        const calcMin = document.getElementById('ytdl-calc-min');
        const calcVideo = document.getElementById('ytdl-calc-video');
        const calcTotal = document.getElementById('ytdl-calc-total');
        const calcOut = document.getElementById('ytdl-calc-out');

        calcRate.value = gmGet(CAMPAIGN_KEYS.rate, '');
        calcCap.value = gmGet(CAMPAIGN_KEYS.cap, '');
        calcMin.value = gmGet(CAMPAIGN_KEYS.min, '');

        const updateCalc = () => {
            gmSet(CAMPAIGN_KEYS.rate, calcRate.value);
            gmSet(CAMPAIGN_KEYS.cap, calcCap.value);
            gmSet(CAMPAIGN_KEYS.min, calcMin.value);

            const rate = parseFloat(calcRate.value);
            if (!calcRate.value || Number.isNaN(rate)) {
                calcOut.textContent = 'Rellena "$ por 1.000 visitas" para estimar tu recompensa.';
                return;
            }
            const views = Math.max(0, parseInt(calcVideo.value, 10) || 0);
            const total = Math.max(0, parseInt(calcTotal.value, 10) || 0);
            const cap = calcCap.value !== '' ? parseFloat(calcCap.value) : Infinity;
            const min = calcMin.value !== '' ? parseInt(calcMin.value, 10) : 0;

            let est = (views / 1000) * rate;
            const capped = est > cap;
            if (capped) est = cap;

            const parts = [`Este vídeo: ~${est.toFixed(2)}$${capped ? ' (tope alcanzado)' : ''}`];
            if (min > 0) {
                parts.push(total >= min
                    ? 'Perfil: mínimo cumplido ✓'
                    : `Perfil: te faltan ${(min - total).toLocaleString('es')} visitas para el mínimo`);
            }
            calcOut.textContent = parts.join(' · ');
        };
        [calcRate, calcCap, calcMin, calcVideo, calcTotal].forEach(el => el.addEventListener('input', updateCalc));
        updateCalc();
    }

    function setStatus(text, kind) {
        const box = document.getElementById('ytdl-status');
        const txt = document.getElementById('ytdl-status-text');
        if (txt) txt.textContent = text;
        if (box) {
            box.classList.toggle('ytdl-status-recording', kind === 'recording');
            box.classList.toggle('ytdl-status-error', kind === 'error');
        }
    }

    // ================== RENDER ==================
    // Ventana de tiempo que muestra la barra: el trozo con un margen de 30s a cada lado
    function computeTimelineView(seg) {
        const video = getVideo();
        const dur = video && video.duration && isFinite(video.duration) ? video.duration : seg.end + 30;
        const a = Math.max(0, seg.start - 30);
        const b = Math.min(dur, seg.end + 30);
        return { a, b: Math.max(b, a + 1) };
    }

    function updateSummary() {
        const el = document.getElementById('ytdl-count');
        if (!el) return;
        const total = state.segments.reduce((acc, s) => acc + (s.end - s.start), 0);
        const n = state.segments.length;
        el.textContent = n + (n === 1 ? ' trozo' : ' trozos') + ' · ' + formatTime(total);
    }

    function renderSegments() {
        const container = document.getElementById('ytdl-segments');
        if (!container) return;

        updateSummary();

        if (state.segments.length === 0) {
            setHTML(container, '<div class="ytdl-empty">Marca un inicio y un cierre para añadir trozos</div>');
        } else {
            setHTML(container, state.segments.map((seg, i) => {
                const editing = state.editingIndex === i;
                if (editing) state.tlView = computeTimelineView(seg);
                return `
                <div class="ytdl-segment ${editing ? 'ytdl-segment-active' : ''}" data-index="${i}">
                    <div class="ytdl-segment-row">
                        <div class="ytdl-segment-info">
                            <span class="ytdl-segment-num">Trozo ${i + 1}</span>
                            <span class="ytdl-segment-time">
                                ${formatTime(seg.start)} → ${formatTime(seg.end)}
                                <span class="ytdl-segment-dur">· ${formatTime(seg.end - seg.start)}</span>
                            </span>
                        </div>
                        <div class="ytdl-segment-actions">
                            <button class="ytdl-segment-btn ${editing ? 'ytdl-active' : ''}" data-action="edit" title="Ajustar recorte">✎</button>
                            <button class="ytdl-segment-btn" data-action="up" title="Mover arriba">↑</button>
                            <button class="ytdl-segment-btn" data-action="down" title="Mover abajo">↓</button>
                            <button class="ytdl-segment-btn ytdl-btn-del" data-action="delete" title="Eliminar">✕</button>
                        </div>
                    </div>
                    ${editing ? `
                    <div class="ytdl-segment-edit">
                        <div id="ytdl-tl">
                            <div class="ytdl-tl-track">
                                <div class="ytdl-tl-range"></div>
                                <div class="ytdl-tl-playhead"></div>
                                <div class="ytdl-tl-handle" data-edge="start"></div>
                                <div class="ytdl-tl-handle" data-edge="end"></div>
                            </div>
                            <div class="ytdl-tl-labels">
                                <span>${formatTime(state.tlView.a)}</span>
                                <span class="ytdl-tl-cur">${formatTimePrecise(seg.start)} → ${formatTimePrecise(seg.end)}</span>
                                <span>${formatTime(state.tlView.b)}</span>
                            </div>
                            <div class="ytdl-tl-hint">Arrastra los bordes para recortar · clic en la barra para ver ese punto</div>
                        </div>

                        <div class="ytdl-edit-row">
                            <span class="ytdl-edit-label">Inicio</span>
                            <span class="ytdl-edit-time">${formatTimePrecise(seg.start)}</span>
                            <button class="ytdl-nudge-btn" data-edge="start" data-delta="-1">-1s</button>
                            <button class="ytdl-nudge-btn" data-edge="start" data-delta="-0.1">-.1</button>
                            <button class="ytdl-nudge-btn" data-edge="start" data-delta="0.1">+.1</button>
                            <button class="ytdl-nudge-btn" data-edge="start" data-delta="1">+1s</button>
                            <button class="ytdl-edit-seek" data-edge="start" data-action="seek">Ver</button>
                        </div>
                        <div class="ytdl-edit-row">
                            <span class="ytdl-edit-label">Fin</span>
                            <span class="ytdl-edit-time">${formatTimePrecise(seg.end)}</span>
                            <button class="ytdl-nudge-btn" data-edge="end" data-delta="-1">-1s</button>
                            <button class="ytdl-nudge-btn" data-edge="end" data-delta="-0.1">-.1</button>
                            <button class="ytdl-nudge-btn" data-edge="end" data-delta="0.1">+.1</button>
                            <button class="ytdl-nudge-btn" data-edge="end" data-delta="1">+1s</button>
                            <button class="ytdl-edit-seek" data-edge="end" data-action="seek">Ver</button>
                        </div>
                        <div class="ytdl-edit-row">
                            <button class="ytdl-nudge-btn" data-edge="start" data-action="snap">Inicio en playhead</button>
                            <button class="ytdl-nudge-btn" data-edge="end" data-action="snap">Fin en playhead</button>
                        </div>

                        <div class="ytdl-edit-fx">
                            <div class="ytdl-edit-row">
                                <label class="ytdl-check"><input type="checkbox" class="ytdl-eff-input" data-field="zoomEnabled" ${seg.zoomEnabled ? 'checked' : ''}> Zoom</label>
                                <input type="number" class="ytdl-input ytdl-input-num ytdl-eff-input" data-field="zoomFactor" value="${seg.zoomFactor}" min="1.05" max="3" step="0.05">
                                <label class="ytdl-check"><input type="checkbox" class="ytdl-eff-input" data-field="kenburns" ${seg.kenburns ? 'checked' : ''}> Ken Burns</label>
                            </div>
                            <div class="ytdl-edit-row" style="margin-top:6px">
                                <span class="ytdl-edit-label" style="width:auto">Transición</span>
                                <select class="ytdl-input ytdl-eff-input" data-field="transitionType">
                                    <option value="none" ${seg.transitionType === 'none' ? 'selected' : ''}>Ninguna</option>
                                    <option value="fade" ${seg.transitionType === 'fade' ? 'selected' : ''}>Fade</option>
                                    <option value="dissolve" ${seg.transitionType === 'dissolve' ? 'selected' : ''}>Dissolve</option>
                                    <option value="wipe" ${seg.transitionType === 'wipe' ? 'selected' : ''}>Wipe</option>
                                </select>
                                <input type="number" class="ytdl-input ytdl-input-num ytdl-eff-input" data-field="transitionDuration" value="${seg.transitionDuration}" min="0.2" max="3" step="0.1">
                                <span class="ytdl-segment-dur">s</span>
                            </div>
                        </div>
                    </div>` : ''}
                </div>`;
            }).join(''));

            container.querySelectorAll('.ytdl-segment-btn[data-action]').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.currentTarget.closest('.ytdl-segment').dataset.index, 10);
                    const action = e.currentTarget.dataset.action;
                    if (action === 'delete') {
                        state.segments.splice(idx, 1);
                        if (state.editingIndex === idx) state.editingIndex = null;
                    } else if (action === 'up' && idx > 0) {
                        [state.segments[idx - 1], state.segments[idx]] = [state.segments[idx], state.segments[idx - 1]];
                    } else if (action === 'down' && idx < state.segments.length - 1) {
                        [state.segments[idx], state.segments[idx + 1]] = [state.segments[idx + 1], state.segments[idx]];
                    } else if (action === 'edit') {
                        state.editingIndex = state.editingIndex === idx ? null : idx;
                    }
                    renderSegments();
                };
            });

            container.querySelectorAll('.ytdl-nudge-btn[data-delta]').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.currentTarget.closest('.ytdl-segment').dataset.index, 10);
                    nudgeSegment(idx, e.currentTarget.dataset.edge, parseFloat(e.currentTarget.dataset.delta));
                };
            });

            container.querySelectorAll('[data-action="seek"]').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.currentTarget.closest('.ytdl-segment').dataset.index, 10);
                    seekToEdge(idx, e.currentTarget.dataset.edge);
                };
            });

            container.querySelectorAll('[data-action="snap"]').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.currentTarget.closest('.ytdl-segment').dataset.index, 10);
                    snapEdgeToPlayhead(idx, e.currentTarget.dataset.edge);
                };
            });

            container.querySelectorAll('.ytdl-eff-input[data-field]').forEach(input => {
                input.onchange = (e) => {
                    const idx = parseInt(e.currentTarget.closest('.ytdl-segment').dataset.index, 10);
                    const seg = state.segments[idx];
                    if (!seg) return;
                    const field = e.currentTarget.dataset.field;
                    if (e.currentTarget.type === 'checkbox') seg[field] = e.currentTarget.checked;
                    else if (e.currentTarget.type === 'number') {
                        const parsed = parseFloat(e.currentTarget.value);
                        // Si el campo queda vacío o inválido no debe colapsar a 0
                        // (con zoomFactor=0, ctx.scale(0,0) deja el vídeo invisible
                        // en la vista previa). Usamos el mínimo del propio input.
                        const min = parseFloat(e.currentTarget.min);
                        seg[field] = Number.isFinite(parsed) ? parsed : (Number.isFinite(min) ? min : 0);
                        e.currentTarget.value = seg[field];
                    }
                    else seg[field] = e.currentTarget.value;
                };
            });

            bindTimeline();
        }
        updateTimelinePlayhead();
        updateMergeButton();
    }

    // ================== TIMELINE ARRASTRABLE ==================
    function bindTimeline() {
        const wrap = document.getElementById('ytdl-tl');
        if (!wrap || state.editingIndex === null) return;

        const seg = state.segments[state.editingIndex];
        const view = state.tlView;
        const track = wrap.querySelector('.ytdl-tl-track');
        const range = wrap.querySelector('.ytdl-tl-range');
        const handles = {
            start: wrap.querySelector('.ytdl-tl-handle[data-edge="start"]'),
            end: wrap.querySelector('.ytdl-tl-handle[data-edge="end"]'),
        };
        const lblCur = wrap.querySelector('.ytdl-tl-cur');

        const span = () => view.b - view.a;
        const pct = (t) => ((t - view.a) / span()) * 100;
        const secondsFromEvent = (ev) => {
            const rect = track.getBoundingClientRect();
            const x = Math.min(Math.max(ev.clientX - rect.left, 0), rect.width);
            return view.a + (x / rect.width) * span();
        };

        function paint() {
            range.style.left = pct(seg.start) + '%';
            range.style.width = (pct(seg.end) - pct(seg.start)) + '%';
            handles.start.style.left = pct(seg.start) + '%';
            handles.end.style.left = pct(seg.end) + '%';
            lblCur.textContent = formatTimePrecise(seg.start) + ' → ' + formatTimePrecise(seg.end);
        }

        function seekVideo(t) {
            const video = getVideo();
            if (video) video.currentTime = t;
        }

        function startDrag(ev, edge) {
            ev.preventDefault();
            ev.stopPropagation();
            const MIN_LEN = 0.1;

            function onMove(e) {
                const t = secondsFromEvent(e);
                if (edge === 'start') {
                    seg.start = Math.min(Math.max(view.a, t), seg.end - MIN_LEN);
                } else {
                    seg.end = Math.max(Math.min(view.b, t), seg.start + MIN_LEN);
                }
                paint();
                seekVideo(seg[edge]);
            }

            function onUp() {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                renderSegments();
            }

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        }

        handles.start.addEventListener('pointerdown', (ev) => startDrag(ev, 'start'));
        handles.end.addEventListener('pointerdown', (ev) => startDrag(ev, 'end'));

        // Clic en la barra (fuera de los manejadores): saltar el vídeo a ese punto
        track.addEventListener('pointerdown', (ev) => {
            if (ev.target !== track && !ev.target.classList.contains('ytdl-tl-range')) return;
            seekVideo(secondsFromEvent(ev));
        });

        paint();
    }

    function updateTimelinePlayhead() {
        const wrap = document.getElementById('ytdl-tl');
        if (!wrap || !state.tlView) return;
        const video = getVideo();
        if (!video) return;
        const { a, b } = state.tlView;
        const t = video.currentTime;
        const ph = wrap.querySelector('.ytdl-tl-playhead');
        if (!ph) return;
        const visible = t >= a && t <= b;
        ph.style.display = visible ? '' : 'none';
        ph.style.left = ((t - a) / (b - a)) * 100 + '%';
    }

    // ================== AJUSTE FINO ==================
    function nudgeSegment(idx, edge, delta) {
        const seg = state.segments[idx];
        if (!seg) return;
        const video = getVideo();
        const maxEnd = video && video.duration ? video.duration : Infinity;
        if (edge === 'start') {
            seg.start = Math.min(Math.max(0, seg.start + delta), seg.end - 0.1);
        } else {
            seg.end = Math.max(Math.min(maxEnd, seg.end + delta), seg.start + 0.1);
        }
        renderSegments();
    }

    function seekToEdge(idx, edge) {
        const seg = state.segments[idx];
        const video = getVideo();
        if (!seg || !video) return;
        video.currentTime = seg[edge];
    }

    function snapEdgeToPlayhead(idx, edge) {
        const seg = state.segments[idx];
        const video = getVideo();
        if (!seg || !video) return;
        const t = video.currentTime;
        if (edge === 'start' && t < seg.end - 0.1) seg.start = t;
        if (edge === 'end' && t > seg.start + 0.1) seg.end = t;
        renderSegments();
    }

    function updateMergeButton() {
        const btn = document.getElementById('ytdl-merge');
        if (btn) btn.disabled = state.segments.length < 1 || state.jobId !== null;
        const pv = document.getElementById('ytdl-preview-btn');
        if (pv) pv.disabled = state.segments.length < 1;
    }

    // ================== MARCADO ==================
    function onMarkStart() {
        const video = getVideo();
        if (!video) { setStatus('No encuentro el reproductor', 'error'); return; }
        state.marking = { start: video.currentTime };
        document.getElementById('ytdl-mark-start').disabled = true;
        document.getElementById('ytdl-mark-end').disabled = false;
        setStatus('Grabando desde ' + formatTime(video.currentTime), 'recording');
    }

    function onMarkEnd() {
        if (!state.marking) return;
        const video = getVideo();
        if (!video) return;
        const end = video.currentTime;
        if (end <= state.marking.start) {
            setStatus('El fin debe ser posterior al inicio', 'error');
            return;
        }
        state.segments.push({
            start: state.marking.start, end,
            zoomEnabled: false, zoomFactor: 1.15, kenburns: false,
            transitionType: 'none', transitionDuration: 0.5,
        });
        state.marking = null;
        document.getElementById('ytdl-mark-start').disabled = false;
        document.getElementById('ytdl-mark-end').disabled = true;
        setStatus('Listo');
        renderSegments();
    }

    function readEffectsOutput() {
        const val = (id) => document.getElementById(id);
        const titleText = val('eff-title-text').value.trim();
        const watermarkText = val('eff-watermark-text').value.trim();
        const badgeText = val('eff-badge').checked ? val('eff-badge-text').value.trim() : '';
        const audioSrc = val('eff-audio-src').value.trim();
        let audio = null;
        if (audioSrc) {
            audio = {
                mode: val('eff-audio-mode').value,
                volume: (parseInt(val('eff-audio-vol').value, 10) || 0) / 100,
                original_volume: (parseInt(val('eff-audio-orig').value, 10) || 0) / 100,
                start: parseFloat(val('eff-audio-start').value) || 0,
                loop: val('eff-audio-loop').checked,
                fade_out: 2,
            };
            // URL descargable o nombre de un archivo de la carpeta audio/ del repo
            if (/^https?:\/\//i.test(audioSrc)) audio.url = audioSrc; else audio.file = audioSrc;
        }
        return {
            aspect_ratio: val('eff-aspect').value,
            fade_in: val('eff-fadein').checked ? (parseFloat(val('eff-fadein-s').value) || 0) : 0,
            fade_out: val('eff-fadeout').checked ? (parseFloat(val('eff-fadeout-s').value) || 0) : 0,
            normalize_audio: val('eff-normalize').checked,
            title: titleText ? { text: titleText, position: val('eff-title-pos').value, duration: val('eff-title-dur').value } : null,
            watermark: watermarkText ? { text: watermarkText, position: val('eff-watermark-pos').value } : null,
            badge: badgeText ? { text: badgeText } : null,
            audio,
        };
    }

    // ================== VISTA PREVIA ==================
    // Reproduce los trozos en orden dibujando cada fotograma en un canvas,
    // con los mismos efectos visuales que se aplicarán al unir.
    // Limitación: el audio es el del vídeo original (música y normalización no se oyen).
    const PREVIEW_SIZES = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720] };
    let preview = null;

    function buildTimeline() {
        let offset = 0;
        return state.segments.map((seg, index) => {
            const item = { seg, index, offset, len: seg.end - seg.start };
            offset += item.len;
            return item;
        });
    }

    function drawFit(ctx, video, x, y, w, h, mode) {
        const scale = mode === 'cover'
            ? Math.max(w / video.videoWidth, h / video.videoHeight)
            : Math.min(w / video.videoWidth, h / video.videoHeight);
        const dw = video.videoWidth * scale;
        const dh = video.videoHeight * scale;
        ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }

    function drawOverlayText(ctx, text, position, w, h, alpha) {
        const size = Math.round(h * 0.05);
        const y = position === 'top' ? h * 0.1 : position === 'center' ? h / 2 : h * 0.9;
        ctx.save();
        ctx.font = `600 ${size}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = alpha;
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = size * 0.3;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, w / 2, y);
        ctx.restore();
    }

    function drawLoadingFrame(ctx, w, h) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        drawOverlayText(ctx, 'Cargando…', 'center', w, h, 0.8);
    }

    function drawPreviewFrame(p) {
        const { ctx, canvas, video, cfg, timeline, current: item, globalT: gT, total } = p;
        const w = canvas.width;
        const h = canvas.height;
        const seg = item.seg;
        const local = video.currentTime;

        // Mientras el navegador sigue buscando el punto exacto del vídeo (típico al
        // saltar a una parte del VOD que no estaba bufferizada) mostramos un aviso
        // en vez de un frame viejo o negro, para que no parezca que está congelado.
        if (video.seeking) {
            drawLoadingFrame(ctx, w, h);
            return;
        }

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        if (!video.videoWidth) return;

        // Formato: fondo difuminado + vídeo centrado (como en 9:16 y 1:1)
        if (cfg.aspect_ratio !== 'original') {
            ctx.save();
            ctx.filter = 'blur(24px)';
            drawFit(ctx, video, 0, 0, w, h, 'cover');
            ctx.restore();
        }

        // Zoom por trozo (estático o Ken Burns)
        let zoom = seg.zoomEnabled ? seg.zoomFactor : 1;
        if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1; // salvaguarda: nunca colapsar el dibujo
        if (seg.zoomEnabled && seg.kenburns) {
            const prog = Math.min(1, Math.max(0, (local - seg.start) / Math.max(0.1, item.len)));
            zoom = 1 + (zoom - 1) * prog;
        }
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.scale(zoom, zoom);
        drawFit(ctx, video, -w / 2, -h / 2, w, h, 'contain');
        ctx.restore();

        // Fundido a negro: transición de salida del trozo y de entrada al siguiente
        let dark = 0;
        const outD = seg.transitionType !== 'none' && item.index < timeline.length - 1 ? seg.transitionDuration : 0;
        const toEnd = seg.end - local;
        if (outD > 0 && toEnd < outD) dark = Math.max(dark, 1 - toEnd / outD);
        const prev = timeline[item.index - 1];
        if (prev && prev.seg.transitionType !== 'none') {
            const inD = prev.seg.transitionDuration;
            const sinceStart = local - seg.start;
            if (sinceStart < inD) dark = Math.max(dark, 1 - sinceStart / inD);
        }
        // Fade in / fade out globales del clip
        if (cfg.fade_in > 0 && gT < cfg.fade_in) dark = Math.max(dark, 1 - gT / cfg.fade_in);
        if (cfg.fade_out > 0 && total - gT < cfg.fade_out) dark = Math.max(dark, 1 - (total - gT) / cfg.fade_out);
        if (dark > 0) {
            ctx.fillStyle = `rgba(0,0,0,${Math.min(1, dark)})`;
            ctx.fillRect(0, 0, w, h);
        }

        // Título: primer trozo entero, o solo los primeros 5s del clip
        if (cfg.title) {
            const showTitle = cfg.title.duration === 'full' ? item.index === 0 : gT < 5;
            if (showTitle) drawOverlayText(ctx, cfg.title.text, cfg.title.position, w, h, 1);
        }
        // Marca de agua: en todos los trozos
        if (cfg.watermark) drawOverlayText(ctx, cfg.watermark.text, cfg.watermark.position, w, h, 0.6);
    }

    function segmentAt(t, timeline) {
        return timeline.find(it => t >= it.offset && t < it.offset + it.len) || timeline[timeline.length - 1];
    }

    function updatePreviewProgress(p) {
        const bar = document.getElementById('ytdl-pv-bar');
        const time = document.getElementById('ytdl-pv-time');
        if (bar) bar.style.width = (p.globalT / p.total) * 100 + '%';
        if (time) time.textContent = formatTime(p.globalT) + ' / ' + formatTime(p.total);
    }

    function seekPreview(gT) {
        const p = preview;
        if (!p) return;
        gT = Math.min(Math.max(0, gT), p.total - 0.01);
        const item = segmentAt(gT, p.timeline);
        p.current = item;
        p.globalT = gT;
        p.video.currentTime = item.seg.start + (gT - item.offset);
    }

    function previewTick() {
        const p = preview;
        if (!p) return;

        try {
            if (!p.video.seeking) {
                const cur = p.current;
                const local = p.video.currentTime;
                if (p.playing && local >= cur.seg.end - 0.05) {
                    // Fin del trozo: saltar al inicio del siguiente
                    const next = p.timeline[cur.index + 1];
                    if (next) {
                        p.current = next;
                        p.globalT = next.offset;
                        p.video.currentTime = next.seg.start;
                    } else {
                        pausePreview();
                        p.globalT = p.total;
                    }
                } else {
                    p.globalT = cur.offset + Math.min(cur.len, Math.max(0, local - cur.seg.start));
                }
            }

            drawPreviewFrame(p);
            updatePreviewProgress(p);
        } catch (err) {
            // Un error puntual en el dibujo (p.ej. algún efecto con un valor inválido)
            // ya no debe matar el bucle de animación en silencio: lo registramos y
            // seguimos intentando en el siguiente frame.
            console.error('[YTDL Clipper] Error dibujando la vista previa:', err);
        }

        p.raf = requestAnimationFrame(previewTick);
    }

    function playPreview() {
        const p = preview;
        if (!p) return;
        if (p.globalT >= p.total - 0.05) seekPreview(0);
        p.playing = true;
        p.video.play().catch(() => { /* el navegador puede bloquear la reproducción */ });
        p.playBtn.textContent = 'Pausar';
    }

    function pausePreview() {
        const p = preview;
        if (!p) return;
        p.playing = false;
        p.video.pause();
        p.playBtn.textContent = 'Reproducir';
    }

    function openPreview() {
        if (state.segments.length === 0) return;
        const video = getVideo();
        if (!video) { setStatus('No encuentro el reproductor', 'error'); return; }
        closePreview();

        const cfg = readEffectsOutput();
        const timeline = buildTimeline();
        const total = timeline.reduce((acc, it) => acc + it.len, 0);

        // Guardamos el estado real del vídeo para restaurarlo al cerrar, y tomamos
        // control total (lo pausamos) para que la vista previa no compita con el
        // vídeo si este se estaba reproduciendo cuando abriste el diálogo.
        const originalTime = video.currentTime;
        const wasPlaying = !video.paused;
        video.pause();

        const overlay = document.createElement('div');
        overlay.id = 'ytdl-pv-overlay';
        setHTML(overlay, `
            <div class="ytdl-pv-box">
                <div class="ytdl-pv-head">
                    <span class="ytdl-pv-title">Vista previa del clip</span>
                    <button class="ytdl-icon-btn" id="ytdl-pv-close" title="Cerrar (Esc)" aria-label="Cerrar">✕</button>
                </div>
                <div class="ytdl-pv-stage"><canvas id="ytdl-pv-canvas"></canvas></div>
                <div class="ytdl-pv-controls">
                    <button class="ytdl-btn ytdl-btn-primary" id="ytdl-pv-play">Reproducir</button>
                    <div class="ytdl-pv-progress" id="ytdl-pv-progress"><div class="ytdl-pv-bar" id="ytdl-pv-bar"></div></div>
                    <span class="ytdl-pv-time" id="ytdl-pv-time">0:00 / ${formatTime(total)}</span>
                </div>
                <div class="ytdl-pv-note">La música y la normalización de audio no se escuchan aquí: el sonido es el del vídeo original.</div>
            </div>
        `);
        document.body.appendChild(overlay);

        const canvas = overlay.querySelector('#ytdl-pv-canvas');
        const size = cfg.aspect_ratio === 'original'
            ? [video.videoWidth || 1280, video.videoHeight || 720]
            : PREVIEW_SIZES[cfg.aspect_ratio];
        canvas.width = size[0];
        canvas.height = size[1];

        const onKey = (e) => { if (e.key === 'Escape') closePreview(); };
        document.addEventListener('keydown', onKey);

        preview = {
            video, cfg, timeline, total,
            canvas, ctx: canvas.getContext('2d'),
            current: timeline[0], globalT: 0, playing: false, raf: null,
            playBtn: overlay.querySelector('#ytdl-pv-play'),
            onKey, originalTime, wasPlaying,
        };

        overlay.querySelector('#ytdl-pv-close').onclick = closePreview;
        overlay.querySelector('#ytdl-pv-play').onclick = () => (preview && preview.playing ? pausePreview() : playPreview());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closePreview(); });
        overlay.querySelector('#ytdl-pv-progress').addEventListener('click', (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seekPreview(((e.clientX - rect.left) / rect.width) * preview.total);
        });

        seekPreview(0);
        // Primer dibujo inmediato (muestra "Cargando…" si el seek no es instantáneo)
        drawPreviewFrame(preview);
        preview.raf = requestAnimationFrame(previewTick);
    }

    function closePreview() {
        if (!preview) return;
        cancelAnimationFrame(preview.raf);
        const { video, originalTime, wasPlaying } = preview;
        // Devolvemos el vídeo real a como estaba antes de abrir la vista previa,
        // en vez de dejarlo donde lo dejó el último trozo previsualizado.
        video.currentTime = originalTime;
        if (wasPlaying) video.play().catch(() => { /* el navegador puede bloquear la reproducción */ });
        else video.pause();
        document.removeEventListener('keydown', preview.onKey);
        const el = document.getElementById('ytdl-pv-overlay');
        if (el) el.remove();
        preview = null;
    }

    // ================== ENVIAR AL WORKER ==================
    function onMerge() {
        if (state.segments.length === 0) return;
        const url = getCurrentUrl();
        const output = readEffectsOutput();

        // Aviso suave (no bloquea): recuerda revisar el checklist de la campaña
        // actual antes de exportar sin título ni insignia, por si tu brief los exige.
        if (!output.title && !output.badge) {
            if (!confirm('Vas a exportar sin título ni insignia. Si tu campaña actual los exige, revisa el checklist antes de continuar.\n\n¿Continuar igualmente?')) {
                return;
            }
        }

        const payload = {
            url,
            segments: state.segments.map(s => ({
                start: s.start,
                end: s.end,
                zoom: s.zoomEnabled ? { factor: s.zoomFactor, kenburns: !!s.kenburns } : null,
                transition: (s.transitionType && s.transitionType !== 'none')
                    ? { type: s.transitionType, duration: s.transitionDuration } : null,
            })),
            output,
        };

        log('Payload a enviar:', payload);

        if (CONFIG.MOCK_MODE) {
            setStatus('MOCK: payload en consola');
            console.log(JSON.stringify(payload, null, 2));
            return;
        }

        setStatus('Enviando al Worker…');
        document.getElementById('ytdl-merge').disabled = true;

        GM_xmlhttpRequest({
            method: 'POST',
            url: CONFIG.WORKER_URL + '/merge',
            headers: { 'Content-Type': 'application/json', 'X-Client-Token': CONFIG.CLIENT_TOKEN },
            data: JSON.stringify(payload),
            onload: (resp) => {
                try {
                    const data = JSON.parse(resp.responseText);
                    if (data.ok && data.jobId) {
                        state.jobId = data.jobId;
                        setStatus('Procesando (job ' + data.jobId + ')');
                        startPolling();
                    } else {
                        setStatus('Error: ' + (data.error || 'desconocido'), 'error');
                        updateMergeButton();
                    }
                } catch (e) {
                    setStatus('Respuesta inválida del Worker', 'error');
                    updateMergeButton();
                }
            },
            onerror: () => {
                setStatus('No se pudo contactar al Worker', 'error');
                updateMergeButton();
            }
        });
    }

    // ================== RESULTADO: VER ONLINE / COMPARTIR ==================
    function escAttr(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function showResult(data) {
        // previewUrl: enlace del Worker que reproduce el clip sin descargarlo (y sirve
        // para compartirlo; caduca a los 7 días). downloadUrl: descarga directa.
        const preview = data.previewUrl || data.downloadUrl;
        const box = document.getElementById('ytdl-result');
        setHTML(box, `
            <video class="ytdl-video" id="ytdl-video" controls playsinline preload="metadata" src="${escAttr(preview)}"></video>
            <div class="ytdl-result-actions">
                <a href="${escAttr(preview)}" target="_blank" rel="noopener">Ver online</a>
                <button class="ytdl-mini-btn" id="ytdl-copy">Copiar enlace</button>
                <button class="ytdl-mini-btn" id="ytdl-share" style="display:none">Compartir</button>
                <a href="${escAttr(data.downloadUrl)}" target="_blank" rel="noopener">Descargar</a>
            </div>
            <div class="ytdl-hint" id="ytdl-hint">El enlace para ver y compartir dura 7 días.</div>
        `);
        const hint = document.getElementById('ytdl-hint');
        document.getElementById('ytdl-video').addEventListener('error', () => {
            hint.textContent = 'Esta página bloquea el reproductor incrustado: usa "Ver online" (se abre en una pestaña nueva).';
        });
        document.getElementById('ytdl-copy').addEventListener('click', () => {
            const done = () => { hint.textContent = 'Enlace copiado (válido 7 días).'; };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(preview).then(done, () => window.prompt('Copia el enlace:', preview));
            } else {
                window.prompt('Copia el enlace:', preview);
            }
        });
        if (navigator.share) {
            const shareBtn = document.getElementById('ytdl-share');
            shareBtn.style.display = '';
            shareBtn.addEventListener('click', () => {
                navigator.share({ title: 'Mi clip', url: preview }).catch(() => { /* cancelado */ });
            });
        }
    }

    function startPolling() {
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = setInterval(checkStatus, CONFIG.POLL_INTERVAL_MS);
        checkStatus();
    }

    function checkStatus() {
        if (!state.jobId) return;
        GM_xmlhttpRequest({
            method: 'GET',
            url: CONFIG.WORKER_URL + '/status/' + state.jobId,
            headers: { 'X-Client-Token': CONFIG.CLIENT_TOKEN },
            onload: (resp) => {
                try {
                    const data = JSON.parse(resp.responseText);
                    if (data.status === 'completed' && data.downloadUrl) {
                        clearInterval(state.pollTimer);
                        state.pollTimer = null;
                        setStatus('Clip listo');
                        showResult(data);
                        state.jobId = null;
                        updateMergeButton();
                    } else if (data.status === 'error') {
                        clearInterval(state.pollTimer);
                        state.pollTimer = null;
                        setStatus('Error: ' + (data.error || 'desconocido'), 'error');
                        state.jobId = null;
                        updateMergeButton();
                    } else {
                        setStatus((data.progress || 0) + '% · ' + (data.status || 'procesando'));
                    }
                } catch (e) { /* ignorar */ }
            }
        });
    }

    // ================== NAVEGACIÓN SPA ==================
    // Compara solo la identidad del video (no la URL completa), para que un
    // cambio de parámetro como "t=" (que YouTube añade solo al reproducir/buscar)
    // no se confunda con un cambio real de vídeo y borre los trozos marcados.
    function getVideoKey() {
        if (location.hostname.includes('youtube.com')) {
            const v = new URLSearchParams(location.search).get('v');
            if (v) return 'yt:' + v;
            return location.pathname; // shorts u otras rutas sin ?v=
        }
        // twitch.tv/videos/12345?t=1h2m -> nos quedamos solo con el pathname
        return location.pathname;
    }

    // Detección de cambio de vídeo:
    // - En YouTube, su router SPA dispara "yt-navigate-finish" en `document`
    //   justo cuando la navegación ha terminado y la URL ya está asentada en
    //   el vídeo definitivo. Usar ese evento evita el problema de raíz: no
    //   hay parpadeo que confundir porque no sondeamos la URL, actuamos solo
    //   cuando YouTube confirma que terminó.
    // - Ojo con la alternativa de "sondear y exigir N ticks seguidos para
    //   confirmar": soluciona el parpadeo, pero abre una ventana (~N
    //   segundos) en la que el panel sigue operando sobre el vídeo anterior.
    //   Si el usuario marca inicio/fin del vídeo nuevo en esa ventana, esas
    //   marcas se guardan en el array del vídeo viejo y se pierden en cuanto
    //   se confirma el cambio. Por eso en YouTube no dependemos de eso.
    // - En Twitch y otros sitios sin ese evento, mantenemos un sondeo, pero
    //   solo como red de seguridad (también cubre navegaciones de YouTube
    //   raras que no disparen el evento, como algunos saltos entre Shorts).
    const AUTOSAVE_EVERY_N_TICKS = 5; // autoguardado de red de seguridad (≈5s)

    function observeNavigation() {
        let lastKey = getVideoKey();

        function commitChange(newKey) {
            if (!newKey || newKey === lastKey) return;
            saveSegmentsFor(lastKey); // por si el usuario vuelve a este vídeo más tarde
            log('Navegación confirmada:', newKey);
            lastKey = newKey;

            state.marking = null;
            state.jobId = null;
            state.editingIndex = null;
            state.tlView = null;
            if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }

            const restored = loadSegmentsFor(newKey);
            state.segments = restored || [];

            const result = document.getElementById('ytdl-result');
            if (result) setHTML(result, '');
            const btnStart = document.getElementById('ytdl-mark-start');
            const btnEnd = document.getElementById('ytdl-mark-end');
            if (btnStart) btnStart.disabled = false;
            if (btnEnd) btnEnd.disabled = true;
            setStatus(restored ? ('Recuperados ' + restored.length + ' trozo(s) de este vídeo') : 'Listo');
            renderSegments();
        }

        if (location.hostname.includes('youtube.com')) {
            document.addEventListener('yt-navigate-finish', () => commitChange(getVideoKey()));
        }

        // Sondeo de red de seguridad (Twitch, otros sitios, y casos raros en
        // YouTube sin el evento). Como aquí SÍ podemos toparnos con un
        // parpadeo intermedio, exigimos que la key nueva se repita seguida
        // antes de darla por buena; en YouTube el evento de arriba ya habrá
        // resuelto el cambio antes de que esto llegue a confirmar nada.
        const POLL_CONFIRM_TICKS = 2;
        let pendingKey = null;
        let pendingCount = 0;
        let autosaveTick = 0;

        setInterval(() => {
            const key = getVideoKey();

            if (key === lastKey) {
                pendingKey = null;
                pendingCount = 0;
                if (state.editingIndex !== null) {
                    updateTimelinePlayhead();
                } else {
                    autosaveTick++;
                    if (autosaveTick >= AUTOSAVE_EVERY_N_TICKS) {
                        autosaveTick = 0;
                        saveSegmentsFor(lastKey);
                    }
                }
                return;
            }

            if (key === pendingKey) {
                pendingCount++;
            } else {
                pendingKey = key;
                pendingCount = 1;
            }
            if (pendingCount < POLL_CONFIRM_TICKS) return;

            const confirmedKey = pendingKey;
            pendingKey = null;
            pendingCount = 0;
            autosaveTick = 0;
            commitChange(confirmedKey);
        }, 1000);
    }

    // ================== ARRANQUE ==================
    function init() {
        if (document.body) {
            injectPanel();
            observeNavigation();
        } else {
            setTimeout(init, 500);
        }
    }

    init();
})();
