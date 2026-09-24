const WORKER_URL = requireEnv('WORKER_URL');
const CLIENT_TOKEN = requireEnv('CLIENT_TOKEN');

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`Falta la variable de entorno ${name}`);
        process.exit(1);
    }
    return v;
}

async function call(path, options = {}) {
    const res = await fetch(`${WORKER_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'X-Client-Token': CLIENT_TOKEN,
            ...(options.headers || {}),
        },
    });
    return res;
}

/** Trae el storageState (cookies + localStorage) guardado para una cuenta. */
export async function getSession(account) {
    const res = await call(`/session/${encodeURIComponent(account)}`);
    if (res.status === 404) {
        throw new Error(
            `No hay sesión guardada para la cuenta "${account}". ` +
            `Corre "node scripts/publish/login-and-export.js --account ${account} --platform <red>" en tu PC primero.`
        );
    }
    if (!res.ok) throw new Error(`Error al leer la sesión de "${account}": ${res.status}`);
    const data = await res.json();
    return data.state;
}

/** Guarda de vuelta el storageState (las plataformas rotan cookies al usarlas). */
export async function putSession(account, state) {
    const res = await call(`/session/${encodeURIComponent(account)}`, {
        method: 'PUT',
        body: JSON.stringify({ state }),
    });
    if (!res.ok) {
        console.warn(`No se pudo actualizar la sesión de "${account}" (${res.status}) — no es crítico, se reintentará la próxima vez.`);
    }
}

/** Reporta el resultado final de un job de publicación. */
export async function reportResult(jobId, result) {
    const res = await call('/publish-result', {
        method: 'POST',
        body: JSON.stringify({ job_id: jobId, ...result }),
    });
    if (!res.ok) {
        console.warn(`No se pudo reportar el resultado del job ${jobId} (${res.status})`);
    }
}
