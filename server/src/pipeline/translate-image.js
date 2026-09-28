import { isUntranslatedText, translateWithOpenAICompatible } from "../ai/openai-compatible.js";
import { runOcr } from "../ocr/index.js";
import { analyzeBlockStyles } from "../text/analyze-style.js";
import { ensureRenderFonts } from "../text/fonts.js";
import { groupTextBlocks } from "../text/group-blocks.js";
import { encodeImage, inpaintTextRegions } from "../text/inpaint/index.js";
import { findDetailedTextRegionIds, restoreDetailedTextRegions } from "../text/inpaint/lama.js";
import { captureAdjacentPunctuation, restoreAdjacentPunctuation } from "../text/inpaint/preserve-punctuation.js";
import { renderTranslatedText } from "../text/render-text.js";
import { HttpError } from "../utils/http-error.js";
import { createImageResultCacheKey, readCachedImageResult, writeCachedImageResult } from "../utils/image-result-cache.js";
import { createHash } from "node:crypto";
import { createCanvas } from "ppu-ocv";
import { isOutlinedArtCaption } from "../text/art-caption.js";

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
        const targetLanguageProbe = request.sourceLanguage === "ja" && request.targetLanguage === "ko" ? resolveOcrEngine(config, "ko") : null;
        let sourceLanguageProbe = null;
        if (request.sourceLanguage === "ja") {
            try {
                sourceLanguageProbe = prepareOcrEngine(findOcrEngine(config, "paddle"), "ja", config);
            } catch {
                // Supplemental badge reads are optional — proceed without them.
            }
        }
        const ocr = await runOcr(image, detectionEngine, ocrEngine, { targetLanguageProbe, sourceLanguageProbe });
        throwIfAborted(options.signal);

        // Drop blocks with no actual letters (rows of dots, stray symbols):
        // these are OCR noise picked off the artwork, not translatable text.
        const textItems = ocr.items.filter((item) => /\p{L}/u.test(item.text));
        const groupedBlocks = groupTextBlocks(textItems).filter((block) => /\p{L}/u.test(block.sourceText));
        const sourceBlocks = avoidDarkTextRegions(
            analyzeBlockStyles(groupedBlocks, ocr.canvas)
                .map(markFootstepEffect)
                .map(markConfirmedRepeatedEffect)
                .map(markDarkOutlinedEffect)
                .map(markOutlinedArtCaption)
                .map((block) => applyDetectedBubbleBox(block, ocr.width, ocr.height))
                .filter((block) => shouldTranslateBlock(block, ocr.width, ocr.height)),
        );

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
            : await translateWithOpenAICompatible({
                  provider,
                  model: config.defaultModel,
                  apiKey: config.apiKey,
                  sourceLanguage: request.sourceLanguage,
                  targetLanguage: request.targetLanguage,
                  blocks: sourceBlocks,
                  signal: options.signal,
              });

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
        const detailedIds = findDetailedTextRegionIds(ocr.canvas, blocks);
        const sourceCanvas = detailedIds.size > 0 ? createCanvas(ocr.width, ocr.height) : null;
        sourceCanvas?.getContext("2d").drawImage(ocr.canvas, 0, 0);
        inpaintTextRegions(ocr.canvas, blocks, detailedIds);
        if (sourceCanvas) {
            const restored = await restoreDetailedTextRegions(ocr.canvas, blocks, sourceCanvas);
            const failed = blocks.filter((block) => detailedIds.has(block.id) && !restored.has(block.id));
            if (failed.length > 0) inpaintTextRegions(ocr.canvas, failed);
        }
        await ensureRenderFonts();
        renderTranslatedText(ocr.canvas, blocks);
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

function resolveProvider(config) {
    const id = config.defaultProvider;
    const provider = config.providers.find((candidate) => candidate.id === id);

    if (!provider) {
        throw new HttpError(400, "provider_not_found", `AI provider not found: ${id || "(none)"}`);
    }

    if (provider.type !== "openai-compatible") {
        throw new HttpError(400, "provider_not_supported", `Unsupported provider type: ${provider.type}`);
    }

    return provider;
}

function resolveDetectionEngine(config, sourceLanguage) {
    const language = sourceLanguage || config.defaultSourceLanguage;
    const id = getLanguageRouting(config, language)?.detectionEngine || config.defaultDetectionEngine;
    const engine = config.detectionEngines.find((candidate) => candidate.id === id);

    if (!engine) {
        throw new HttpError(400, "detection_engine_not_found", `Detection engine not found: ${id || "(none)"}`);
    }

    return engine;
}

function resolveOcrEngine(config, sourceLanguage) {
    const language = sourceLanguage || config.defaultSourceLanguage;
    const routedId = getLanguageRouting(config, language)?.ocrEngine;

    return prepareOcrEngine(findOcrEngine(config, routedId || config.defaultOcrEngine), language, config);
}

function prepareOcrEngine(engine, language, config) {
    if (!supportsLanguage(engine, language)) {
        throw new HttpError(400, "ocr_engine_not_found", `OCR engine "${engine.id}" does not support source language: ${language || "(none)"}`);
    }

    const languageModel = resolveLanguageModel(engine, language, config);

    if (!languageModel) {
        return engine;
    }

    return {
        ...engine,
        model: { ...engine.model, ...languageModel },
    };
}

function supportsLanguage(engine, language) {
    if (!language) {
        return true;
    }

    if (Array.isArray(engine.supportedLanguages)) {
        return engine.supportedLanguages.includes(language);
    }

    if (engine.languages && typeof engine.languages === "object") {
        return Object.hasOwn(engine.languages, language);
    }

    return true;
}

function getLanguageRouting(config, language) {
    return language ? config.ocrRouting?.languages?.[language] || null : null;
}

function resolveLanguageModel(engine, language, config) {
    if (!engine.languages || typeof engine.languages !== "object") {
        return null;
    }

    const fallbackLanguage = engine.defaultLanguage || config.defaultSourceLanguage;
    return engine.languages[language] || engine.languages[fallbackLanguage] || null;
}

function findOcrEngine(config, engineId) {
    const engine = config.ocrEngines.find((candidate) => candidate.id === engineId);

    if (!engine) {
        throw new HttpError(400, "ocr_engine_not_found", `OCR engine not found: ${engineId || "(none)"}`);
    }

    return engine;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new DOMException("Translation stopped", "AbortError");
    }
}

function mergeTranslations(sourceBlocks, translatedBlocks, targetLanguage) {
    const byId = new Map(translatedBlocks.map((block) => [String(block.id), block]));

    return sourceBlocks.map((sourceBlock) => {
        const translated = byId.get(String(sourceBlock.id));
        const translatedText = translated ? translated.translatedText : sourceBlock.sourceText;

        return {
            id: sourceBlock.id,
            order: sourceBlock.order,
            originalText: sourceBlock.sourceText,
            // An explicit empty string from the model means "skip"; only fall
            // back to the source text when the model omitted the block entirely.
            translatedText,
            coords: sourceBlock.coords,
            eraseCoords: sourceBlock.eraseCoords || sourceBlock.coords,
            type: translated?.type || sourceBlock.type,
            direction: sourceBlock.outlinedEffect
                ? "vertical"
                : sourceBlock.darkBox &&
                    (translated?.type === "sfx" || sourceBlock.type === "sfx") &&
                    sourceBlock.darkBox.height > sourceBlock.darkBox.width * 1.2
                  ? "vertical"
                  : normalizeRenderDirection(translated?.direction, sourceBlock.direction, translatedText, targetLanguage),
            confidence: sourceBlock.confidence,
            sourceBlockIds: sourceBlock.sourceBlockIds,
            tinyLabel: Boolean(sourceBlock.tinyLabel),
            standalone: Boolean(sourceBlock.standalone),
            confirmedRepeatedEffect: Boolean(sourceBlock.confirmedRepeatedEffect),
            footstepEffect: Boolean(sourceBlock.footstepEffect),
            pastelBadge: Boolean(sourceBlock.pastelBadge),
            darkOutlinedEffect: Boolean(sourceBlock.darkOutlinedEffect),
            artCaption: Boolean(sourceBlock.artCaption),
            outlinedEffect: Boolean(sourceBlock.outlinedEffect),
            insetHandwritten: Boolean(sourceBlock.insetHandwritten),
            largeOutlinedEffect: Boolean(sourceBlock.largeOutlinedEffect),
            darkBox: sourceBlock.darkBox || null,
            style: sourceBlock.style || null,
        };
    });
}

function shouldTranslateBlock(block, imageWidth, imageHeight) {
    const text = String(block.sourceText || "").trim();
    const compact = text.replace(/\s+/g, "");

    if (!compact) {
        return false;
    }

    if (isMetadataText(compact)) {
        return false;
    }

    if (
        /[A-Za-z]/u.test(compact) &&
        /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(compact) &&
        [...compact].filter((character) => /\p{L}/u.test(character)).length <= 3 &&
        (block.confidence ?? 0) < 0.85
    ) {
        return false;
    }

    if ([...compact].length === 1 && (block.confidence ?? 0) < 0.95 && !block.tinyLabel) {
        return false;
    }

    if (!hasDrawableTextSurface(block)) {
        return false;
    }

    if (isLowQualityDecorativeBlock(block, compact, imageWidth, imageHeight)) {
        return false;
    }

    return true;
}

function markDarkOutlinedEffect(block) {
    const background = /^#([0-9a-f]{6})$/i.exec(block.style?.background || "");
    const darkest = background ? Math.max(...[0, 2, 4].map((index) => Number.parseInt(background[1].slice(index, index + 2), 16))) : 255;
    if (
        darkest < 80 &&
        block.style?.strokeColor === "#ffffff" &&
        block.confidence >= 0.9 &&
        /^[\p{Script=Katakana}\p{Script=Hiragana}]{1,4}$/u.test(block.sourceText) &&
        block.coords.width <= 200 &&
        block.coords.height <= 180
    ) {
        return { ...block, type: "sfx", darkOutlinedEffect: true, style: { ...block.style, textColor: "#1a1a1a", strokeColor: "#ffffff" } };
    }
    return block;
}

function markFootstepEffect(block) {
    if (!block.footstepEffect) return block;
    return { ...block, type: "sfx", style: { ...block.style, textColor: "#111111", strokeColor: "#ffffff" } };
}

function markConfirmedRepeatedEffect(block) {
    if (!block.confirmedRepeatedEffect) return block;
    return { ...block, type: "sfx", style: { ...block.style, textColor: "#111111", strokeColor: "#ffffff" } };
}

function markOutlinedArtCaption(block) {
    if (!isOutlinedArtCaption(block)) return block;
    return { ...block, artCaption: true, style: { ...block.style, textColor: "#1a1a1a", strokeColor: "#ffffff" } };
}

function applyDetectedBubbleBox(block, imageWidth, imageHeight) {
    if (block.insetHandwritten) return block;
    if (block.darkBox) {
        const source = block.coords;
        const surface = block.darkBox;
        const background = block.style?.background || "#000000";
        const darkSurface =
            /^#[0-9a-f]{6}$/i.test(background) && Math.max(...[1, 3, 5].map((index) => Number.parseInt(background.slice(index, index + 2), 16))) < 80;
        const width = Math.round(surface.width * (darkSurface ? 0.82 : 0.55));
        const height = Math.round(Math.min(surface.height * 0.86, Math.max(source.height * 1.15, surface.height * 0.5)));
        const centerX = darkSurface ? source.x + source.width / 2 : surface.x + surface.width * 0.42;
        const centerY = source.y + source.height / 2;
        return {
            ...block,
            coords: {
                x: Math.round(clamp(centerX - width / 2, surface.x, surface.x + surface.width - width)),
                y: Math.round(clamp(centerY - height / 2, surface.y, surface.y + surface.height - height)),
                width,
                height,
            },
            eraseCoords: source,
            style: darkSurface
                ? { background: "#000000", textColor: "#ffffff", strokeColor: null, bubbleBox: null }
                : { background, textColor: "#161616", strokeColor: "#ffffff", bubbleBox: null },
        };
    }

    const bubbleBox = block.style?.bubbleBox;

    if (!bubbleBox || !shouldUseDetectedBubbleBox(block, bubbleBox, imageWidth, imageHeight)) {
        return block;
    }

    const coords = getRenderBox(block, bubbleBox);

    return {
        ...block,
        coords,
        eraseCoords: block.eraseCoords || block.coords,
        renderBackground: isTopEdgeVerticalSource(block.coords, bubbleBox),
    };
}

function avoidDarkTextRegions(blocks) {
    const darkBoxes = blocks.filter((block) => block.darkBox).map((block) => block.darkBox);
    return blocks.map((block) => {
        if (block.darkBox) {
            return block;
        }
        let coords = block.coords;
        for (const dark of darkBoxes) {
            const overlapWidth = Math.max(0, Math.min(coords.x + coords.width, dark.x + dark.width) - Math.max(coords.x, dark.x));
            const overlapHeight = Math.max(0, Math.min(coords.y + coords.height, dark.y + dark.height) - Math.max(coords.y, dark.y));
            if ((overlapWidth * overlapHeight) / (coords.width * coords.height) < 0.08) {
                continue;
            }
            const margin = 12;
            const leftWidth = dark.x - margin - coords.x;
            const rightX = dark.x + dark.width + margin;
            const rightWidth = coords.x + coords.width - rightX;
            const minimum = Math.max(120, coords.width * 0.3);
            if (Math.max(leftWidth, rightWidth) < minimum) {
                continue;
            }
            coords =
                leftWidth > rightWidth
                    ? { ...coords, width: Math.round(leftWidth) }
                    : { ...coords, x: Math.round(rightX), width: Math.round(rightWidth) };
        }
        return coords === block.coords ? block : { ...block, coords };
    });
}

function getRenderBox(block, bubbleBox) {
    const coords = block.coords;

    if (isTopEdgeVerticalSource(coords, bubbleBox)) {
        return getTopEdgeVerticalRenderBox(coords, bubbleBox);
    }

    if (coords.height > coords.width * 1.15) {
        return bubbleBox;
    }

    const targetWidth = Math.min(bubbleBox.width, Math.max(coords.width, coords.width * 1.35));
    const targetHeight = Math.min(bubbleBox.height, Math.max(coords.height, coords.height * 2.1));
    const centerX = coords.x + coords.width / 2;
    const centerY = coords.y + coords.height / 2;
    const x = clamp(centerX - targetWidth / 2, bubbleBox.x, bubbleBox.x + bubbleBox.width - targetWidth);
    const y = clamp(centerY - targetHeight / 2, bubbleBox.y, bubbleBox.y + bubbleBox.height - targetHeight);

    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(targetWidth),
        height: Math.round(targetHeight),
    };
}

function getTopEdgeVerticalRenderBox(coords, bubbleBox) {
    const targetWidth = Math.min(bubbleBox.width * 0.6, Math.max(coords.width * 1.42, 120));
    const targetHeight = Math.min(bubbleBox.height * 0.5, Math.max(coords.height * 0.85, 96));
    const centerX = coords.x + coords.width / 2;
    const centerY = coords.y + coords.height / 2 + 8;
    const x = clamp(centerX - targetWidth / 2, bubbleBox.x, bubbleBox.x + bubbleBox.width - targetWidth);
    const y = clamp(centerY - targetHeight / 2, bubbleBox.y, bubbleBox.y + bubbleBox.height - targetHeight);

    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(targetWidth),
        height: Math.round(targetHeight),
    };
}

function shouldUseDetectedBubbleBox(block, bubbleBox, imageWidth, imageHeight) {
    const coords = block.coords;
    const compactLength = String(block.sourceText || "").replace(/\s+/g, "").length;
    const originalArea = coords.width * coords.height;
    const bubbleArea = bubbleBox.width * bubbleBox.height;
    const imageArea = Math.max(1, imageWidth * imageHeight);
    const strictContainsText =
        bubbleBox.x <= coords.x + coords.width * 0.25 &&
        bubbleBox.y <= coords.y + coords.height * 0.25 &&
        bubbleBox.x + bubbleBox.width >= coords.x + coords.width * 0.75 &&
        bubbleBox.y + bubbleBox.height >= coords.y + coords.height * 0.75;
    const overlapWidth = Math.max(0, Math.min(coords.x + coords.width, bubbleBox.x + bubbleBox.width) - Math.max(coords.x, bubbleBox.x));
    const overlapHeight = Math.max(0, Math.min(coords.y + coords.height, bubbleBox.y + bubbleBox.height) - Math.max(coords.y, bubbleBox.y));
    const containsTallTextWithOcrOvershoot =
        coords.height > coords.width * 1.8 &&
        overlapWidth / Math.max(1, coords.width) >= 0.85 &&
        overlapHeight / Math.max(1, coords.height) >= 0.65 &&
        bubbleBox.height >= 350;
    const expansion = bubbleArea / Math.max(1, originalArea);
    const verticalSourceText = coords.height > coords.width * 1.15 && coords.width < Math.max(160, imageWidth * 0.12);
    const horizontalDialogue = coords.width >= coords.height && compactLength >= 8;
    const needsMoreRoom = verticalSourceText || horizontalDialogue;
    const reasonableExpansion = bubbleArea >= originalArea * 1.05 && expansion <= 10 && bubbleArea / imageArea <= 0.14;

    return (strictContainsText || containsTallTextWithOcrOvershoot) && needsMoreRoom && reasonableExpansion;
}

function isMetadataText(compact) {
    return /^D\+\d+$/i.test(compact) || /^D\+\d+@?[\w.-]+$/i.test(compact) || /^@[\w.-]+$/i.test(compact);
}

function isLowQualityDecorativeBlock(block, compact, imageWidth, imageHeight) {
    if (block.outlinedEffect || block.darkOutlinedEffect || block.artCaption || block.confirmedRepeatedEffect || block.footstepEffect) return false;
    const areaRatio = (block.coords.width * block.coords.height) / Math.max(1, imageWidth * imageHeight);
    const punctuationRatio = punctuationCount(compact) / Math.max(1, compact.length);
    const confidence = typeof block.confidence === "number" ? block.confidence : 1;
    const touchesPageEdge = block.coords.x <= 8 || block.coords.y <= 8 || block.coords.x + block.coords.width >= imageWidth - 8;
    const hugeEdgeBlock = touchesPageEdge && areaRatio > 0.08 && !isLikelySpeechBubble(block);
    const letterCount = [...compact].filter((character) => /\p{L}|\p{N}/u.test(character)).length;
    const noisyLargeBlock = areaRatio > 0.045 && punctuationRatio > 0.5 && letterCount < 4 && confidence < 0.85;
    const plausibleQuestion = isLikelySpeechBubble(block) && /[?？]$/u.test(compact) && letterCount >= 2;
    const noisyLowConfidenceBlock = confidence < 0.82 && punctuationRatio > 0.2 && !plausibleQuestion;
    const shortLowConfidenceBlock = compact.length <= 2 && confidence < 0.82 && !block.tinyLabel && !block.darkBox;
    const shortDecorativeText = compact.length <= 2 && !isLikelySpeechBubble(block) && !block.darkBox && !block.tinyLabel;

    return hugeEdgeBlock || noisyLargeBlock || noisyLowConfidenceBlock || shortLowConfidenceBlock || shortDecorativeText;
}

function hasDrawableTextSurface(block) {
    if (block.outlinedEffect || block.darkOutlinedEffect || block.artCaption || block.confirmedRepeatedEffect || block.footstepEffect) return true;
    if (block.tinyLabel && (block.confidence ?? 0) >= 0.85) {
        return true;
    }
    if (block.darkBox) {
        return true;
    }
    if (block.style?.bubbleBox) {
        return true;
    }

    if (!isLikelySpeechBubble(block)) {
        return false;
    }

    const coords = block.coords;
    const compactLength = String(block.sourceText || "").replace(/\s+/g, "").length;
    const enoughRoom = coords.width * coords.height >= 11000;

    return enoughRoom || compactLength >= 8;
}

function isTopEdgeVerticalSource(coords, bubbleBox) {
    return Boolean(bubbleBox) && bubbleBox.y <= 1 && coords.y < 24 && coords.height > coords.width * 1.1;
}

function isLikelySpeechBubble(block) {
    const background = hexToRgb(block.style?.background);

    if (!background) {
        return false;
    }

    const [r, g, b] = background;
    const brightness = (r + g + b) / 3;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);

    return brightness > 225 && saturation < 35;
}

function punctuationCount(text) {
    return [...text].filter((character) => !/\p{L}|\p{N}/u.test(character)).length;
}

function hexToRgb(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));

    if (!match) {
        return null;
    }

    const value = Number.parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function normalizeRenderDirection(translatedDirection, sourceDirection, text, targetLanguage) {
    if (usesHorizontalTargetLayout(targetLanguage)) {
        return "horizontal";
    }

    if (translatedDirection === "horizontal" || translatedDirection === "vertical") {
        return translatedDirection;
    }

    if (!/[^\x00-\x7F]/.test(text)) {
        return "horizontal";
    }

    return sourceDirection || "horizontal";
}

function usesHorizontalTargetLayout(targetLanguage) {
    return ["ko", "en", "de", "sv"].includes(targetLanguage);
}
