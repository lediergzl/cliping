const DELAY_MIN_MS = 800;
const DELAY_MAX_MS = 2200;

/** Espera un tiempo "humano" aleatorio entre acciones dentro de un adapter. */
export function humanDelay() {
    const ms = DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Contrato que cada adapter de red social implementa.
 *
 * @typedef {Object} UploadMetadata
 * @property {string} filePath
 * @property {string} [caption]
 * @property {string[]} [hashtags]
 *
 * @typedef {Object} UploadResult
 * @property {boolean} success
 * @property {string} [url]
 */
export class BaseAdapter {
    static platform = 'base';

    /**
     * @param {import('playwright').Page} page
     * @param {UploadMetadata} metadata
     * @returns {Promise<UploadResult>}
     */
    async upload(_page, _metadata) {
        throw new Error('upload() no implementado');
    }
}
