import * as ort from "onnxruntime-node";
import { DetectionService } from "@snowfluke/ppu-paddle-ocr";
import { fetchAndCacheModelPath } from "../utils/model-cache.js";
import { ortSessionOptions } from "../utils/ort-options.js";
import { HttpError } from "../utils/http-error.js";

const LOG = "[MangoTL-Detection-Paddle]";

const detectorPromises = new Map();

/**
 * Runs PaddleOCR text-region detection on a prepared canvas.
 * Returns an array of { x, y, width, height } boxes in source-image coordinates.
 */
export async function detectWithPaddle(canvas, detectionEngineConfig) {
    const detector = await getDetector(detectionEngineConfig);

    const start = Date.now();
    const boxes = normalizeBoxes(await detector.run(canvas));
    console.log(`${LOG} Detected ${boxes.length} text regions in ${Date.now() - start}ms`);

    return boxes;
}

async function getDetector(config) {
    const cacheKey = getDetectorCacheKey(config);
    const cached = detectorPromises.get(cacheKey);

    if (cached) {
        return cached;
    }

    const detectorPromise = (async () => {
        const modelUrl = config.model?.detection;
        if (!modelUrl) {
            throw new HttpError(500, "detection_config_invalid", "Detection model URL is missing in detection engine config.");
        }

        console.log(`${LOG} Initializing PaddleOCR detection...`);
        // 경로로 생성해야 가중치가 mmap로 올라가 세션 메모리가 크게 줄어든다
        const modelPath = await fetchAndCacheModelPath(modelUrl, `paddle-det-${basename(modelUrl)}`, LOG);

        const session = await ort.InferenceSession.create(modelPath, ortSessionOptions());
        console.log(`${LOG} Detection session ready (input: ${session.inputNames}, output: ${session.outputNames})`);

        const engine = config.processing?.engine || "canvas-native";
        return new DetectionService(session, config.options || {}, config.debugging || {}, engine);
    })();

    detectorPromises.set(cacheKey, detectorPromise);
    detectorPromise.catch(() => detectorPromises.delete(cacheKey));

    return detectorPromise;
}

function getDetectorCacheKey(config) {
    return JSON.stringify({
        model: config.model?.detection || null,
        options: config.options || {},
        debugging: config.debugging || {},
        engine: config.processing?.engine || "canvas-native",
    });
}

function normalizeBoxes(boxes) {
    if (!Array.isArray(boxes)) {
        return [];
    }

    return boxes
        .map((box) => ({
            x: Number(box?.x),
            y: Number(box?.y),
            width: Number(box?.width),
            height: Number(box?.height),
        }))
        .filter((box) => [box.x, box.y, box.width, box.height].every(Number.isFinite))
        .filter((box) => box.width > 0 && box.height > 0);
}

function basename(url) {
    try {
        return new URL(url).pathname.split("/").pop() || "model";
    } catch {
        return "model";
    }
}
