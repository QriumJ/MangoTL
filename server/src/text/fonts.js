import { GlobalFonts } from "@napi-rs/canvas";
import { fetchAndCacheModel } from "../utils/model-cache.js";

const LOG = "[MangoTL-Font]";

/**
 * The canvas backend ships no fonts of its own, so a deployment without system
 * fonts (e.g. the slim Docker image) would render nothing. A CJK font covering
 * every supported target language is downloaded once into the shared OCR cache
 * and registered under a fixed family alias the renderer can rely on.
 */
export const RENDER_FONT_FAMILY = "MangoTL Sans";

const FONT_SOURCES = [
    {
        url: "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf",
        fileName: "font-NotoSansCJKkr-Regular.otf",
    },
    {
        url: "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Korean/NotoSansCJKkr-Bold.otf",
        fileName: "font-NotoSansCJKkr-Bold.otf",
    },
];

let registrationPromise = null;

/**
 * Downloads and registers the bundled render font once per process. Safe to
 * await on every translation — resolves immediately after the first success.
 * Never throws: without the bundled font the renderer falls back to whatever
 * system fonts exist (correct on macOS, possibly missing elsewhere).
 */
export function ensureRenderFonts() {
    if (!registrationPromise) {
        registrationPromise = registerFonts().catch((error) => {
            registrationPromise = null;
            console.warn(`${LOG} Failed to register bundled font, falling back to system fonts:`, error.message);
        });
    }

    return registrationPromise;
}

async function registerFonts() {
    if (GlobalFonts.has(RENDER_FONT_FAMILY)) {
        return;
    }

    for (const source of FONT_SOURCES) {
        const buffer = await fetchAndCacheModel(source.url, source.fileName, LOG);

        if (!GlobalFonts.register(buffer, RENDER_FONT_FAMILY)) {
            throw new Error(`GlobalFonts rejected font file: ${source.fileName}`);
        }
    }

    console.log(`${LOG} Registered render font "${RENDER_FONT_FAMILY}" (${FONT_SOURCES.length} weights)`);
}
