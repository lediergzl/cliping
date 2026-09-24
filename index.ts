export interface Env {
  GITHUB_TOKEN: string;
  CLIENT_TOKEN: string; // secreto compartido con el userscript, evita uso indebido del Worker
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW_FILE: string;
  GITHUB_REF: string;
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

function sanitizeOutput(out: any) {
  const o = out || {};
  const result: any = {
    aspect_ratio: ASPECTS.has(o.aspect_ratio) ? o.aspect_ratio : "original",
    fade_in: Math.min(Math.max(Number(o.fade_in) || 0, 0), 5),
    fade_out: Math.min(Math.max(Number(o.fade_out) || 0, 0), 5),
    normalize_audio: !!o.normalize_audio,
    title: null,
    watermark: null,
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
async function findRelease(env: Env, jobId: string) {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/clip-${jobId}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) return null;
  const data: any = await res.json();
  const asset = (data.assets || [])[0];
  return asset?.browser_download_url || null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Client-Token",
        },
      });
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

      const downloadUrl = await findRelease(env, jobId);
      if (!downloadUrl) {
        return json({ status: "processing", progress: 90 });
      }

      return json({ status: "completed", downloadUrl });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};
