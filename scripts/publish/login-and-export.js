// Uso (corre en TU PC, una sola vez por cuenta, o cuando una sesión expire):
//   WORKER_URL=https://tu-worker.workers.dev CLIENT_TOKEN=tu-token \
//   node scripts/publish/login-and-export.js --account cuenta1 --platform tiktok
//
// Abre un Chrome real. Inicias sesión a mano (usuario, contraseña, 2FA si
// pide) y cuando termines cierras esa ventana. En ese momento se exporta la
// sesión (cookies + localStorage) y se sube cifrada al Worker, para que el
// Action de GitHub la use sin que tú tengas que volver a loguear nada.

import { chromium } from 'playwright';

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`Falta la variable de entorno ${name}`);
        process.exit(1);
    }
    return v;
}

const WORKER_URL = requireEnv('WORKER_URL');
const CLIENT_TOKEN = requireEnv('CLIENT_TOKEN');

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, cur, i, arr) => {
        if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
        return acc;
    }, [])
);

const PLATFORM_URLS = {
    tiktok: 'https://www.tiktok.com/login',
    instagram: 'https://www.instagram.com/accounts/login/',
    facebook: 'https://www.facebook.com/login',
    youtube: 'https://accounts.google.com/signin',
};

async function main() {
    const account = args.account;
    const platform = args.platform;
    if (!account || !platform) {
        console.error('Uso: --account <nombre> --platform <tiktok|instagram|facebook|youtube>');
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(PLATFORM_URLS[platform] || 'about:blank');

    console.log(`\nInicia sesión en ${platform} como "${account}" en la ventana que se abrió.`);
    console.log('Cuando termines, vuelve aquí y presiona ENTER (no cierres la ventana todavía).\n');

    await new Promise((resolve) => process.stdin.once('data', resolve));

    const state = await context.storageState();
    const res = await fetch(`${WORKER_URL}/session/${encodeURIComponent(account)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-Token': CLIENT_TOKEN },
        body: JSON.stringify({ state }),
    });

    if (!res.ok) {
        console.error(`No se pudo guardar la sesión en el Worker (${res.status}):`, await res.text());
        process.exitCode = 1;
    } else {
        console.log(`Sesión de "${account}" guardada. Ya puedes cerrar la ventana de Chrome.`);
    }

    await browser.close();
    process.exit();
}

main();
