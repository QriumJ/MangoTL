import { runOcr } from "../ocr/index.js";
import { mergeTranslations, prepareBlocks } from "./blocks.js";
import { resolveDetectionEngine, resolveOcrEngine, resolveProvider, resolveTargetLanguageProbe } from "./resolve.js";
import { inpaintImage } from "../text/inpaint/index.js";
import { captureAdjacentPunctuation, restoreAdjacentPunctuation } from "../text/inpaint/preserve-punctuation.js";
import { renderImage } from "../text/render/index.js";
import { isUntranslatedText, translateBlocks } from "../translation/index.js";
import { encodeImage } from "../utils/encode-image.js";
import { createImageResultCacheKey, readCachedImageResult, writeCachedImageResult } from "../utils/image-result-cache.js";
import { createHash } from "node:crypto";

/**
 * 이미지 번역 파이프라인 오케스트레이터.
 * 각 스테이지는 레지스트리를 통해 구현이 선택되므로 이 파일에는
 * 탐지/OCR/번역/인페인트/렌더의 구체 엔진이 직접 나타나지 않는다.
 *
 * 스테이지: 캐시 → 엔진 해석 → OCR → 블록 정제 → 번역 → 인페인트 → 렌더 → 인코딩
 */
export async function translateImage(request, config, options = {}) {
    const provider = request.dryRun ? null : resolveProvider(config);
    const detectionEngine = resolveDetectionEngine(config, request.sourceLanguage);
    const ocrEngine = resolveOcrEngine(config, request.sourceLanguage);
    const imageId = request.imageId || "image";
    const imageHash = createHash("sha256").update(request.image.buffer).digest("hex");

    throwIfAborted(options.signal);
    options.onProgress?.({
        step: "processing",
        imageId,
        label: "Translating image...",
    });

    const cacheKey = createImageResultCacheKey({
        imageHash,
        request,
        provider,
        model: config.defaultModel,
        detectionEngine,
        ocrEngine,
    });
    const cachedResult = options.bypassCache ? null : await readCachedImageResult(cacheKey);
    throwIfAborted(options.signal);

    if (cachedResult) {
        const result = attachImageResultContext(cachedResult, request, imageId);
        console.log(`[MangoTL] Using cached image translation: ${imageId}`);
        options.onProgress?.({
            step: "completed",
            imageId,
            label: "Image translated",
        });
        return result;
    }

    const image = request.image;

    try {
        const started = Date.now();
        const ocr = await runOcr(image, detectionEngine, ocrEngine, {
            sourceLanguage: request.sourceLanguage,
            targetLanguageProbe: resolveTargetLanguageProbe(config, request),
        });
        throwIfAborted(options.signal);

        const sourceBlocks = prepareBlocks(ocr);

        if (sourceBlocks.length === 0) {
            const result = {
                imageId,
                sourceLanguage: request.sourceLanguage,
                targetLanguage: request.targetLanguage,
                blocks: [],
            };
            // An "already translated" probe is a heuristic — do not cache it,
            // so a false positive cannot lock the page out of translation.
            if (!options.bypassCache && !ocr.alreadyTargetLanguage) {
                await cacheImageResult(cacheKey, result);
            }
            throwIfAborted(options.signal);
            options.onProgress?.({
                step: "completed",
                imageId,
                label: "Image translated",
            });
            return result;
        }

        const translatedBlocks = request.dryRun
            ? sourceBlocks.map((block) => ({
                  id: block.id,
                  translatedText: block.sourceText,
                  type: block.type,
                  direction: block.direction,
              }))
            : await translateBlocks(provider, {
                  model: config.defaultModel,
                  apiKey: config.apiKey,
                  sourceLanguage: request.sourceLanguage,
                  targetLanguage: request.targetLanguage,
                  blocks: sourceBlocks,
                  signal: options.signal,
              });
        console.log(`[MangoTL] Translation stage done in ${Date.now() - started}ms total so far`);

        // Drop blocks the model returned empty for — garbled OCR or text
        // that needs no translation. Those are left as the original art.
        const blocks = mergeTranslations(sourceBlocks, translatedBlocks, request.targetLanguage).filter(
            (block) =>
                block.translatedText.trim().length > 0 &&
                (request.dryRun || !isUntranslatedText(block.originalText, block.translatedText, request.targetLanguage)),
        );

        // Produce the finished page server-side: erase the original glyphs,
        // then draw the translation in their place. The extension only has
        // to swap this image over the original.
        const punctuationPatches = captureAdjacentPunctuation(ocr.canvas, ocr.items, blocks);
        await inpaintImage(ocr.canvas, blocks, config.pipeline?.inpaint);
        await renderImage(ocr.canvas, blocks, config.pipeline?.render);
        restoreAdjacentPunctuation(ocr.canvas, punctuationPatches);
        const renderedImage = encodeImage(ocr.canvas);

        const result = {
            imageId,
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            renderedImage,
            blocks,
        };
        if (!options.bypassCache) {
            await cacheImageResult(cacheKey, result);
        }
        throwIfAborted(options.signal);
        options.onProgress?.({
            step: "completed",
            imageId,
            label: "Image translated",
        });
        return result;
    } catch (imageError) {
        console.error("[MangoTL] Failed to process image:", imageError.message);
        throw imageError;
    }
}

async function cacheImageResult(cacheKey, result) {
    try {
        await writeCachedImageResult(cacheKey, stripImageResultContext(result));
    } catch (error) {
        console.warn("[MangoTL] Failed to cache image result:", error.message);
    }
}

function attachImageResultContext(cachedResult, request, imageId) {
    return {
        ...cachedResult,
        imageId,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
    };
}

function stripImageResultContext(result) {
    const { imageId, ...cacheableResult } = result;
    return cacheableResult;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new DOMException("Translation stopped", "AbortError");
    }
}
