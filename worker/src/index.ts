export interface Env {
  GITHUB_TOKEN: string;
  CLIENT_TOKEN: string; // secreto compartido con el userscript, evita uso indebido del Worker
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW_FILE: string;
  GITHUB_PUBLISH_WORKFLOW_FILE: string;
  GITHUB_REF: string;
  PUBLISH_KV: KVNamespace;
  SESSION_ENC_KEY: string; // cifra las cookies de sesión guardadas en KV
}

const GH_API = "https://api.github.com";
const MAX_SEGMENTS = 20;
const MAX_SEGMENT_SECONDS = 1800;   // 30 min por trozo
const MAX_TOTAL_SECONDS = 3600;     // 60 min sumando todos los trozos

function ghHeaders(env: Env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ytdl-clipper-worker",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function makeJobId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function jobTimestamp(jobId: string): number {
  const ts = Number(jobId.split("-")[0]);
  return Number.isFinite(ts) ? ts : 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = request.headers.get("X-Client-Token");
  return !!env.CLIENT_TOKEN && token === env.CLIENT_TOKEN;
}

const ASPECTS = new Set(["original", "16:9", "9:16", "1:1"]);
const TRANSITIONS = new Set(["none", "fade", "dissolve", "wipe"]);

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

// Audio de fondo: o una URL http(s) (YouTube, SoundCloud, mp3 directo...) o el
// nombre de un fichero de la carpeta audio/ del repo. Nunca rutas.
const AUDIO_FILE_RE = /^[\w\- ().]{1,80}\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;

function sanitizeAudio(a: any) {
  if (!a || typeof a !== "object") return null;
  const res: any = {
    mode: a.mode === "replace" ? "replace" : "mix",
    volume: clamp(Number(a.volume ?? 0.5), 0, 1),
    original_volume: clamp(Number(a.original_volume ?? 1), 0, 1),
    start: clamp(Number(a.start) || 0, 0, 36000),
    loop: a.loop !== false,
    fade_out: clamp(Number(a.fade_out ?? 2), 0, 10),
  };
  if (typeof a.url === "string" && /^https?:\/\//i.test(a.url.trim()) && a.url.length <= 500) {
    res.url = a.url.trim();
  } else if (typeof a.file === "string" && AUDIO_FILE_RE.test(a.file.trim()) && !a.file.includes("..")) {
    res.file = a.file.trim();
  } else {
    return null;
  }
  return res;
}

function sanitizeOutput(out: any) {
  const o = out || {};
  const result: any = {
    aspect_ratio: ASPECTS.has(o.aspect_ratio) ? o.aspect_ratio : "original",
    fade_in: Math.min(Math.max(Number(o.fade_in) || 0, 0), 5),
    fade_out: Math.min(Math.max(Number(o.fade_out) || 0, 0), 5),
    normalize_audio: !!o.normalize_audio,
    title: null,
    watermark: null,
    badge: null,
    audio: sanitizeAudio(o.audio),
  };
  if (o.title?.text && typeof o.title.text === "string") {
    result.title = {
      text: o.title.text.slice(0, 80),
      position: ["top", "center", "bottom"].includes(o.title.position) ? o.title.position : "bottom",
      duration: o.title.duration === "full" ? "full" : "start",
    };
  }
  if (o.watermark?.text && typeof o.watermark.text === "string") {
    result.watermark = {
      text: o.watermark.text.slice(0, 40),
      position: ["top", "center", "bottom"].includes(o.watermark.position) ? o.watermark.position : "bottom",
    };
  }
  if (o.badge?.text && typeof o.badge.text === "string") {
    result.badge = { text: o.badge.text.slice(0, 30) };
  }
  return result;
}

function sanitizeSegmentEffects(s: any) {
  const extra: any = {};
  if (s?.zoom?.factor) {
    const factor = Math.min(Math.max(Number(s.zoom.factor) || 1, 1), 3);
    if (factor > 1) extra.zoom = { factor, kenburns: !!s.zoom.kenburns };
  }
  if (s?.transition?.type && TRANSITIONS.has(s.transition.type) && s.transition.type !== "none") {
    extra.transition = {
      type: s.transition.type,
      duration: Math.min(Math.max(Number(s.transition.duration) || 0.5, 0.2), 3),
    };
  }
  return extra;
}

function validatePayload(body: any): { ok: true; segments: any[]; output: any } | { ok: false; error: string } {
  if (!body?.url || typeof body.url !== "string") return { ok: false, error: "Falta 'url'" };
  if (!Array.isArray(body.segments) || body.segments.length === 0) return { ok: false, error: "Falta 'segments'" };
  if (body.segments.length > MAX_SEGMENTS) return { ok: false, error: `Máximo ${MAX_SEGMENTS} trozos` };

  let total = 0;
  const segments = [];
  for (const s of body.segments) {
    const start = Number(s?.start);
    const end = Number(s?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return { ok: false, error: "Trozo inválido (start/end)" };
    }
    const dur = end - start;
    if (dur > MAX_SEGMENT_SECONDS) return { ok: false, error: `Un trozo supera ${MAX_SEGMENT_SECONDS}s` };
    total += dur;
    segments.push({ start, end, ...sanitizeSegmentEffects(s) });
  }
  if (total > MAX_TOTAL_SECONDS) return { ok: false, error: `Duración total supera ${MAX_TOTAL_SECONDS}s` };

  return { ok: true, segments, output: sanitizeOutput(body.output) };
}

async function dispatchWorkflow(env: Env, jobId: string, payload: unknown) {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: env.GITHUB_REF,
      inputs: {
        job_id: jobId,
        payload: JSON.stringify(payload),
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch falló: ${res.status} ${text}`);
  }
}

// GitHub no devuelve el run_id al disparar workflow_dispatch, así que
// buscamos el run más antiguo creado después del timestamp del jobId.
async function findRun(env: Env, jobId: string) {
  const since = jobTimestamp(jobId) - 15000; // margen de 15s
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=10`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) return null;
  const data: any = await res.json();
  const candidates = (data.workflow_runs || [])
    .filter((r: any) => new Date(r.created_at).getTime() >= since)
    .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return candidates[0] || null;
}

// El workflow publica el Release con tag "clip-<job_id>".
async function findReleaseAsset(env: Env, jobId: string) {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/clip-${jobId}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) return null;
  const data: any = await res.json();
  const asset = (data.assets || [])[0];
  return asset ? { id: asset.id as number, url: asset.browser_download_url as string } : null;
}

// ---------- Enlaces firmados para ver el clip online ----------
// Un <video> no puede enviar cabeceras, así que /v/<jobId> se protege con una
// firma HMAC (clave: CLIENT_TOKEN) y caducidad, no con X-Client-Token.
const JOB_ID_RE = /^\d{10,}-[0-9a-f]{8}$/;
const LINK_TTL_SECONDS = 7 * 24 * 3600;

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signedLink(env: Env, origin: string, jobId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const sig = await hmacHex(env.CLIENT_TOKEN, `v:${jobId}:${exp}`);
  return `${origin}/v/${jobId}?e=${exp}&s=${sig}`;
}

// Sirve el MP4 del Release "inline" y con soporte de Range (para poder saltar
// por el vídeo). GitHub lo entrega como descarga (attachment), por eso se hace
// de intermediario en vez de enlazar directamente.
async function streamClip(request: Request, env: Env, url: URL, jobId: string): Promise<Response> {
  const exp = Number(url.searchParams.get("e"));
  const sig = url.searchParams.get("s") || "";
  if (!JOB_ID_RE.test(jobId) || !Number.isFinite(exp) || exp < Date.now() / 1000) {
    return new Response("Enlace caducado o inválido", { status: 403 });
  }
  const expected = await hmacHex(env.CLIENT_TOKEN, `v:${jobId}:${exp}`);
  if (!safeEqual(sig, expected)) return new Response("Firma inválida", { status: 403 });

  const asset = await findReleaseAsset(env, jobId);
  if (!asset) return new Response("Clip no encontrado", { status: 404 });

  // 1) El API responde 302 hacia una URL temporal de almacenamiento.
  const first = await fetch(`${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${asset.id}`, {
    headers: { ...ghHeaders(env), Accept: "application/octet-stream" },
    redirect: "manual",
  });
  const location = first.headers.get("Location");
  if (!location) return new Response("No se pudo obtener el clip", { status: 502 });

  // 2) Se pide esa URL (sin credenciales) reenviando el Range del navegador.
  const range = request.headers.get("Range");
  const upstream = await fetch(location, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: range ? { Range: range } : {},
  });

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Content-Disposition": url.searchParams.get("dl")
      ? `attachment; filename="clip-${jobId}.mp4"`
      : `inline; filename="clip-${jobId}.mp4"`,
  });
  for (const h of ["Content-Length", "Content-Range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

// ---------- Sesiones de navegador (storageState de Playwright), cifradas ----------
// Se guardan en KV como { account: string } -> AES-GCM(storageState JSON).
// Cifrado con SESSION_ENC_KEY para que ni el dashboard de Cloudflare las
// muestre en claro; solo quien tiene CLIENT_TOKEN + SESSION_ENC_KEY puede
// leerlas de vuelta (el propio Worker, al servirlas al Action).

const ACCOUNT_RE = /^[a-zA-Z0-9_-]{1,64}$/;

async function encKey(env: Env): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SESSION_ENC_KEY));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptJSON(env: Env, data: unknown): Promise<string> {
  const key = await encKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptJSON(env: Env, b64: string): Promise<unknown> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const cipher = raw.slice(12);
  const key = await encKey(env);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function saveSession(request: Request, env: Env, account: string): Promise<Response> {
  if (!ACCOUNT_RE.test(account)) return json({ ok: false, error: "Nombre de cuenta inválido" }, 400);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!body?.state) return json({ ok: false, error: "Falta 'state'" }, 400);

  const enc = await encryptJSON(env, body.state);
  await env.PUBLISH_KV.put(`session:${account}`, enc);
  return json({ ok: true });
}

async function loadSession(env: Env, account: string): Promise<Response> {
  if (!ACCOUNT_RE.test(account)) return json({ ok: false, error: "Nombre de cuenta inválido" }, 400);
  const enc = await env.PUBLISH_KV.get(`session:${account}`);
  if (!enc) return json({ ok: false, error: "No hay sesión guardada para esta cuenta" }, 404);
  const state = await decryptJSON(env, enc);
  return json({ ok: true, state });
}

// ---------- Publicación ----------
const PLATFORMS = new Set(["tiktok", "instagram", "facebook", "youtube"]);

function validatePublishPayload(body: any): { ok: true; data: any } | { ok: false; error: string } {
  if (!body?.platform || !PLATFORMS.has(body.platform)) return { ok: false, error: "'platform' inválida" };
  if (!body?.account || !ACCOUNT_RE.test(body.account)) return { ok: false, error: "'account' inválida" };
  if (!body?.clip_url || typeof body.clip_url !== "string") return { ok: false, error: "Falta 'clip_url'" };
  return {
    ok: true,
    data: {
      platform: body.platform,
      account: body.account,
      clip_url: body.clip_url,
      caption: typeof body.caption === "string" ? body.caption.slice(0, 2000) : "",
      hashtags: Array.isArray(body.hashtags) ? body.hashtags.slice(0, 30).map(String) : [],
    },
  };
}

async function dispatchPublishWorkflow(env: Env, jobId: string, payload: unknown) {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_PUBLISH_WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: env.GITHUB_REF,
      inputs: { job_id: jobId, payload: JSON.stringify(payload) },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch falló: ${res.status} ${text}`);
  }
}

async function findPublishRun(env: Env, jobId: string) {
  const since = jobTimestamp(jobId) - 15000;
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_PUBLISH_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=10`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) return null;
  const data: any = await res.json();
  const candidates = (data.workflow_runs || [])
    .filter((r: any) => new Date(r.created_at).getTime() >= since)
    .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return candidates[0] || null;
}

// El Action llama aquí al terminar (éxito o error) — así no dependemos de
// artifacts/releases para saber el resultado de una publicación.
async function savePublishResult(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!body?.job_id || !/^pub-/.test(body.job_id)) return json({ ok: false, error: "job_id inválido" }, 400);

  await env.PUBLISH_KV.put(
    `result:${body.job_id}`,
    JSON.stringify({
      status: body.status === "done" ? "done" : "error",
      url: body.url || null,
      error: body.error || null,
      finishedAt: new Date().toISOString(),
    }),
    { expirationTtl: 30 * 24 * 3600 } // 30 días, para no acumular basura en KV
  );
  return json({ ok: true });
}

async function publishStatus(env: Env, jobId: string): Promise<Response> {
  const stored = await env.PUBLISH_KV.get(`result:${jobId}`);
  if (stored) return json({ status: "resolved", ...JSON.parse(stored) });

  const run = await findPublishRun(env, jobId);
  if (!run) return json({ status: "queued", progress: 0 });
  if (run.status !== "completed") {
    return json({ status: run.status, progress: run.status === "in_progress" ? 50 : 10 });
  }
  if (run.conclusion !== "success") {
    return json({ status: "error", error: `Workflow terminó con: ${run.conclusion}` });
  }
  // Terminó bien pero aún no llegó el callback con el resultado — raro pero posible.
  return json({ status: "in_progress", progress: 95 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Client-Token, Range",
        },
      });
    }

    // Vista online: protegida por enlace firmado (un <video> no envía cabeceras).
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/v/")) {
      return streamClip(request, env, url, url.pathname.slice(3));
    }

    if (!isAuthorized(request, env)) {
      return json({ ok: false, status: "error", error: "No autorizado" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/merge") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "JSON inválido" }, 400);
      }

      const validation = validatePayload(body);
      if (!validation.ok) return json({ ok: false, error: validation.error }, 400);

      const jobId = makeJobId();
      try {
        await dispatchWorkflow(env, jobId, {
          url: body.url,
          segments: validation.segments,
          output: validation.output,
        });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 502);
      }

      return json({ ok: true, jobId });
    }

    if (request.method === "GET" && url.pathname.startsWith("/status/")) {
      const jobId = url.pathname.split("/status/")[1];
      if (!jobId) return json({ status: "error", error: "jobId faltante" }, 400);

      if (jobId.startsWith("pub-")) {
        return publishStatus(env, jobId);
      }

      const run = await findRun(env, jobId);
      if (!run) {
        return json({ status: "queued", progress: 0 });
      }

      if (run.status !== "completed") {
        return json({ status: run.status, progress: run.status === "in_progress" ? 50 : 10 });
      }

      if (run.conclusion !== "success") {
        return json({ status: "error", error: `Workflow terminó con: ${run.conclusion}` });
      }

      const asset = await findReleaseAsset(env, jobId);
      if (!asset) {
        return json({ status: "processing", progress: 90 });
      }

      // previewUrl: se puede reproducir online y compartir (caduca a los 7 días).
      // downloadUrl: descarga directa desde GitHub.
      const previewUrl = await signedLink(env, url.origin, jobId);
      return json({ status: "completed", downloadUrl: asset.url, previewUrl });
    }

    // --- Sesiones de navegador por cuenta (usadas por el flujo de publicación) ---
    if (url.pathname.startsWith("/session/")) {
      const account = url.pathname.slice("/session/".length);
      if (request.method === "PUT") return saveSession(request, env, account);
      if (request.method === "GET") return loadSession(env, account);
      return json({ ok: false, error: "Método no soportado" }, 405);
    }

    // --- Publicar un clip ya generado en una red social ---
    if (request.method === "POST" && url.pathname === "/publish") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "JSON inválido" }, 400);
      }

      const validation = validatePublishPayload(body);
      if (!validation.ok) return json({ ok: false, error: validation.error }, 400);

      const jobId = `pub-${makeJobId()}`;
      try {
        await dispatchPublishWorkflow(env, jobId, validation.data);
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 502);
      }
      return json({ ok: true, jobId });
    }

    // --- El Action reporta aquí el resultado final de una publicación ---
    if (request.method === "POST" && url.pathname === "/publish-result") {
      return savePublishResult(request, env);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};
