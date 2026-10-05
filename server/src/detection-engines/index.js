import { createCanvas, loadImage } from "ppu-ocv/canvas";
import { HttpError } from "../utils/http-error.js";

const LOG = "[MangoTL-Detection]";

/**
 * 탐지 엔진 type → 구현 로더 레지스트리. 지연 로딩이라 선택되지 않은
 * 엔진의 모듈(ONNX 포함)은 로드되지 않는다.
 * 새 엔진 추가 = 구현 모듈 + 여기 한 줄 + config/detection-engines/*.json.
 */
const DETECTORS = {
    paddle: async () => (await import("./paddle.js")).detectWithPaddle,
};

/**
 * Detects text regions in an image. Detection is engine-agnostic and shared
 * by every OCR recognition engine.
 *
 * @returns {{ canvas, boxes: Array<{x,y,width,height}>, width: number, height: number }}
 */
export async function runDetection(image, detectionEngineConfig) {
    console.log(`${LOG} Running detection with engine: ${detectionEngineConfig.id} (type: ${detectionEngineConfig.type})`);

    const load = DETECTORS[detectionEngineConfig.type];
    if (!load) {
        throw new HttpError(400, "detection_engine_not_supported", `Unsupported detection engine: ${detectionEngineConfig.type}`);
    }

    const canvas = await prepareCanvas(image);
    const detect = await load();
    const boxes = await detect(canvas, detectionEngineConfig);

    return { canvas, boxes, width: canvas.width, height: canvas.height };
}

async function prepareCanvas(image) {
    if (!image?.buffer) {
        throw new HttpError(400, "invalid_image", "Image buffer is missing for detection.");
    }

    const decoded = await loadImage(image.buffer);
    const canvas = createCanvas(decoded.width, decoded.height);
    const context = canvas.getContext("2d");
    // OCR models expect an opaque page; transparent PNG pixels are not black ink.
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded, 0, 0);
    return canvas;
}
