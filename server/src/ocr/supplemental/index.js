import { createCanvas } from "ppu-ocv/canvas";
import { runDetection } from "../../detection-engines/index.js";
import { recognize } from "../engines/index.js";
import { normalizeOcrResult } from "../normalize.js";
import { findUnrecognizedPastelBadges, matchingPastelBadgeRead } from "./pastel-badges.js";
import { findOutlinedEffectCandidates, makeOutlinedEffectRecognitionCrop, normalizeOutlinedEffect } from "./outlined.js";
import {
    findInsetHandwrittenCandidates,
    findRepeatedFootstepCandidates,
    findSupplementalRepeatedEffects,
    findSplitRepeatedEffects,
    findSupplementalSmallEffects,
    findSupplementalTinyLabels,
    findSupplementalVerticalFragments,
    matchRepeatedEffect,
    matchingInsetHandwrittenText,
    normalizeHandwrittenEffect,
} from "./fragments.js";

const LOG = "[MangoTL-OCR]";

/**
 * Reads handwritten effects, split glyphs, and labels the standard detector
 * pass missed. Only text that was actually recognized is added — candidates
 * are proposed geometrically, then confirmed by a real recognizer read.
 *
 * Crop reads go through the registered recognition engine, so this stage works
 * with any engine that declares `supplementalReads` support.
 */
export async function recoverSupplementalText(image, detection, raw, normalized, detectionEngineConfig, ocrEngineConfig, options) {
    const readCrops = (boxes) => recognize({ ...detection, boxes }, ocrEngineConfig, { supplementalOnly: true });

    for (const [index, candidate] of findRepeatedFootstepCandidates(raw, normalized).entries()) {
        normalized.push({
            id: `ocr-footstep-${index + 1}`,
            text: candidate.text,
            confidence: candidate.confidence,
            coords: candidate.box,
            eraseCoords: candidate.box,
            standalone: true,
            footstepEffect: true,
        });
    }

    const insetCandidates = findInsetHandwrittenCandidates(raw, normalized);
    for (const [index, candidate] of insetCandidates.entries()) {
        const reads = await readCrops(candidate.crops);
        const match = matchingInsetHandwrittenText(reads);
        if (!match) continue;
        normalized.push({
            id: `ocr-inset-${index + 1}`,
            text: match.text,
            confidence: match.confidence,
            coords: candidate.crops[0],
            eraseCoords: {
                ...candidate.crops[0],
                height: Math.min(candidate.box.y + candidate.box.height - candidate.crops[0].y, candidate.crops[0].height + 18),
            },
            standalone: true,
            insetHandwritten: true,
        });
        console.log(`${LOG} Recovered inset handwritten text: "${match.text}"`);
    }

    const highResolution = await runDetection(image, {
        ...detectionEngineConfig,
        options: { ...detectionEngineConfig.options, maxSideLength: 2048 },
    });

    const fragmentCandidates = findSupplementalVerticalFragments(
        detection.boxes,
        highResolution.boxes,
        normalized,
        detection.width,
        detection.height,
    );
    if (fragmentCandidates.length > 0) {
        const extraRaw = await readCrops(fragmentCandidates);
        const extra = normalizeOcrResult(
            extraRaw.map((item) => ({ ...item, text: normalizeHandwrittenEffect(item.text) })),
            detection,
            ocrEngineConfig,
        ).filter((item) => {
            const kana = String(item.text).match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
            return item.confidence >= 0.95 && kana.length >= 2 && !/(.)\1{6,}/u.test(item.text);
        });
        normalized.push(...extra.map((item, index) => ({ ...item, id: `ocr-fragment-${index + 1}` })));
        if (extra.length > 0) {
            console.log(`${LOG} Recovered ${extra.length} handwritten text fragment(s) at higher detection resolution`);
        }
    }

    const repeatedCandidates = [
        ...findSupplementalRepeatedEffects(detection.boxes, highResolution.boxes, normalized, detection.width, detection.height),
        ...findSplitRepeatedEffects(detection.boxes, normalized, detection.width, detection.height),
    ];
    if (repeatedCandidates.length > 0) {
        const repeatedRaw = await readCrops(repeatedCandidates.map((candidate) => candidate.box));
        for (const [index, rawItem] of repeatedRaw.entries()) {
            if (rawItem.confidence < 0.78) continue;
            const match = matchRepeatedEffect(rawItem.text, repeatedCandidates[index].nearby);
            if (!match) continue;
            normalized.push({
                id: `ocr-repeated-${index + 1}`,
                text: match.text,
                confidence: rawItem.confidence,
                coords: repeatedCandidates[index].renderBox,
                eraseCoords: repeatedCandidates[index].renderBox,
                standalone: true,
                confirmedRepeatedEffect: true,
            });
            console.log(`${LOG} Recovered repeated handwritten effect: "${match.text}"`);
        }
    }

    const smallCandidates = findSupplementalSmallEffects(detection.boxes, highResolution.boxes, normalized, detection.width, detection.height);
    if (smallCandidates.length > 0) {
        const smallRaw = await readCrops(smallCandidates);
        const small = normalizeOcrResult(smallRaw, detection, ocrEngineConfig).filter((item) => {
            const kana = String(item.text).match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
            return item.confidence >= 0.93 && kana.length >= 2 && item.text.length <= 5;
        });
        normalized.push(...small.map((item, index) => ({ ...item, id: `ocr-small-${index + 1}`, standalone: true })));
        if (small.length > 0) {
            console.log(`${LOG} Recovered ${small.length} short handwritten effect(s) at higher detection resolution`);
        }
    }

    const tinyCandidates = findSupplementalTinyLabels(detection.boxes, highResolution.boxes, normalized, detection.width, detection.height);
    if (tinyCandidates.length > 0) {
        const tinyRaw = await readCrops(tinyCandidates.map((candidate) => candidate.box));
        const tiny = normalizeOcrResult(tinyRaw, detection, ocrEngineConfig).filter((item) => {
            const kana = String(item.text).match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
            const longVowel = /^[\p{Script=Hiragana}\p{Script=Katakana}]{1,3}ー$/u.test(String(item.text));
            return item.confidence >= 0.82 && ((kana.length >= 2 && kana.length <= 5 && item.text.length <= 6) || longVowel);
        });
        normalized.push(
            ...tiny.map((item, index) => {
                const withId = { ...item, id: `ocr-tiny-${index + 1}` };
                const candidate = tinyCandidates.find((entry) => entry.box.x === item.coords.x && entry.box.y === item.coords.y);
                if (/^[\p{Script=Hiragana}\p{Script=Katakana}]{1,3}ー$/u.test(item.text) && candidate?.textBox) {
                    const textBox = candidate.textBox;
                    const coords = {
                        x: Math.max(0, textBox.x - Math.round(textBox.width * 0.15)),
                        y: Math.max(0, textBox.y - Math.round(textBox.height * 0.5)),
                        width: textBox.width + Math.round(textBox.width * 0.35),
                        height: textBox.height + Math.round(textBox.height * 0.78),
                    };
                    return {
                        ...withId,
                        coords,
                        eraseCoords: {
                            ...coords,
                            height: Math.min(detection.height - coords.y, coords.height + Math.round(coords.height * 0.9)),
                        },
                        standalone: true,
                    };
                }
                return { ...withId, eraseCoords: candidate?.textBox || item.coords, standalone: true, tinyLabel: true };
            }),
        );
        if (tiny.length > 0) {
            console.log(`${LOG} Recovered ${tiny.length} tiny label(s) at higher detection resolution`);
        }
    }

    if (options.sourceLanguageProbe) {
        const badges = findUnrecognizedPastelBadges(detection.canvas, normalized);
        for (const [index, badge] of badges.entries()) {
            const reads = await recognize({ ...detection, boxes: badge.crops }, options.sourceLanguageProbe);
            const text = matchingPastelBadgeRead(reads, badge.knownNames);
            if (!text) continue;
            const crop = badge.crops[1];
            normalized.push({
                id: `ocr-pastel-badge-${index + 1}`,
                text,
                confidence: Math.min(reads[0].confidence, reads[1].confidence),
                coords: { x: crop.x - 6, y: crop.y, width: crop.width + 12, height: crop.height + 12 },
                eraseCoords: { x: crop.x - 5, y: crop.y + 10, width: crop.width + 10, height: crop.height + 20 },
                standalone: true,
                tinyLabel: true,
                pastelBadge: true,
            });
            console.log(`${LOG} Recovered one-character pastel badge label: "${text}"`);
        }
    }

    const outlinedCandidates = findOutlinedEffectCandidates(detection.canvas, normalized);
    const outlinedReads = [];
    // 후보 크롭을 하나의 세로 스트립으로 붙여 단일 recognize 호출로 묶는다.
    // 엔진 내부의 배치 인식이 그대로 적용되고 결과는 박스와 1:1로 대응한다.
    if (outlinedCandidates.length > 0) {
        const strip = createCanvas(650, 650 * outlinedCandidates.length);
        const stripCtx = strip.getContext("2d");
        stripCtx.fillStyle = "#ffffff";
        stripCtx.fillRect(0, 0, strip.width, strip.height);
        for (const [index, box] of outlinedCandidates.entries()) {
            const crop = makeOutlinedEffectRecognitionCrop(detection.canvas, box, box.kind === "large" ? 20 : 25);
            stripCtx.drawImage(crop, 0, 650 * index);
        }
        const stripReads = await recognize(
            {
                canvas: strip,
                boxes: outlinedCandidates.map((_, index) => ({ x: 0, y: 650 * index, width: 650, height: 650 })),
            },
            ocrEngineConfig,
            { supplementalOnly: true },
        );
        for (const [index, box] of outlinedCandidates.entries()) {
            const read = stripReads[index];
            if (!read || read.confidence < (box.kind === "large" ? 0.82 : 0.9)) continue;
            const text = normalizeOutlinedEffect(read.text);
            if (!text) continue;
            outlinedReads.push({ box, text, confidence: read.confidence });
        }
    }
    const acceptedOutlined = outlinedReads.filter(
        (read) => read.box.kind === "large" || outlinedReads.some((other) => other !== read && other.text === read.text),
    );
    normalized.push(
        ...acceptedOutlined.map((read, index) => ({
            id: `ocr-outlined-${index + 1}`,
            text: read.text,
            confidence: read.confidence,
            coords: read.box,
            eraseCoords: read.box,
            standalone: true,
            outlinedEffect: true,
            largeOutlinedEffect: read.box.kind === "large",
        })),
    );
    if (acceptedOutlined.length > 0) {
        console.log(`${LOG} Recovered ${acceptedOutlined.length} outlined sound effect(s)`);
    }
}
