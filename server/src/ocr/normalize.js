import { intersectionArea } from "../utils/geometry.js";
import { scriptProfileFor } from "./script-profiles.js";

/**
 * Normalizes a raw recognition result into the shape consumed by the
 * translation pipeline: an array of { id, text, confidence, coords }.
 *
 * Recognition engines (paddle, mangaocr) return:
 *   [{ text, box, confidence }]
 *
 * options.sourceLanguage가 주어지면 해당 언어의 스크립트 프로필 필터가
 * 추가로 적용된다 — 다른 언어의 텍스트에는 일본어 특화 규칙이 발동하지 않는다.
 */
export function normalizeOcrResult(raw, detection, ocrEngineConfig, options = {}) {
    const items = Array.isArray(raw) ? raw : [];
    const filters = ocrEngineConfig.filters || {};
    const imageSize = { width: detection.width, height: detection.height };
    const script = scriptProfileFor(options.sourceLanguage);

    const usableItems = items
        .map((item, index) => ({
            id: item.id ?? `ocr-${index + 1}`,
            text: extractText(item),
            confidence: extractConfidence(item),
            coords: extractCoords(item),
            darkBox: item.darkBox || null,
        }))
        .filter((item) => isUsableOcrItem(item, filters, imageSize, script));

    return removeOverlappingDuplicates(removeCompositeReads(usableItems));
}

function removeCompositeReads(items) {
    const letters = (value) => String(value).replace(/[^\p{L}\p{N}]/gu, "");
    const centerInside = (inner, outer) => {
        const x = inner.x + inner.width / 2;
        const y = inner.y + inner.height / 2;
        return x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
    };
    return items.filter((broad) => {
        const full = letters(broad.text);
        if (full.length <= 5 && broad.confidence < 0.9) {
            const coveredByCompleteLine = items.some((complete) => {
                const line = letters(complete.text);
                return (
                    complete !== broad &&
                    line.length >= 12 &&
                    complete.confidence >= 0.94 &&
                    complete.confidence - broad.confidence >= 0.07 &&
                    rectArea(broad.coords) <= rectArea(complete.coords) * 0.15 &&
                    intersectionArea(broad.coords, complete.coords) / rectArea(broad.coords) >= 0.95
                );
            });
            if (coveredByCompleteLine) return false;
        }
        if (broad.coords.width >= 400 && broad.coords.height >= 500 && full.length >= 12 && broad.confidence < 0.99) {
            const parts = items.filter((part) => {
                const fragment = letters(part.text);
                return (
                    part !== broad &&
                    part.confidence >= 0.99 &&
                    fragment.length >= 3 &&
                    fragment.length < full.length &&
                    full.includes(fragment) &&
                    centerInside(part.coords, broad.coords)
                );
            });
            if (parts.length >= 2 && parts.reduce((count, part) => count + letters(part.text).length, 0) >= full.length * 0.8) return false;
        }
        if (!/[?？]/u.test(broad.text) && full.length >= 5 && full.length <= 12) {
            const straddles = items.some((complete) => {
                const prefix = letters(complete.text);
                const tail = full.slice(prefix.length);
                return (
                    complete !== broad &&
                    /[?？]$/u.test(complete.text) &&
                    complete.confidence >= 0.97 &&
                    prefix.length >= 4 &&
                    full.startsWith(prefix) &&
                    tail.length >= 1 &&
                    tail.length <= 4 &&
                    intersectionArea(complete.coords, broad.coords) / rectArea(complete.coords) >= 0.5 &&
                    items.some(
                        (next) =>
                            next !== broad &&
                            next !== complete &&
                            next.confidence >= 0.95 &&
                            letters(next.text).startsWith(tail) &&
                            next.coords.x + next.coords.width / 2 < complete.coords.x + complete.coords.width / 2,
                    )
                );
            });
            if (straddles) return false;
        }
        if (full.length < 12 || broad.coords.width < 450 || broad.coords.height < 500) return true;
        const parts = items.filter((part) => {
            const fragment = letters(part.text);
            return (
                part !== broad &&
                part.confidence >= 0.95 &&
                fragment.length >= (/[?？]/u.test(part.text) ? 4 : 5) &&
                fragment.length < full.length &&
                full.includes(fragment) &&
                centerInside(part.coords, broad.coords)
            );
        });
        for (let index = 0; index < parts.length; index += 1) {
            for (let next = index + 1; next < parts.length; next += 1) {
                const a = parts[index];
                const b = parts[next];
                const aText = letters(a.text);
                const bText = letters(b.text);
                const dx = Math.abs(a.coords.x + a.coords.width / 2 - b.coords.x - b.coords.width / 2);
                const dy = Math.abs(a.coords.y + a.coords.height / 2 - b.coords.y - b.coords.height / 2);
                const overlap = intersectionArea(a.coords, b.coords) / Math.min(rectArea(a.coords), rectArea(b.coords));
                if (
                    dx > Math.min(a.coords.width, b.coords.width) * 0.45 &&
                    dy > Math.min(a.coords.height, b.coords.height) * 0.35 &&
                    overlap < 0.3 &&
                    aText.length + bText.length >= full.length * 0.75 &&
                    (full.includes(aText + bText) ||
                        full.includes(bText + aText) ||
                        (full.startsWith(aText) && full.endsWith(bText) && full.length - aText.length - bText.length <= 4) ||
                        (full.startsWith(bText) && full.endsWith(aText) && full.length - aText.length - bText.length <= 4))
                ) {
                    return false;
                }
            }
        }
        return true;
    });
}

function isUsableOcrItem(item, filters, imageSize, script) {
    const text = item.text.replace(/\s+/g, "");

    if (!text) {
        return false;
    }

    if (
        item.coords?.height > 400 &&
        (item.confidence ?? 0) < 0.85 &&
        [...text].filter((character) => /\p{L}/u.test(character)).length <= 1 &&
        [...text].filter((character) => /[.。…]/u.test(character)).length >= 3
    ) {
        return false;
    }

    if (/(\p{L})\1{9,}/u.test(text)) {
        return false;
    }

    // Sparse illustration strokes occasionally read as an isolated two- or
    // three-kana word. At low confidence this erases the drawing and inserts a
    // stray word in the translated page. A real utterance is usually longer,
    // carries punctuation, or is read with higher confidence.
    if (script.shortSyllabaryWord?.test(text) && (item.confidence ?? 0) < 0.78) {
        return false;
    }

    if (script.syllabaryComma && script.syllabaryComma.test(text) && (item.confidence ?? 0) < 0.93 && item.coords?.height > item.coords?.width * 2) {
        return false;
    }

    if (
        /[A-Za-z]/u.test(text) &&
        script.syllabary?.test(text) &&
        [...text].filter((character) => /\p{L}/u.test(character)).length <= 3 &&
        (item.confidence ?? 0) < 0.85
    ) {
        return false;
    }

    if (!item.coords) {
        return false;
    }

    if (text.length === 1 && item.coords.height < 20 && item.coords.width > item.coords.height * 3 && (item.confidence ?? 0) < 0.9) {
        return false;
    }

    if (typeof item.confidence === "number" && item.confidence < (filters.minConfidence ?? 0)) {
        return false;
    }

    if ((filters.rejectSingleCharacters ?? false) && text.length < (filters.minTextLength ?? 1) && !/[!?！？…]/.test(text)) {
        return false;
    }

    if (filters.maxTextAreaRatio) {
        const textArea = item.coords.width * item.coords.height;
        const imageArea = imageSize.width * imageSize.height;

        if (imageArea > 0 && textArea / imageArea > filters.maxTextAreaRatio) {
            return false;
        }
    }

    return true;
}

function extractText(item) {
    const text = item.text || "";
    return String(text).trim();
}

function extractConfidence(item) {
    const confidence = item.confidence ?? null;

    if (confidence === null) {
        return null;
    }

    const numericConfidence = Number(confidence);

    return Number.isFinite(numericConfidence) ? numericConfidence : null;
}

function extractCoords(item) {
    const rawBox = item.coords || item.box;
    return boxToRect(rawBox);
}

function boxToRect(rawBox) {
    if (!rawBox) {
        return null;
    }

    if (Array.isArray(rawBox) && rawBox.length === 4 && rawBox.every((value) => Number.isFinite(Number(value)))) {
        const [x, y, third, fourth] = rawBox.map(Number);
        return {
            x,
            y,
            width: Math.max(1, third),
            height: Math.max(1, fourth),
        };
    }

    if (Array.isArray(rawBox) && rawBox.every((point) => Array.isArray(point) && point.length >= 2)) {
        const xs = rawBox.map((point) => Number(point[0])).filter(Number.isFinite);
        const ys = rawBox.map((point) => Number(point[1])).filter(Number.isFinite);
        return rectFromExtents(xs, ys);
    }

    if (typeof rawBox === "object") {
        const x = rawBox.x ?? rawBox.left ?? rawBox.minX ?? rawBox.x1;
        const y = rawBox.y ?? rawBox.top ?? rawBox.minY ?? rawBox.y1;
        const right = rawBox.right ?? rawBox.maxX ?? rawBox.x2;
        const bottom = rawBox.bottom ?? rawBox.maxY ?? rawBox.y2;
        const width = rawBox.width ?? rawBox.w ?? (right !== undefined ? right - x : undefined);
        const height = rawBox.height ?? rawBox.h ?? (bottom !== undefined ? bottom - y : undefined);

        if ([x, y, width, height].every((value) => Number.isFinite(Number(value)))) {
            return {
                x: Number(x),
                y: Number(y),
                width: Math.max(1, Number(width)),
                height: Math.max(1, Number(height)),
            };
        }
    }

    return null;
}

function rectFromExtents(xs, ys) {
    if (xs.length === 0 || ys.length === 0) {
        return null;
    }

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
    };
}

function removeOverlappingDuplicates(items) {
    const kept = [];

    for (const item of [...items].sort(compareOcrQuality)) {
        let discard = false;

        for (let index = kept.length - 1; index >= 0; index -= 1) {
            const candidate = kept[index];
            if (!isDuplicateRegion(candidate.coords, item.coords)) {
                continue;
            }

            const longer = richerContainingRead(candidate, item);
            if (longer === item) {
                kept.splice(index, 1);
            } else {
                discard = true;
                break;
            }
        }

        if (!discard) {
            kept.push(item);
        }
    }

    return kept.sort((a, b) => ocrItemOrder(a) - ocrItemOrder(b));
}

function richerContainingRead(a, b) {
    const aLetters = [...a.text].filter((character) => /\p{L}|\p{N}/u.test(character));
    const bLetters = [...b.text].filter((character) => /\p{L}|\p{N}/u.test(character));
    if (aLetters.join("") === bLetters.join("")) {
        const punctuated = /[?？!！]$/u.test(a.text) ? a : /[?？!！]$/u.test(b.text) ? b : null;
        if (punctuated) {
            const other = punctuated === a ? b : a;
            const overlap = intersectionArea(a.coords, b.coords) / Math.min(rectArea(a.coords), rectArea(b.coords));
            if (!/[?？!！]$/u.test(other.text) && overlap >= 0.65 && (punctuated.confidence ?? 0) >= (other.confidence ?? 0) - 0.03) {
                return punctuated;
            }
        }
    }
    if (a.darkBox !== b.darkBox && aLetters.join("") === bLetters.join("")) {
        const enclosed = a.darkBox ? a : b;
        const broad = enclosed === a ? b : a;
        if ((enclosed.confidence ?? 0) >= (broad.confidence ?? 0) - 0.05) {
            return enclosed;
        }
    }
    const moreComplete = aLetters.length >= bLetters.length ? a : b;
    const lessComplete = moreComplete === a ? b : a;
    const overlapRatio = intersectionArea(a.coords, b.coords) / Math.min(rectArea(a.coords), rectArea(b.coords));
    if (
        overlapRatio >= 0.65 &&
        Math.min(aLetters.length, bLetters.length) >= 5 &&
        Math.max(aLetters.length, bLetters.length) > Math.min(aLetters.length, bLetters.length) &&
        isTextSubsequence(lessComplete === a ? aLetters : bLetters, moreComplete === a ? aLetters : bLetters) &&
        (moreComplete.confidence ?? 0) >= 0.9 &&
        (moreComplete.confidence ?? 0) >= (lessComplete.confidence ?? 0) - 0.06
    ) {
        return moreComplete;
    }

    const aText = a.text.replace(/\s+/g, "");
    const bText = b.text.replace(/\s+/g, "");
    const aArea = rectArea(a.coords);
    const bArea = rectArea(b.coords);
    const larger = aArea >= bArea ? a : b;
    const smaller = larger === a ? b : a;
    const largerText = larger === a ? aText : bText;
    const smallerText = smaller === a ? aText : bText;
    const overlap = intersectionArea(a.coords, b.coords);

    if (
        (aArea / bArea < 4 && bArea / aArea < 4) ||
        overlap / Math.min(aArea, bArea) < 0.8 ||
        largerText.length <= smallerText.length ||
        !isTextSubsequence(smallerText, largerText) ||
        (larger.confidence ?? 0) < 0.8
    ) {
        return null;
    }

    return larger;
}

function isTextSubsequence(shortText, longText) {
    let cursor = 0;
    for (const character of longText) {
        if (character === shortText[cursor]) {
            cursor += 1;
        }
    }
    return cursor === shortText.length;
}

function compareOcrQuality(a, b) {
    return ocrQualityScore(b) - ocrQualityScore(a);
}

function ocrQualityScore(item) {
    const compact = item.text.replace(/\s+/g, "");
    const letters = [...compact].filter((character) => /\p{L}|\p{N}/u.test(character)).length;
    const punctuation = Math.max(0, compact.length - letters);
    const confidence = typeof item.confidence === "number" ? item.confidence : 0.8;
    const area = item.coords.width * item.coords.height;
    const lengthScore = Math.min(1, letters / 48);
    const areaScore = Math.min(1, Math.sqrt(area) / 260);
    const punctuationPenalty = compact.length > 0 ? (punctuation / compact.length) * 0.18 : 0;
    const noisyTailPenalty =
        /[・.。…]{4,}$|[「『(（]$|[A-Za-z]*[♀♂]+/u.test(compact) ||
        (punctuation / Math.max(1, compact.length) > 0.45 && /[・.。…]{4,}/u.test(compact))
            ? 0.16
            : 0;

    return confidence * 3 + lengthScore * 0.16 + areaScore * 0.05 - punctuationPenalty - noisyTailPenalty;
}

function isDuplicateRegion(a, b) {
    const overlap = intersectionArea(a, b);

    if (overlap <= 0) {
        return false;
    }

    const smallerArea = Math.min(rectArea(a), rectArea(b));
    return smallerArea > 0 && overlap / smallerArea > 0.45;
}

function rectArea(rect) {
    return rect.width * rect.height;
}

function ocrItemOrder(item) {
    const value = Number(String(item.id).replace(/\D+/g, ""));
    return Number.isFinite(value) ? value : 0;
}
