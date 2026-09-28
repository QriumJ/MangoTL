import { HttpError } from "../../utils/http-error.js";

const LOG = "[MangoTL-OCR]";

/**
 * OCR 인식 엔진 type → 구현 로더 레지스트리. 지연 로딩이라 선택되지 않은
 * 엔진의 모듈(ONNX 세션 포함)은 로드되지 않는다.
 *
 * 새 엔진 추가 = 구현 모듈 + 여기 한 줄 + config/ocr-engines/*.json.
 * capabilities에 `supplementalReads`를 선언하면 보조 크롭 읽기가 활성화된다.
 */
const ENGINES = {
    paddle: { load: async () => (await import("./paddle.js")).recognizeWithPaddle },
    mangaocr: { load: async () => (await import("./mangaocr/index.js")).recognizeWithMangaOcr, supplementalReads: true },
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

    const run = await engine.load();
    return run(detection, ocrEngineConfig, options);
}
