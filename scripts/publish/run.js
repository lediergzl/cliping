import fs from 'node:fs';
import { chromium } from 'playwright';
import { getSession, putSession, reportResult } from './lib/workerClient.js';
import { TikTokAdapter } from './adapters/tiktok.js';
// A medida que agregues redes: import { InstagramAdapter } from './adapters/instagram.js'; etc.

const ADAPTERS = {
    tiktok: TikTokAdapter,
    // instagram: InstagramAdapter,
    // facebook: FacebookAdapter,
    // youtube: YouTubeAdapter,
};

const FAILURE_DIR = './failure-evidence';
const CLIP_PATH = './clip.mp4';

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`Falta la variable de entorno ${name}`);
        process.exit(1);
    }
    return v;
}

async function downloadClip(url) {
    console.log('Descargando clip:', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo descargar el clip (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(CLIP_PATH, buf);
    console.log(`Clip descargado: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

async function saveFailureEvidence(page, error) {
    fs.mkdirSync(FAILURE_DIR, { recursive: true });
    try {
        if (page) {
            await page.screenshot({ path: `${FAILURE_DIR}/screenshot.png`, fullPage: true });
            fs.writeFileSync(`${FAILURE_DIR}/page.html`, await page.content(), 'utf8');
        }
    } catch (e) {
        console.warn('No se pudo capturar evidencia adicional:', e.message);
    }
    fs.writeFileSync(`${FAILURE_DIR}/error.txt`, `${error?.stack || error}`, 'utf8');
}

async function main() {
    const jobId = requireEnv('JOB_ID');
    const payload = JSON.parse(requireEnv('PAYLOAD'));
    const { platform, account, clip_url: clipUrl, caption, hashtags } = payload;

    const Adapter = ADAPTERS[platform];
    if (!Adapter) {
        await reportResult(jobId, { status: 'error', error: `Plataforma sin adapter: ${platform}` });
        console.error(`Plataforma sin adapter: ${platform}`);
        process.exit(1);
    }

    await downloadClip(clipUrl);

    console.log(`Cargando sesión de la cuenta "${account}"...`);
    const storageState = await getSession(account);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    try {
        console.log(`Publicando en ${platform} como "${account}"...`);
        const adapter = new Adapter();
        const result = await adapter.upload(page, { filePath: CLIP_PATH, caption, hashtags });

        // Las plataformas suelen rotar cookies al usarlas — guardamos la sesión
        // actualizada para que la próxima publicación siga funcionando.
        const freshState = await context.storageState();
        await putSession(account, freshState);

        await reportResult(jobId, { status: 'done', url: result.url || null });
        console.log('Publicado OK:', result.url || '(sin URL)');
    } catch (err) {
        console.error('Publicación FALLÓ:', err.message);
        await saveFailureEvidence(page, err);
        await reportResult(jobId, { status: 'error', error: err.message });
        process.exitCode = 1;
    } finally {
        await browser.close().catch(() => {});
    }
}

main();
