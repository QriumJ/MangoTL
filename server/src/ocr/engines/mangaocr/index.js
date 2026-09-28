import { LOG, getModel, recognizeRegion, recognizeRegionsBatch, cropRegion } from "./session.js";
import { getRecognitionBoxes, findInteriorTextBox, findInkColumns } from "./text-boxes.js";
import {
    trimOverlappingSpeechTails,
    repairAdjacentSpeechBubbles,
    isLowInkArtworkHallucination,
    repairOverlappingVerticalColumns,
    overlapsStrongRead,
    isNearIdenticalText,
} from "./postprocess.js";
import { detectDarkTextRegions } from "./dark-regions.js";

export async function recognizeWithMangaOcr(detection, ocrEngineConfig, options = {}) {
    const model = await getModel(ocrEngineConfig);
    const boxes = options.supplementalOnly ? detection.boxes : getRecognitionBoxes(detection);

    console.log(`${LOG} Recognizing ${boxes.length} regions...`);
    const start = Date.now();
    const results = [];

    // 1차 인식은 전체 박스를 배치로 돌려 박스당 인코더/디코더 왕복을 없앤다.
    // 아래 복구 패스(소수 박스만)는 기존처럼 단건 읽기를 사용한다.
    const crops = boxes.map((box) => cropRegion(detection.canvas, box, model.imageSize));
    const initials = await recognizeRegionsBatch(crops, model);

    for (let index = 0; index < boxes.length; index += 1) {
        let box = boxes[index];
        let { text, confidence } = initials[index];
        console.log(`${LOG} Box ${index + 1}/${boxes.length}: "${text}" (confidence ${confidence.toFixed(3)})`);

        // Supplemental crop reads must stay 1:1 with the requested boxes so
        // callers can pair each result with the candidate they sent. The
        // box-rewriting recovery passes below run on the main pass only.
        if (!options.supplementalOnly) {
            if (confidence >= 0.7 && confidence < 0.85 && /[?？]$/u.test(text) && box.width >= 150 && box.height >= 200) {
                const letters = (value) => [...value].filter((character) => /\p{L}/u.test(character)).join("");
                const oldLetters = letters(text);
                if (oldLetters.length >= 3 && oldLetters.length <= 4) {
                    const trim = Math.round(box.height * 0.19);
                    const lowerBox = { ...box, y: box.y + trim, height: box.height - trim };
                    const lower = await recognizeRegion(cropRegion(detection.canvas, lowerBox, model.imageSize), model);
                    if (
                        lower.confidence >= Math.max(0.92, confidence + 0.12) &&
                        /[?？]$/u.test(lower.text) &&
                        oldLetters.endsWith(letters(lower.text)) &&
                        letters(lower.text).length === oldLetters.length - 1
                    ) {
                        console.log(`${LOG} Removed stray mark above question: "${lower.text}" (${lower.confidence.toFixed(3)})`);
                        text = lower.text;
                        confidence = lower.confidence;
                        box = lowerBox;
                    }
                }
            }

            if (confidence >= 0.65 && confidence < 0.82 && box.width >= 80 && box.width <= 160 && box.height >= 35 && box.height <= 100) {
                const oldKana = [...text].filter((character) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character));
                if (oldKana.length >= 2 && oldKana.length <= 3) {
                    const expandedBox = {
                        x: Math.max(0, Math.round(box.x - box.width * 0.65)),
                        y: Math.max(0, Math.round(box.y - box.height * 1.05)),
                        width: Math.round(box.width * 2.3),
                        height: Math.round(box.height * 3.3),
                    };
                    const expanded = await recognizeRegion(cropRegion(detection.canvas, expandedBox, model.imageSize), model);
                    const newKana = [...expanded.text].filter((character) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character));
                    if (
                        expanded.confidence >= 0.97 &&
                        newKana.length > oldKana.length &&
                        newKana.at(-1) === oldKana.at(-1) &&
                        /[.。…]/u.test(expanded.text) &&
                        !overlapsStrongRead(results, expandedBox, expanded)
                    ) {
                        console.log(`${LOG} Recovered handwritten effect: "${expanded.text}" (${expanded.confidence.toFixed(3)})`);
                        text = expanded.text;
                        confidence = expanded.confidence;
                        box = expandedBox;
                    }
                }
            }

            if (/\p{L}$/u.test(text) && box.width >= 300 && box.height >= 500 && box.y + box.height < detection.canvas.height - 40) {
                const extendedBox = { ...box, height: Math.min(detection.canvas.height - box.y, Math.round(box.height * 1.14)) };
                const extended = await recognizeRegion(cropRegion(detection.canvas, extendedBox, model.imageSize), model);
                const letters = (value) => [...value].filter((character) => /\p{L}|\p{N}/u.test(character)).join("");
                if (
                    /[?？!！]$/u.test(extended.text) &&
                    extended.confidence >= Math.max(0.97, confidence - 0.015) &&
                    letters(extended.text) === letters(text)
                ) {
                    console.log(`${LOG} Recovered clipped punctuation: "${extended.text}" (${extended.confidence.toFixed(3)})`);
                    text = extended.text;
                    confidence = extended.confidence;
                    box = extendedBox;
                }
            }

            if (confidence >= 0.9 && confidence < 0.995 && box.width >= 250 && box.height >= 350) {
                const insetX = Math.round(box.width * 0.045);
                const insetY = Math.round(box.height * 0.035);
                const inset = {
                    x: box.x + insetX,
                    y: box.y + insetY,
                    width: box.width - insetX * 2,
                    height: box.height - insetY * 2,
                };
                const closer = await recognizeRegion(cropRegion(detection.canvas, inset, model.imageSize), model);
                if (closer.confidence >= Math.max(0.995, confidence + 0.008) && isNearIdenticalText(text, closer.text)) {
                    console.log(`${LOG} More reliable inset read: "${closer.text}" (${closer.confidence.toFixed(3)})`);
                    text = closer.text;
                    confidence = closer.confidence;
                }
            }

            if (/[。.]$/u.test(text) && confidence < 0.99 && box.width >= 250 && box.height >= 350) {
                const paddingX = Math.round(box.width * 0.07);
                const paddingY = Math.round(box.height * 0.05);
                const expanded = {
                    x: Math.max(0, box.x - paddingX),
                    y: Math.max(0, box.y - paddingY),
                    width: box.width + paddingX * 2,
                    height: box.height + paddingY * 2,
                };
                const clearerEnding = await recognizeRegion(cropRegion(detection.canvas, expanded, model.imageSize), model);
                const letters = (value) => [...value].filter((character) => /\p{L}|\p{N}/u.test(character)).join("");
                if (
                    /[?？]$/u.test(clearerEnding.text) &&
                    clearerEnding.confidence >= Math.max(0.995, confidence + 0.01) &&
                    letters(clearerEnding.text) === letters(text)
                ) {
                    const leading = text.match(/^[.。…・]+/u)?.[0] || "";
                    text = `${leading}${clearerEnding.text.replace(/^[.。…・]+/u, "")}`;
                    confidence = clearerEnding.confidence;
                    console.log(`${LOG} Corrected question ending: "${text}" (${confidence.toFixed(3)})`);
                }
            }

            if ((confidence < 0.9 || (confidence < 0.95 && box.width >= 500 && box.height >= 600)) && box.width >= 250 && box.height >= 350) {
                const refinedBox = findInteriorTextBox(detection.canvas, box);
                if (refinedBox) {
                    let refined = await recognizeRegion(cropRegion(detection.canvas, refinedBox, model.imageSize), model);
                    let chosenBox = refinedBox;
                    if (refined.confidence < 0.94 && refinedBox.height >= 300) {
                        const trim = Math.round(refinedBox.height * 0.16);
                        const trimmedBox = { ...refinedBox, y: refinedBox.y + trim, height: refinedBox.height - trim };
                        const trimmed = await recognizeRegion(cropRegion(detection.canvas, trimmedBox, model.imageSize), model);
                        if (process.env.MANGOTL_OCR_DEBUG) {
                            console.log(
                                `${LOG} Trimmed candidate: "${trimmed.text}" (${trimmed.confidence.toFixed(3)}) ${JSON.stringify(trimmedBox)}`,
                            );
                        }
                        if (
                            trimmed.confidence > refined.confidence + 0.03 &&
                            [...trimmed.text].filter((character) => /\p{L}/u.test(character)).length >= 3
                        ) {
                            refined = trimmed;
                            chosenBox = trimmedBox;
                        }
                    }
                    if (process.env.MANGOTL_OCR_DEBUG) {
                        console.log(`${LOG} Interior candidate: "${refined.text}" (${refined.confidence.toFixed(3)}) ${JSON.stringify(refinedBox)}`);
                    }
                    if (
                        refined.confidence >= Math.max(0.8, confidence + (box.width >= 500 ? 0.04 : 0.08)) &&
                        [...refined.text].filter((character) => /\p{L}/u.test(character)).length >= 3 &&
                        !/(.)\1{10,}/u.test(refined.text) &&
                        !(
                            confidence >= 0.9 &&
                            Math.abs(
                                [...refined.text].filter((character) => /\p{L}/u.test(character)).length -
                                    [...text].filter((character) => /\p{L}/u.test(character)).length,
                            ) <= 2
                        ) &&
                        !overlapsStrongRead(results, chosenBox, refined)
                    ) {
                        results.push({ ...refined, box: chosenBox });
                        continue;
                    }
                }
            }

            if (box.width >= 500 && box.height >= 600 && box.width / box.height >= 0.55) {
                const columns = findInkColumns(detection.canvas, box);
                const reads = [];
                for (const column of columns) {
                    reads.push({ ...(await recognizeRegion(cropRegion(detection.canvas, column, model.imageSize), model)), box: column });
                }

                if (process.env.MANGOTL_OCR_DEBUG) {
                    console.log(`${LOG} Split candidates: ${reads.map((read) => `"${read.text}" (${read.confidence.toFixed(3)})`).join(" | ")}`);
                }

                const combinedLength = reads.reduce(
                    (total, read) => total + [...read.text].filter((character) => /\p{L}/u.test(character)).length,
                    0,
                );
                const parentLength = [...text].filter((character) => /\p{L}/u.test(character)).length;
                if (
                    reads.length >= 2 &&
                    reads.every((read) => read.confidence >= 0.8 && [...read.text].filter((character) => /\p{L}/u.test(character)).length >= 4) &&
                    (combinedLength >= parentLength * 0.7 || confidence < 0.8)
                ) {
                    console.log(`${LOG} Split wide vertical box into ${reads.length} readable columns`);
                    results.push(...reads.map(({ text, confidence, box }) => ({ text, confidence, box })));
                    continue;
                }
            }
        }

        results.push({ text, box, confidence });
    }

    if (!options.supplementalOnly) {
        await repairOverlappingVerticalColumns(results, detection.canvas, model);
        await repairAdjacentSpeechBubbles(results, detection.canvas, model);
        trimOverlappingSpeechTails(results);
    }

    // 감지된 다크 레터링 영역도 한 번의 배치 패스로 읽는다
    const darkRegions = options.supplementalOnly ? [] : detectDarkTextRegions(detection.canvas);
    const darkReads = await recognizeRegionsBatch(
        darkRegions.map((region) =>
            cropRegion(region.canvas, { x: 0, y: 0, width: region.canvas.width, height: region.canvas.height }, model.imageSize),
        ),
        model,
    );

    for (let index = 0; index < darkRegions.length; index += 1) {
        const region = darkRegions[index];
        const raw = darkReads[index];
        if (process.env.MANGOTL_OCR_DEBUG) {
            console.log(`${LOG} Enclosed lettering candidate: "${raw.text}" (${raw.confidence.toFixed(3)}) ${JSON.stringify(region.glyphBox)}`);
        }
        const kana = [...raw.text].filter((character) => /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(character)).join("");
        const text = raw.confidence >= 0.75 ? raw.text : /^([\p{Script=Hiragana}\p{Script=Katakana}])ー?\1ー?$/u.test(kana) ? kana : "";
        if (
            !text ||
            raw.confidence < 0.65 ||
            [...text].filter((character) => /\p{L}/u.test(character)).length < 2 ||
            overlapsStrongRead(results, region.glyphBox, raw)
        ) {
            continue;
        }
        console.log(`${LOG} Dark lettering: "${text}" (confidence ${raw.confidence.toFixed(3)})`);
        results.push({ text, confidence: Math.max(raw.confidence, 0.76), box: region.glyphBox, darkBox: region.darkBox });
    }

    const cleanResults = results.filter((result) => !isLowInkArtworkHallucination(result, detection.canvas));
    if (process.env.MANGOTL_OCR_DEBUG) {
        console.log(`${LOG} Raw results: ${JSON.stringify(cleanResults.map(({ text, confidence, box }) => ({ text, confidence, box })))}`);
    }
    console.log(`${LOG} Completed ${boxes.length} regions in ${Date.now() - start}ms`);

    return cleanResults;
}
