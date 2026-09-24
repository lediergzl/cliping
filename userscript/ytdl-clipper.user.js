// ==UserScript==
// @name         YTDL Clipper
// @namespace    ytdl-clipper
// @version      0.6.0
// @description  Marca trozos de un directo/VOD de YouTube o Twitch y los une en un clip
// @match        https://www.youtube.com/*
// @match        https://www.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ================== CONFIG ==================
    const CONFIG = {
        WORKER_URL: 'https://ytdl-clipper-worker.TU-SUBDOMINIO.workers.dev', // ← pon tu URL real del Worker
        CLIENT_TOKEN: 'PON-AQUI-UNA-CADENA-ALEATORIA-PROPIA',                // ← igual al secret CLIENT_TOKEN del Worker
        POLL_INTERVAL_MS: 5000,
        MOCK_MODE: false,  // v1 real: llama al Worker
    };

    // ================== ESTADO ==================
    const state = {
        segments: [],   // [{ start, end }]
        marking: null,  // null | { start }
        jobId: null,
        pollTimer: null,
        editingIndex: null, // índice del trozo abierto para ajuste fino, o null
    };

    // ================== ANCHO DEL PANEL ==================
    const PANEL_WIDTH_KEY = 'ytdl-clipper-panel-width';
    const PANEL_WIDTH_MIN = 280;
    const PANEL_WIDTH_MAX = 900;
    const PANEL_WIDTH_DEFAULT = 320;

    function getSavedPanelWidth() {
        const raw = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10);
        if (Number.isNaN(raw)) return PANEL_WIDTH_DEFAULT;
        return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, raw));
    }

    function savePanelWidth(px) {
        try { localStorage.setItem(PANEL_WIDTH_KEY, String(px)); } catch (e) { /* ignorar */ }
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

    // ================== UI ==================
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
            // El panel está anclado a la derecha (right: 20px), así que
            // arrastrar hacia la izquierda (deltaX negativo) debe ensancharlo.
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

    function injectPanel() {
        if (document.getElementById('ytdl-clipper-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'ytdl-clipper-panel';
        setHTML(panel, `
            <div class="ytdl-resize-handle" id="ytdl-resize-handle" title="Arrastra para ensanchar"></div>
            <div class="ytdl-header">
                <span>🎬 YTDL Clipper</span>
                <button class="ytdl-toggle" title="Ocultar">—</button>
            </div>
            <div class="ytdl-body">
                <div class="ytdl-status" id="ytdl-status">Listo</div>
                <div class="ytdl-mark-area">
                    <button id="ytdl-mark-start" class="ytdl-btn ytdl-btn-primary">▶ Iniciar trozo</button>
                    <button id="ytdl-mark-end" class="ytdl-btn ytdl-btn-danger" disabled>■ Cerrar trozo</button>
                </div>
                <details class="ytdl-effects">
                    <summary>⚙ Efectos (opcional)</summary>
                    <div class="ytdl-effects-body">
                        <div class="ytdl-eff-row">
                            <label>Aspecto</label>
                            <select id="eff-aspect">
                                <option value="original">Original</option>
                                <option value="16:9">16:9</option>
                                <option value="9:16">9:16 (vertical)</option>
                                <option value="1:1">1:1</option>
                            </select>
                        </div>
                        <div class="ytdl-eff-row">
                            <label><input type="checkbox" id="eff-fadein"> Fade in</label>
                            <input type="number" id="eff-fadein-s" min="0" max="5" step="0.5" value="1">s
                        </div>
                        <div class="ytdl-eff-row">
                            <label><input type="checkbox" id="eff-fadeout"> Fade out</label>
                            <input type="number" id="eff-fadeout-s" min="0" max="5" step="0.5" value="1">s
                        </div>
                        <div class="ytdl-eff-row">
                            <label><input type="checkbox" id="eff-normalize"> Normalizar volumen</label>
                        </div>
                        <div class="ytdl-eff-row">
                            <input type="text" id="eff-title-text" placeholder="Título (opcional)">
                        </div>
                        <div class="ytdl-eff-row">
                            <select id="eff-title-pos">
                                <option value="top">Arriba</option>
                                <option value="center">Centro</option>
                                <option value="bottom" selected>Abajo</option>
                            </select>
                            <select id="eff-title-dur">
                                <option value="start" selected>Solo inicio (5s)</option>
                                <option value="full">Primer trozo entero</option>
                            </select>
                        </div>
                        <div class="ytdl-eff-row">
                            <input type="text" id="eff-watermark-text" placeholder="Marca de agua (opcional)">
                        </div>
                        <div class="ytdl-eff-row">
                            <select id="eff-watermark-pos">
                                <option value="top">Arriba</option>
                                <option value="center">Centro</option>
                                <option value="bottom" selected>Abajo</option>
                            </select>
                        </div>
                        <div class="ytdl-eff-sep">🎵 Música de fondo</div>
                        <div class="ytdl-eff-row">
                            <input type="text" id="eff-audio-src" placeholder="URL (YouTube, mp3...) o archivo de audio/">
                        </div>
                        <div class="ytdl-eff-row">
                            <select id="eff-audio-mode">
                                <option value="mix" selected>Mezclar con el original</option>
                                <option value="replace">Reemplazar el original</option>
                            </select>
                        </div>
                        <div class="ytdl-eff-row">
                            <label>Música</label>
                            <input type="range" id="eff-audio-vol" min="0" max="100" value="50">
                            <span id="eff-audio-vol-v" class="ytdl-eff-val">50%</span>
                        </div>
                        <div class="ytdl-eff-row">
                            <label>Original</label>
                            <input type="range" id="eff-audio-orig" min="0" max="100" value="100">
                            <span id="eff-audio-orig-v" class="ytdl-eff-val">100%</span>
                        </div>
                        <div class="ytdl-eff-row">
                            <label>Empezar en</label>
                            <input type="number" id="eff-audio-start" min="0" step="1" value="0" style="width:52px">s
                            <label><input type="checkbox" id="eff-audio-loop" checked> Repetir</label>
                        </div>
                    </div>
                </details>
                <div class="ytdl-segments" id="ytdl-segments"></div>
                <div class="ytdl-actions">
                    <button id="ytdl-merge" class="ytdl-btn ytdl-btn-merge" disabled>Unir y descargar</button>
                </div>
                <div class="ytdl-result" id="ytdl-result"></div>
            </div>
        `);
        document.body.appendChild(panel);

        const style = document.createElement('style');
        style.textContent = `
            #ytdl-clipper-panel {
                position: fixed; top: 80px; right: 20px;
                width: ${getSavedPanelWidth()}px; z-index: 99999;
                background: #18181b; color: #efeff1;
                border: 1px solid #2f2f35; border-radius: 8px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                user-select: none;
                max-width: 95vw;
            }
            #ytdl-clipper-panel.ytdl-collapsed .ytdl-body { display: none; }
            #ytdl-clipper-panel.ytdl-resizing { user-select: none; }
            .ytdl-resize-handle {
                position: absolute; top: 0; left: -4px; bottom: 0; width: 8px;
                cursor: ew-resize; z-index: 2;
            }
            .ytdl-resize-handle:hover, #ytdl-clipper-panel.ytdl-resizing .ytdl-resize-handle {
                background: rgba(145, 71, 255, 0.5);
            }
            #ytdl-clipper-panel.ytdl-resizing { transition: none; }
            #ytdl-clipper-panel iframe { pointer-events: none; }
            .ytdl-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 8px 12px; background: #0e0e10;
                border-bottom: 1px solid #2f2f35; border-radius: 8px 8px 0 0;
                font-weight: 600;
            }
            .ytdl-toggle {
                background: transparent; border: none; color: #adadb8;
                cursor: pointer; font-size: 16px; padding: 0 4px;
            }
            .ytdl-toggle:hover { color: #fff; }
            .ytdl-body { padding: 10px 12px; }
            .ytdl-status {
                font-size: 11px; color: #adadb8; margin-bottom: 8px;
                padding: 4px 6px; background: #0e0e10; border-radius: 4px;
                text-align: center;
            }
            .ytdl-mark-area { display: flex; gap: 6px; margin-bottom: 10px; }
            .ytdl-effects {
                margin-bottom: 10px; background: #0e0e10; border-radius: 4px; padding: 4px 6px;
            }
            .ytdl-effects summary {
                cursor: pointer; padding: 4px 2px; font-size: 12px; color: #adadb8; outline: none;
            }
            .ytdl-effects summary:hover { color: #fff; }
            .ytdl-effects-body { padding: 6px 2px 2px; }
            .ytdl-eff-row {
                display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 11px;
            }
            .ytdl-eff-row:last-child { margin-bottom: 0; }
            .ytdl-eff-row select, .ytdl-eff-row input[type="text"] {
                flex: 1; background: #1f1f23; color: #efeff1; border: 1px solid #2f2f35;
                border-radius: 3px; padding: 4px 6px; font-size: 11px; min-width: 0;
            }
            .ytdl-eff-row input[type="number"] {
                width: 42px; background: #1f1f23; color: #efeff1; border: 1px solid #2f2f35;
                border-radius: 3px; padding: 4px; font-size: 11px;
            }
            .ytdl-eff-row label { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
            .ytdl-btn {
                flex: 1; padding: 8px 10px; border: none; border-radius: 4px;
                cursor: pointer; font-size: 12px; font-weight: 600;
                transition: opacity 0.15s;
            }
            .ytdl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
            .ytdl-btn:not(:disabled):hover { opacity: 0.85; }
            .ytdl-btn-primary { background: #9147ff; color: #fff; }
            .ytdl-btn-danger { background: #eb0400; color: #fff; }
            .ytdl-btn-merge { background: #00b84c; color: #fff; width: 100%; }
            .ytdl-segments {
                max-height: 180px; overflow-y: auto; margin-bottom: 10px;
                background: #0e0e10; border-radius: 4px; padding: 6px;
            }
            .ytdl-empty { color: #6b6b74; text-align: center; padding: 12px 0; font-size: 12px; }
            .ytdl-segment {
                display: flex; align-items: center; justify-content: space-between;
                padding: 5px 6px; margin-bottom: 4px;
                background: #1f1f23; border-radius: 3px; font-size: 12px;
            }
            .ytdl-segment:last-child { margin-bottom: 0; }
            .ytdl-segment-time { color: #efeff1; font-family: monospace; }
            .ytdl-segment-actions { display: flex; gap: 4px; }
            .ytdl-segment-btn {
                background: transparent; border: none; color: #adadb8;
                cursor: pointer; font-size: 14px; padding: 0 4px;
            }
            .ytdl-segment-btn:hover { color: #fff; }
            .ytdl-segment-edit {
                margin-top: 6px; padding: 6px; background: #0e0e10;
                border-radius: 3px; font-size: 11px;
            }
            .ytdl-edit-row {
                display: flex; align-items: center; gap: 4px; margin-bottom: 4px;
            }
            .ytdl-edit-row:last-child { margin-bottom: 0; }
            .ytdl-edit-label { width: 34px; color: #adadb8; }
            .ytdl-edit-time { font-family: monospace; width: 62px; }
            .ytdl-nudge-btn {
                background: #2f2f35; border: none; color: #efeff1;
                border-radius: 3px; cursor: pointer; font-size: 10px;
                padding: 3px 6px; font-family: monospace;
            }
            .ytdl-nudge-btn:hover { background: #3f3f46; }
            .ytdl-edit-seek {
                background: #9147ff; border: none; color: #fff;
                border-radius: 3px; cursor: pointer; font-size: 10px;
                padding: 3px 6px; margin-left: auto;
            }
            .ytdl-edit-seek:hover { opacity: 0.85; }
            .ytdl-eff-sep { margin-top: 8px; padding-top: 6px; border-top: 1px solid #2f2f35; font-weight: 600; color: #adadb8; }
            .ytdl-eff-row input[type="range"] { flex: 1; min-width: 0; }
            .ytdl-eff-val { width: 34px; text-align: right; font-family: monospace; }
            .ytdl-result { margin-top: 8px; font-size: 12px; }
            .ytdl-result a { color: #9147ff; text-decoration: none; font-weight: 600; }
            .ytdl-result a:hover { text-decoration: underline; }
            .ytdl-video { width: 100%; max-height: 220px; background: #000; border-radius: 4px; margin-bottom: 6px; }
            .ytdl-result-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
            .ytdl-mini-btn {
                background: #2f2f35; border: none; color: #efeff1; border-radius: 3px;
                cursor: pointer; font-size: 11px; padding: 4px 8px;
            }
            .ytdl-mini-btn:hover { background: #3f3f46; }
            .ytdl-hint { margin-top: 6px; color: #adadb8; font-size: 11px; }
        `;
        document.head.appendChild(style);

        document.querySelector('#ytdl-clipper-panel .ytdl-toggle').onclick = () => {
            panel.classList.toggle('ytdl-collapsed');
        };
        setupPanelResize(panel);
        document.getElementById('ytdl-mark-start').onclick = onMarkStart;
        document.getElementById('ytdl-mark-end').onclick = onMarkEnd;
        document.getElementById('ytdl-merge').onclick = onMerge;
        [['eff-audio-vol', 'eff-audio-vol-v'], ['eff-audio-orig', 'eff-audio-orig-v']].forEach(([inp, out]) => {
            const el = document.getElementById(inp);
            el.addEventListener('input', () => { document.getElementById(out).textContent = el.value + '%'; });
        });

        renderSegments();
    }

    function setStatus(text) {
        const el = document.getElementById('ytdl-status');
        if (el) el.textContent = text;
    }

    function renderSegments() {
        const container = document.getElementById('ytdl-segments');
        if (!container) return;

        if (state.segments.length === 0) {
            setHTML(container, '<div class="ytdl-empty">Sin trozos marcados</div>');
        } else {
            setHTML(container, state.segments.map((seg, i) => `
                <div class="ytdl-segment" data-index="${i}">
                    <div style="display:flex; align-items:center; justify-content:space-between;">
                        <span class="ytdl-segment-time">
                            ${i + 1}. ${formatTime(seg.start)} → ${formatTime(seg.end)}
                            <span style="color:#6b6b74">(${formatTime(seg.end - seg.start)})</span>
                        </span>
                        <span class="ytdl-segment-actions">
                            <button class="ytdl-segment-btn" data-action="edit" title="Ajustar recorte">✎</button>
                            <button class="ytdl-segment-btn" data-action="up" title="Subir">↑</button>
                            <button class="ytdl-segment-btn" data-action="down" title="Bajar">↓</button>
                            <button class="ytdl-segment-btn" data-action="delete" title="Borrar">✕</button>
                        </span>
                    </div>
                    ${state.editingIndex === i ? `
                    <div class="ytdl-segment-edit">
                        <div class="ytdl-edit-row">
                            <span class="ytdl-edit-label">Inicio</span>
                            <span class="ytdl-edit-time">${formatTime(seg.start)}</span>
                            <button class="ytdl-nudge-btn" data-edge="start" data-delta="-1">-1s</button>
                            <button class="ytdl-nudge-btn" data-edge="start" data-delta="-0.1">-.1</button>
                            <button class="ytdl-nudge-btn" data-edge="start" data-delta="0.1">+.1</button>
                            <button class="ytdl-nudge-btn" data-edge="start" data-delta="1">+1s</button>
                            <button class="ytdl-edit-seek" data-edge="start" data-action="seek">▶ Ver</button>
                        </div>
                        <div class="ytdl-edit-row">
                            <span class="ytdl-edit-label">Fin</span>
                            <span class="ytdl-edit-time">${formatTime(seg.end)}</span>
                            <button class="ytdl-nudge-btn" data-edge="end" data-delta="-1">-1s</button>
                            <button class="ytdl-nudge-btn" data-edge="end" data-delta="-0.1">-.1</button>
                            <button class="ytdl-nudge-btn" data-edge="end" data-delta="0.1">+.1</button>
                            <button class="ytdl-nudge-btn" data-edge="end" data-delta="1">+1s</button>
                            <button class="ytdl-edit-seek" data-edge="end" data-action="seek">▶ Ver</button>
                        </div>
                        <div class="ytdl-edit-row">
                            <button class="ytdl-nudge-btn" data-edge="start" data-action="snap">● Fijar inicio en playhead</button>
                        </div>
                        <div class="ytdl-edit-row">
                            <button class="ytdl-nudge-btn" data-edge="end" data-action="snap">● Fijar fin en playhead</button>
                        </div>
                        <div class="ytdl-edit-row" style="border-top:1px solid #2f2f35; padding-top:6px;">
                            <label><input type="checkbox" class="ytdl-eff-input" data-field="zoomEnabled" ${seg.zoomEnabled ? 'checked' : ''}> Zoom</label>
                            <input type="number" class="ytdl-eff-input" data-field="zoomFactor" value="${seg.zoomFactor}" min="1.05" max="3" step="0.05" style="width:44px">
                            <label><input type="checkbox" class="ytdl-eff-input" data-field="kenburns" ${seg.kenburns ? 'checked' : ''}> Ken Burns</label>
                        </div>
                        <div class="ytdl-edit-row">
                            <span class="ytdl-edit-label">Transición→</span>
                            <select class="ytdl-eff-input" data-field="transitionType">
                                <option value="none" ${seg.transitionType === 'none' ? 'selected' : ''}>Ninguna</option>
                                <option value="fade" ${seg.transitionType === 'fade' ? 'selected' : ''}>Fade</option>
                                <option value="dissolve" ${seg.transitionType === 'dissolve' ? 'selected' : ''}>Dissolve</option>
                                <option value="wipe" ${seg.transitionType === 'wipe' ? 'selected' : ''}>Wipe</option>
                            </select>
                            <input type="number" class="ytdl-eff-input" data-field="transitionDuration" value="${seg.transitionDuration}" min="0.2" max="3" step="0.1" style="width:40px">s
                        </div>
                    </div>
                    ` : ''}
                </div>
            `).join(''));

            container.querySelectorAll('.ytdl-segment-btn[data-action]').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.target.closest('.ytdl-segment').dataset.index);
                    const action = e.target.dataset.action;
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
                    const idx = parseInt(e.target.closest('.ytdl-segment').dataset.index);
                    nudgeSegment(idx, e.target.dataset.edge, parseFloat(e.target.dataset.delta));
                };
            });

            container.querySelectorAll('[data-action="seek"]').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.target.closest('.ytdl-segment').dataset.index);
                    seekToEdge(idx, e.target.dataset.edge);
                };
            });

            container.querySelectorAll('[data-action="snap"]').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.target.closest('.ytdl-segment').dataset.index);
                    snapEdgeToPlayhead(idx, e.target.dataset.edge);
                };
            });

            container.querySelectorAll('.ytdl-eff-input[data-field]').forEach(input => {
                input.onchange = (e) => {
                    const idx = parseInt(e.target.closest('.ytdl-segment').dataset.index);
                    const seg = state.segments[idx];
                    if (!seg) return;
                    const field = e.target.dataset.field;
                    if (e.target.type === 'checkbox') seg[field] = e.target.checked;
                    else if (e.target.type === 'number') seg[field] = parseFloat(e.target.value) || 0;
                    else seg[field] = e.target.value;
                };
            });
        }
        updateMergeButton();
    }

    // ================== AJUSTE FINO (recorte al unir) ==================
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
    }

    // ================== MARCADO ==================
    function onMarkStart() {
        const video = getVideo();
        if (!video) { setStatus('⚠️ No encuentro el reproductor'); return; }
        state.marking = { start: video.currentTime };
        document.getElementById('ytdl-mark-start').disabled = true;
        document.getElementById('ytdl-mark-end').disabled = false;
        setStatus('● Grabando desde ' + formatTime(video.currentTime));
    }

    function onMarkEnd() {
        if (!state.marking) return;
        const video = getVideo();
        if (!video) return;
        const end = video.currentTime;
        if (end <= state.marking.start) {
            setStatus('⚠️ El fin debe ser después del inicio');
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
            audio,
        };
    }

    // ================== ENVIAR AL WORKER ==================
    function onMerge() {
        if (state.segments.length === 0) return;
        const url = getCurrentUrl();

        const payload = {
            url,
            segments: state.segments.map(s => ({
                start: s.start,
                end: s.end,
                zoom: s.zoomEnabled ? { factor: s.zoomFactor, kenburns: !!s.kenburns } : null,
                transition: (s.transitionType && s.transitionType !== 'none')
                    ? { type: s.transitionType, duration: s.transitionDuration } : null,
            })),
            output: readEffectsOutput(),
        };

        log('Payload a enviar:', payload);

        if (CONFIG.MOCK_MODE) {
            setStatus('🧪 MOCK: payload en consola');
            console.log(JSON.stringify(payload, null, 2));
            return;
        }

        setStatus('⏳ Enviando al Worker...');
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
                        setStatus('⏳ Procesando... (job ' + data.jobId + ')');
                        startPolling();
                    } else {
                        setStatus('❌ Error: ' + (data.error || 'desconocido'));
                        updateMergeButton();
                    }
                } catch (e) {
                    setStatus('❌ Respuesta inválida del Worker');
                    updateMergeButton();
                }
            },
            onerror: () => {
                setStatus('❌ No se pudo contactar al Worker');
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
                <a href="${escAttr(preview)}" target="_blank" rel="noopener">▶ Ver online</a>
                <button class="ytdl-mini-btn" id="ytdl-copy">🔗 Copiar enlace</button>
                <button class="ytdl-mini-btn" id="ytdl-share" style="display:none">📤 Compartir</button>
                <a href="${escAttr(data.downloadUrl)}" target="_blank" rel="noopener">⬇️ Descargar</a>
            </div>
            <div class="ytdl-hint" id="ytdl-hint">El enlace para ver y compartir dura 7 días.</div>
        `);
        const hint = document.getElementById('ytdl-hint');
        document.getElementById('ytdl-video').addEventListener('error', () => {
            hint.textContent = 'Esta página bloquea el reproductor incrustado: usa "Ver online" (se abre en una pestaña nueva).';
        });
        document.getElementById('ytdl-copy').addEventListener('click', () => {
            const done = () => { hint.textContent = '✅ Enlace copiado (válido 7 días).'; };
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
                        setStatus('✅ Clip listo');
                        showResult(data);
                        state.jobId = null;
                        updateMergeButton();
                    } else if (data.status === 'error') {
                        clearInterval(state.pollTimer);
                        state.pollTimer = null;
                        setStatus('❌ Error: ' + (data.error || 'desconocido'));
                        state.jobId = null;
                        updateMergeButton();
                    } else {
                        setStatus('⏳ ' + (data.progress || 0) + '% — ' + (data.status || 'procesando'));
                    }
                } catch (e) { /* ignorar */ }
            }
        });
    }

    // ================== NAVEGACIÓN SPA ==================
    function observeNavigation() {
        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('Navegación detectada:', lastUrl);
                state.segments = [];
                state.marking = null;
                state.jobId = null;
                if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
                const result = document.getElementById('ytdl-result');
                if (result) setHTML(result, '');
                const btnStart = document.getElementById('ytdl-mark-start');
                const btnEnd = document.getElementById('ytdl-mark-end');
                if (btnStart) btnStart.disabled = false;
                if (btnEnd) btnEnd.disabled = true;
                setStatus('Listo');
                renderSegments();
            }
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
