import { intersectionArea } from "../../utils/geometry.js";

// A detector can include a nearby balloon outline in a small handwritten
// caption. MangaOCR then reads the caption with low confidence or discards it.
// Retry the central lettering in two inset crops and require the reads to agree.
export function findInsetHandwrittenCandidates(rawItems, recognizedItems) {
    return rawItems.flatMap((item) => {
        const box = item.box;
        const kana = String(item.text || "").match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
        if (!box || item.confidence < 0.35 || item.confidence >= 0.82 || kana.length < 2 || kana.length > 18) return [];
        if (box.width < 100 || box.width > 320 || box.height < 100 || box.height > 320) return [];
        if (recognizedItems.some((other) => intersectionArea(box, other.coords) / (box.width * box.height) > 0.45)) return [];
        const inset = (left, top, width, height) => ({
            x: Math.round(box.x + box.width * left),
            y: Math.round(box.y + box.height * top),
            width: Math.round(box.width * width),
            height: Math.round(box.height * height),
        });
        return [{ box, crops: [inset(0.25, 0.14, 0.5, 0.78), inset(0.2, 0.1, 0.6, 0.8)] }];
    });
}

export function matchingInsetHandwrittenText(reads) {
    if (reads.length !== 2 || reads.some((read) => !read || read.confidence < 0.85)) return null;
    const key = (text) => String(text || "").replace(/[\s.。…、，!?！？]/gu, "");
    if (key(reads[0].text) !== key(reads[1].text) || (key(reads[0].text).match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length < 3)
        return null;
    return reads[0].confidence >= reads[1].confidence ? reads[0] : reads[1];
}

// A higher-resolution Paddle pass sometimes finds each glyph of a thin,
// handwritten vertical effect separately. Join only isolated small pairs.
export function findSupplementalVerticalFragments(standardBoxes, highResolutionBoxes, recognizedItems, imageWidth, imageHeight) {
    const small = highResolutionBoxes.filter((box) => {
        if (box.width > 85 || box.height > 85 || box.width < 12 || box.height < 12) {
            return false;
        }
        return !standardBoxes.some((standard) => intersectionArea(box, standard) / (box.width * box.height) > 0.6);
    });
    const candidates = [];
    for (let index = 0; index < small.length; index += 1) {
        for (let next = index + 1; next < small.length; next += 1) {
            const a = small[index];
            const b = small[next];
            const centerDistanceX = Math.abs(a.x + a.width / 2 - b.x - b.width / 2);
            const centerDistanceY = Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
            if (centerDistanceX >= 70 || centerDistanceY <= 30 || centerDistanceY >= 130) {
                continue;
            }
            const x = Math.max(0, Math.min(a.x, b.x) - 25);
            const y = Math.max(0, Math.min(a.y, b.y) - 20);
            const right = Math.min(imageWidth, Math.max(a.x + a.width, b.x + b.width) + 25);
            const bottom = Math.min(imageHeight, Math.max(a.y + a.height, b.y + b.height) + 30);
            const candidate = { x, y, width: right - x, height: bottom - y };
            if (recognizedItems.some((item) => intersectionArea(candidate, item.coords) / (candidate.width * candidate.height) > 0.45)) {
                continue;
            }
            candidates.push(candidate);
        }
    }
    return candidates;
}

export function normalizeHandwrittenEffect(text) {
    return String(text || "").replace(/(?<=[\p{Script=Hiragana}\p{Script=Katakana}])\\(?=[\p{Script=Hiragana}\p{Script=Katakana}])/gu, "ー");
}

const kanaOnly = (text) =>
    String(text || "")
        .match(/[\p{Script=Hiragana}\p{Script=Katakana}ー]/gu)
        ?.join("") || "";

// A repeated mark (footsteps, taps) is often read weakly, and one copy can be
// scanned right-to-left into the mirrored kana string. Two nearby short kana
// reads that match — or mirror — each other confirm the letters. When the
// reads disagree, the higher-confidence direction wins.
export function findRepeatedFootstepCandidates(rawItems, recognizedItems) {
    const candidates = rawItems.filter((item) => {
        const box = item.box;
        const text = String(item.text || "");
        return (
            box &&
            kanaOnly(text) === text &&
            text.length === 2 &&
            item.confidence >= 0.6 &&
            item.confidence < 0.85 &&
            box.width >= 90 &&
            box.width <= 160 &&
            box.height >= 75 &&
            box.height <= 130 &&
            !recognizedItems.some((other) => intersectionArea(box, other.coords) / (box.width * box.height) > 0.4)
        );
    });
    return candidates.flatMap((item) => {
        const partner = candidates.find((other) => {
            if (other === item) return false;
            const mine = kanaOnly(item.text);
            const theirs = kanaOnly(other.text);
            if (theirs !== mine && theirs !== [...mine].reverse().join("")) return false;
            const dx = item.box.x + item.box.width / 2 - other.box.x - other.box.width / 2;
            const dy = item.box.y + item.box.height / 2 - other.box.y - other.box.height / 2;
            return Math.hypot(dx, dy) >= 70 && Math.hypot(dx, dy) <= 230;
        });
        if (!partner) return [];
        const text = partner.confidence > item.confidence ? String(partner.text) : String(item.text);
        return [{ box: item.box, confidence: item.confidence, text }];
    });
}

function effectKey(text) {
    return String(text || "")
        .normalize("NFD")
        .replace(/[\u3099\u309aーっッ\s]/gu, "")
        .replace(/[^\p{Script=Hiragana}\p{Script=Katakana}]/gu, "");
}

// A repeated handwritten effect may be detected only once at the normal
// resolution. Read isolated higher-resolution boxes near a known short effect.
export function findSupplementalRepeatedEffects(standardBoxes, highResolutionBoxes, recognizedItems, imageWidth, imageHeight) {
    const effects = recognizedItems.filter((item) => {
        const key = effectKey(item.text);
        return key.length >= 2 && key.length <= 5 && item.text.length <= 7;
    });
    return highResolutionBoxes.flatMap((box) => {
        if (box.width < 60 || box.width > 170 || box.height < 45 || box.height > 110) return [];
        if (
            standardBoxes.some(
                (standard) =>
                    standard.width * standard.height < box.width * box.height * 10 &&
                    intersectionArea(box, standard) / (box.width * box.height) > 0.6,
            )
        )
            return [];
        if (recognizedItems.some((item) => intersectionArea(box, item.coords) / (box.width * box.height) > 0.45)) return [];
        const nearby = effects.filter((item) => {
            const dx = box.x + box.width / 2 - item.coords.x - item.coords.width / 2;
            const dy = box.y + box.height / 2 - item.coords.y - item.coords.height / 2;
            return Math.hypot(dx, dy) < 1200 && Math.hypot(dx, dy) > 100;
        });
        if (nearby.length === 0) return [];
        const x = Math.max(0, box.x - 14);
        const y = Math.max(0, box.y - 15);
        const recognitionBox = { x, y, width: Math.min(140, imageWidth - x), height: Math.min(105, imageHeight - y) };
        const adjacent = highResolutionBoxes.filter(
            (other) => other !== box && other.width <= 170 && other.height <= 130 && intersectionArea(recognitionBox, other) > 0,
        );
        const joined = [box, ...adjacent];
        const right = Math.min(imageWidth, Math.max(...joined.map((item) => item.x + item.width)) + 14);
        const bottom = Math.min(imageHeight, Math.max(...joined.map((item) => item.y + item.height)) + 15);
        const renderBox =
            adjacent.length > 0 && right - x <= 230 && bottom - y <= 180 ? { x, y, width: right - x, height: bottom - y } : recognitionBox;
        return [{ box: recognitionBox, renderBox, nearby }];
    });
}

export function matchRepeatedEffect(text, nearby) {
    const key = effectKey(text);
    if (key.length < 2) return null;
    return nearby.find((item) => effectKey(item.text) === key) || null;
}

// Some lettering is split into one detector box per kana at normal resolution.
// Re-read adjacent glyphs together only when a complete copy of that short
// effect has already been recognized nearby.
export function findSplitRepeatedEffects(standardBoxes, recognizedItems, imageWidth, imageHeight) {
    const known = recognizedItems.filter((item) => {
        const key = effectKey(item.text);
        return key.length >= 2 && key.length <= 5 && item.text.length <= 7 && item.confidence >= 0.95;
    });
    const small = standardBoxes.filter((box) => box.width >= 30 && box.width <= 90 && box.height >= 25 && box.height <= 85);
    const candidates = [];
    for (let first = 0; first < small.length; first += 1) {
        for (let second = first + 1; second < small.length; second += 1) {
            const a = small[first].x <= small[second].x ? small[first] : small[second];
            const b = a === small[first] ? small[second] : small[first];
            const gap = b.x - a.x - a.width;
            if (gap < -20 || gap > 35 || Math.abs(a.y + a.height / 2 - b.y - b.height / 2) > 30) continue;
            const x = Math.max(0, a.x - 12);
            const y = Math.max(0, Math.min(a.y, b.y) - 12);
            const right = Math.min(imageWidth, Math.max(a.x + a.width, b.x + b.width) + 12);
            const bottom = Math.min(imageHeight, Math.max(a.y + a.height, b.y + b.height) + 12);
            const box = { x, y, width: right - x, height: bottom - y };
            if (box.width > 190 || box.height > 120) continue;
            if (recognizedItems.some((item) => intersectionArea(box, item.coords) / (box.width * box.height) > 0.4)) continue;
            const nearby = known.filter((item) => {
                const dx = box.x + box.width / 2 - item.coords.x - item.coords.width / 2;
                const dy = box.y + box.height / 2 - item.coords.y - item.coords.height / 2;
                return Math.abs(dx) >= 80 && Math.abs(dx) <= 350 && Math.abs(dy) <= 120;
            });
            if (nearby.length > 0) candidates.push({ box, renderBox: box, nearby });
        }
    }
    return candidates;
}

export function findSupplementalSmallEffects(standardBoxes, highResolutionBoxes, recognizedItems, imageWidth, imageHeight) {
    return highResolutionBoxes.flatMap((box) => {
        if (box.width < 80 || box.width > 170 || box.height < 50 || box.height > 130) return [];
        if (standardBoxes.some((standard) => intersectionArea(box, standard) / (box.width * box.height) > 0.6)) return [];
        if (recognizedItems.some((item) => intersectionArea(box, item.coords) / (box.width * box.height) > 0.45)) return [];
        const x = Math.max(0, box.x - 17);
        const y = Math.max(0, box.y - 20);
        return [{ x, y, width: Math.min(box.width + 38, imageWidth - x), height: Math.min(box.height + 40, imageHeight - y) }];
    });
}

export function findSupplementalTinyLabels(standardBoxes, highResolutionBoxes, recognizedItems, imageWidth, imageHeight) {
    return highResolutionBoxes.flatMap((box) => {
        if (box.width < 35 || box.width > 90 || box.height < 25 || box.height > 70) return [];
        if (standardBoxes.some((standard) => intersectionArea(box, standard) / (box.width * box.height) > 0.6)) return [];
        if (recognizedItems.some((item) => intersectionArea(box, item.coords) / (box.width * box.height) > 0.4)) return [];
        const x = Math.max(0, box.x - 15);
        const y = Math.max(0, box.y - 10);
        return [
            {
                box: { x, y, width: Math.min(box.width + 51, imageWidth - x), height: Math.min(box.height + 26, imageHeight - y) },
                textBox: box,
            },
        ];
    });
}
