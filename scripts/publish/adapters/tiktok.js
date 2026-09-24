import { BaseAdapter, humanDelay } from './base.js';

// Mismas salvedades que antes: TikTok cambia su interfaz con frecuencia.
// Selectores basados en roles/atributos accesibles; verificar en vivo la
// primera vez (ver "Probar el adapter" en el README) y cada tanto después.
// Si falla, el workflow sube screenshot + HTML como artifact del run.

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=upload';

export class TikTokAdapter extends BaseAdapter {
    static platform = 'tiktok';

    async upload(page, { filePath, caption = '', hashtags = [] }) {
        await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
        await humanDelay();

        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout: 30_000 });
        await fileInput.setInputFiles(filePath);

        const captionBox = page.locator('[contenteditable="true"]').first();
        await captionBox.waitFor({ state: 'visible', timeout: 120_000 });
        await humanDelay();

        await captionBox.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

        const fullCaption = [caption, ...hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`))]
            .filter(Boolean)
            .join(' ');
        await page.keyboard.type(fullCaption, { delay: 30 });
        await humanDelay();

        const postButton = page.getByRole('button', { name: /^(post|publicar)$/i }).first();
        await postButton.waitFor({ state: 'visible', timeout: 30_000 });
        await postButton.click();

        await page.waitForURL(/tiktokstudio\/content|\/upload\/success/i, { timeout: 60_000 }).catch(() => {});
        await humanDelay();

        return { success: true, url: page.url() };
    }
}
