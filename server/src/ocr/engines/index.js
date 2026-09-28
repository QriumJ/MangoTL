import { recognizeWithPaddle } from "./paddle.js";
import { recognizeWithMangaOcr } from "./mangaocr/index.js";
import { HttpError } from "../../utils/http-error.js";

const LOG = "[MangoTL-OCR]";

/**
 * Registered OCR recognition engines.
 * Engine selection is resolved in the pipeline from language routing config
 * and each engine's declared language support.
 *
 * Adding an engine = drop in an implementation module, add one entry here,
 * and add a config JSON. No pipeline code changes needed.
 */
const ENGINES = {
    paddle: { recognize: recognizeWithPaddle },
    mangaocr: { recognize: recognizeWithMangaOcr, supplementalReads: true },
};

/**
 * Declared engine capabilities. `supplementalReads` means the engine can
 * re-recognize arbitrary crop boxes produced by candidate finders.
 */
export function ocrEngineSupports(type, capability) {
    return Boolean(ENGINES[type]?.[capability]);
}

/**
 * Runs the recognition stage for an already-detected image.
 * @param detection result of runDetection: { canvas, boxes, width, height }
 * @param options forwarded to the engine (e.g. { supplementalOnly: true }
 *        for raw crop reads that must not rewrite the requested boxes)
 */
export async function recognize(detection, ocrEngineConfig, options = {}) {
    console.log(`${LOG} Recognizing with engine: ${ocrEngineConfig.id} (type: ${ocrEngineConfig.type})`);

    const engine = ENGINES[ocrEngineConfig.type];
    if (!engine) {
        throw new HttpError(400, "ocr_engine_not_supported", `Unsupported OCR engine: ${ocrEngineConfig.type}`);
    }

    return engine.recognize(detection, ocrEngineConfig, options);
}
