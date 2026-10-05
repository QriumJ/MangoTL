import { runDetection } from "../detection-engines/index.js";
import { recognize } from "./engines/index.js";
import { normalizeOcrResult } from "./normalize.js";

const LOG = "[MangoTL-OCR]";

/**
 * Runs the full OCR pipeline: detection (engine-agnostic) followed by
 * recognition and post-normalization.
 *
 * @returns {{ items: Array<{ id, text, confidence, coords }>, canvas, width: number, height: number }}
 */
export async function runOcr(image, detectionEngineConfig, ocrEngineConfig, options = {}) {
    console.log(`${LOG} Pipeline start — detection: ${detectionEngineConfig.type}, recognition: ${ocrEngineConfig.type}`);

    try {
        const detection = await runDetection(image, detectionEngineConfig);
        console.log(`${LOG} Detection produced ${detection.boxes.length} boxes`);

        if (options.targetLanguageProbe && detection.boxes.length > 0) {
            try {
                const probeBoxes = [...detection.boxes]
                    .filter((box) => box.width * box.height >= 1000)
                    .sort((a, b) => b.width * b.height - a.width * a.height)
                    .slice(0, 8);
                if (probeBoxes.length > 0) {
                    const probe = await recognize({ ...detection, boxes: probeBoxes }, options.targetLanguageProbe.engine);
                    if (options.targetLanguageProbe.hasTargetScript(probe, probeBoxes.length)) {
                        console.log(`${LOG} Image already contains ${options.targetLanguageProbe.language} text; preserving original page`);
                        return { items: [], canvas: detection.canvas, width: detection.width, height: detection.height, alreadyTargetLanguage: true };
                    }
                }
            } catch (error) {
                console.warn(`${LOG} Target-language probe failed; continuing with the page: ${error.message}`);
            }
        }

        if (detection.boxes.length === 0) {
            console.warn(`${LOG} No text regions detected`);
            return { items: [], canvas: detection.canvas, width: detection.width, height: detection.height };
        }

        const raw = await recognize(detection, ocrEngineConfig);
        const normalized = normalizeOcrResult(raw, detection, ocrEngineConfig, { sourceLanguage: options.sourceLanguage });

        console.log(`${LOG} Pipeline produced ${normalized.length} usable text items`);
        return { items: normalized, canvas: detection.canvas, width: detection.width, height: detection.height };
    } catch (error) {
        console.error(`${LOG} Pipeline failed:`, error.message);
        throw error;
    }
}

/**
 * 목표 언어별 "이미 번역된 페이지" 판정기.
 * 원문 삽화와 구별 가능한 고유 스크립트가 있는 언어만 등록한다
 * (라틴계 언어는 만화 효과음에도 흔해 오탐 위험이 있다).
 */
const TARGET_LANGUAGE_CHECKS = {
    ko: (items, boxCount) => {
        const strong = (items || []).filter((item) => {
            const hangul = String(item.text || "").match(/\p{Script=Hangul}/gu) || [];
            return hangul.length >= 2 && Number(item.confidence) >= 0.7;
        });
        const hangulCount = strong.reduce((total, item) => total + (String(item.text).match(/\p{Script=Hangul}/gu) || []).length, 0);
        return strong.length >= Math.max(3, Math.ceil(boxCount / 2)) && hangulCount >= 15;
    },
};

/**
 * 목표 언어에 신뢰할 수 있는 판정 스크립트가 있으면 프로브 디스크립터를 반환한다.
 * 없으면 null — 프로브 자체를 건너뛴다.
 */
export function targetLanguageProbeDescriptor(targetLanguage, engine) {
    const check = TARGET_LANGUAGE_CHECKS[targetLanguage];
    if (!check || !engine) {
        return null;
    }
    return { language: targetLanguage, engine, hasTargetScript: check };
}
