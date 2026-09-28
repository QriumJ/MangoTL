import { runDetection } from "../detection-engines/index.js";
import { recognize, ocrEngineSupports } from "./engines/index.js";
import { normalizeOcrResult } from "./normalize.js";
import { recoverSupplementalText } from "./supplemental/index.js";

const LOG = "[MangoTL-OCR]";

/**
 * Runs the full OCR pipeline: detection (engine-agnostic) followed by
 * recognition and post-normalization. When the selected engine declares
 * `supplementalReads`, a best-effort recovery pass adds text the first pass
 * missed.
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
                    const probe = await recognize({ ...detection, boxes: probeBoxes }, options.targetLanguageProbe);
                    if (hasKoreanTargetText(probe, probeBoxes.length)) {
                        console.log(`${LOG} Image already contains Korean text; preserving original page`);
                        return { items: [], canvas: detection.canvas, width: detection.width, height: detection.height, alreadyTargetLanguage: true };
                    }
                }
            } catch (error) {
                console.warn(`${LOG} Target-language probe failed; continuing with the page: ${error.message}`);
            }
        }

        if (detection.boxes.length === 0 && !ocrEngineSupports(ocrEngineConfig.type, "supplementalReads")) {
            console.warn(`${LOG} No text regions detected`);
            return { items: [], canvas: detection.canvas, width: detection.width, height: detection.height };
        }

        const raw = await recognize(detection, ocrEngineConfig);
        const normalized = normalizeOcrResult(raw, detection, ocrEngineConfig);

        if (ocrEngineSupports(ocrEngineConfig.type, "supplementalReads")) {
            // Supplemental recovery is best-effort: a failed extra pass must
            // not take down text that was already recognized.
            try {
                await recoverSupplementalText(image, detection, raw, normalized, detectionEngineConfig, ocrEngineConfig, options);
            } catch (error) {
                console.warn(`${LOG} Supplemental recovery failed: ${error.message}`);
            }
        }

        console.log(`${LOG} Pipeline produced ${normalized.length} usable text items`);
        return { items: normalized, canvas: detection.canvas, width: detection.width, height: detection.height };
    } catch (error) {
        console.error(`${LOG} Pipeline failed:`, error.message);
        throw error;
    }
}

function hasKoreanTargetText(items, boxCount) {
    const strong = (items || []).filter((item) => {
        const hangul = String(item.text || "").match(/\p{Script=Hangul}/gu) || [];
        return hangul.length >= 2 && Number(item.confidence) >= 0.7;
    });
    const hangulCount = strong.reduce((total, item) => total + (String(item.text).match(/\p{Script=Hangul}/gu) || []).length, 0);
    return strong.length >= Math.max(3, Math.ceil(boxCount / 2)) && hangulCount >= 15;
}
