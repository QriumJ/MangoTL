import { intersectionArea } from "../utils/geometry.js";
export function groupTextBlocks(ocrItems) {
    const usableItems = ocrItems.map(normalizeOcrItem).filter((item) => item.text && item.coords);

    const groups = [];

    for (const item of usableItems.sort(readingSort)) {
        const existingGroup = groups.find((group) => shouldJoinGroup(group, item));

        if (existingGroup) {
            existingGroup.items.push(item);
            existingGroup.coords = mergeRects([existingGroup.coords, item.coords]);
            continue;
        }

        groups.push({
            items: [item],
            coords: item.coords,
        });
    }

    return removeDuplicateBlocks(groups.map((group, index) => toTextBlock(group, index)))
        .sort(readingSort)
        .map((block, index) => ({
            ...block,
            order: index + 1,
        }));
}

function removeDuplicateBlocks(blocks) {
    const kept = [];
    const byQuality = [...blocks].sort((a, b) => blockQuality(b) - blockQuality(a));

    for (const block of byQuality) {
        if (!kept.some((candidate) => isDuplicateBlock(candidate, block))) {
            kept.push(block);
        }
    }

    return kept;
}

function blockQuality(block) {
    const letters = [...block.sourceText].filter((character) => /\p{L}|\p{N}/u.test(character)).length;
    return (block.confidence ?? 0.8) * 2 + Math.min(letters, 40) / 40;
}

function isDuplicateBlock(a, b) {
    const areaA = a.coords.width * a.coords.height;
    const areaB = b.coords.width * b.coords.height;
    const overlap = intersectionArea(a.coords, b.coords);
    if (overlap / Math.min(areaA, areaB) < 0.72) {
        return false;
    }

    const textA = [...a.sourceText.replace(/\s|[、。・.…!?！？「」『』]/gu, "")];
    const textB = [...b.sourceText.replace(/\s|[、。・.…!?！？「」『』]/gu, "")];
    const shorter = textA.length <= textB.length ? textA : textB;
    const longer = shorter === textA ? textB : textA;
    if (shorter.length < 5) {
        return false;
    }

    const shared = longestCommonSubsequence(shorter, longer) / shorter.length;
    if (shared >= 0.7) {
        return true;
    }

    const smaller = areaA <= areaB ? a : b;
    const larger = smaller === a ? b : a;
    return (
        shared >= 0.55 && Math.max(areaA, areaB) / Math.min(areaA, areaB) >= 2 && (smaller.confidence ?? 1) < 0.82 && (larger.confidence ?? 0) >= 0.9
    );
}

function longestCommonSubsequence(a, b) {
    let previous = new Uint16Array(b.length + 1);
    for (const character of a) {
        const current = new Uint16Array(b.length + 1);
        for (let index = 0; index < b.length; index += 1) {
            current[index + 1] = character === b[index] ? previous[index] + 1 : Math.max(previous[index + 1], current[index]);
        }
        previous = current;
    }
    return previous[b.length];
}

function normalizeOcrItem(item, index) {
    return {
        id: item.id || `ocr-${index + 1}`,
        text: String(item.text || "").trim(),
        confidence: typeof item.confidence === "number" ? item.confidence : null,
        coords: normalizeRect(item.coords),
        eraseCoords: normalizeRect(item.eraseCoords),
        darkBox: normalizeRect(item.darkBox),
        standalone: Boolean(item.standalone),
        confirmedRepeatedEffect: Boolean(item.confirmedRepeatedEffect),
        footstepEffect: Boolean(item.footstepEffect),
        tinyLabel: Boolean(item.tinyLabel),
        pastelBadge: Boolean(item.pastelBadge),
        outlinedEffect: Boolean(item.outlinedEffect),
        insetHandwritten: Boolean(item.insetHandwritten),
        largeOutlinedEffect: Boolean(item.largeOutlinedEffect),
    };
}

function normalizeRect(rect) {
    if (!rect) {
        return null;
    }

    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);

    if (![x, y, width, height].every(Number.isFinite)) {
        return null;
    }

    return {
        x,
        y,
        width: Math.max(1, width),
        height: Math.max(1, height),
    };
}

function shouldJoinGroup(group, item) {
    const rect = group.coords;
    if (item.standalone || group.items.some((part) => part.standalone)) {
        return false;
    }
    if (Boolean(group.items.some((part) => part.darkBox)) !== Boolean(item.darkBox)) {
        return false;
    }
    // OCR often returns one full speech bubble plus smaller reads inside it.
    // Joining the smaller read repeats characters and can pull in artwork text.
    if (containsMostOfSmaller(rect, item.coords)) {
        return false;
    }
    // A horizontal reading-direction note immediately above a tall speech
    // balloon can touch its OCR box. They are separate surfaces and speakers.
    const horizontalStrip = (box) => box.width > 400 && box.height < 90 && box.width > box.height * 5;
    const tallBalloonText = (box) => box.height > 250 && box.height > box.width * 0.9;
    if ((horizontalStrip(rect) && tallBalloonText(item.coords)) || (horizontalStrip(item.coords) && tallBalloonText(rect))) {
        return false;
    }

    const groupLength = group.items.reduce((total, part) => total + [...part.text.replace(/\s+/g, "")].length, 0);
    const itemLength = [...item.text.replace(/\s+/g, "")].length;
    const areaRatio =
        Math.max(rect.width * rect.height, item.coords.width * item.coords.height) /
        Math.max(1, Math.min(rect.width * rect.height, item.coords.width * item.coords.height));

    if (areaRatio >= 3 && ((groupLength <= 3 && itemLength >= 8) || (itemLength <= 3 && groupLength >= 8))) {
        return false;
    }

    const gapX = horizontalGap(rect, item.coords);
    const gapY = verticalGap(rect, item.coords);
    const xOverlap = overlapRatio(rect.x, rect.x + rect.width, item.coords.x, item.coords.x + item.coords.width);
    const yOverlap = overlapRatio(rect.y, rect.y + rect.height, item.coords.y, item.coords.y + item.coords.height);
    if (
        rect.height < 120 &&
        item.coords.height < 120 &&
        rect.width > 180 &&
        item.coords.width > 180 &&
        xOverlap < 0.1 &&
        gapX > Math.min(24, Math.min(rect.height, item.coords.height) * 0.25)
    ) {
        return false;
    }
    const veryDifferentHeights = Math.max(rect.height, item.coords.height) / Math.max(1, Math.min(rect.height, item.coords.height)) > 2;
    if (xOverlap < 0.25 && yOverlap < 0.9 && veryDifferentHeights && Math.min(rect.height, item.coords.height) > 180) {
        return false;
    }
    // Only bridge gaps the size of normal line-leading / word-spacing. A wider
    // gap means a separate element (e.g. a date stamp above a speech bubble),
    // which must stay its own block rather than being merged into the dialogue.
    const maxGap = Math.max(17, Math.min(rect.height, item.coords.height) * 0.7);
    const maxHorizontalGap = Math.max(17, Math.min(70, Math.min(rect.width, item.coords.width) * 0.5));

    if (group.items.some((part) => isTallTextRegion(part.coords, [part])) && isTallTextRegion(item.coords, [item])) {
        return false;
    }

    return (xOverlap > 0.35 && gapY <= maxGap) || (yOverlap > 0.35 && gapX <= maxHorizontalGap);
}

function containsMostOfSmaller(a, b) {
    const intersectionWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const intersectionHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const smallerArea = Math.min(a.width * a.height, b.width * b.height);
    const largerArea = Math.max(a.width * a.height, b.width * b.height);

    return largerArea / smallerArea >= 3 && (intersectionWidth * intersectionHeight) / smallerArea >= 0.75;
}

function horizontalGap(a, b) {
    if (a.x <= b.x + b.width && b.x <= a.x + a.width) {
        return 0;
    }

    return Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
}

function verticalGap(a, b) {
    if (a.y <= b.y + b.height && b.y <= a.y + a.height) {
        return 0;
    }

    return Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
}

function overlapRatio(aStart, aEnd, bStart, bEnd) {
    const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
    const shortest = Math.min(aEnd - aStart, bEnd - bStart);
    return shortest > 0 ? overlap / shortest : 0;
}

function toTextBlock(group, index) {
    const direction = group.coords.height > group.coords.width * 1.25 ? "vertical" : "horizontal";
    const sortedItems = [...group.items].sort(direction === "vertical" ? topToBottomSort : readingSort);
    const sourceText = sortedItems.map((item) => item.text).join(direction === "vertical" ? "" : "\n");
    const confidenceValues = group.items.map((item) => item.confidence).filter((value) => value !== null);

    return {
        id: `block-${index + 1}`,
        sourceText,
        coords: roundRect(group.coords),
        type: group.items.some((item) => item.standalone) ? "sfx" : classifyText(sourceText, group.coords),
        direction,
        confidence: confidenceValues.length ? confidenceValues.reduce((total, value) => total + value, 0) / confidenceValues.length : null,
        sourceBlockIds: group.items.map((item) => item.id),
        darkBox: group.items.find((item) => item.darkBox)?.darkBox || null,
        eraseCoords: group.items.find((item) => item.eraseCoords)?.eraseCoords || null,
        standalone: group.items.some((item) => item.standalone),
        tinyLabel: group.items.some((item) => item.tinyLabel),
        confirmedRepeatedEffect: group.items.some((item) => item.confirmedRepeatedEffect),
        footstepEffect: group.items.some((item) => item.footstepEffect),
        pastelBadge: group.items.some((item) => item.pastelBadge),
        outlinedEffect: group.items.some((item) => item.outlinedEffect),
        insetHandwritten: group.items.some((item) => item.insetHandwritten),
        largeOutlinedEffect: group.items.some((item) => item.largeOutlinedEffect),
    };
}

function classifyText(text, coords) {
    const compact = text.replace(/\s+/g, "");

    if (
        compact.length <= 4 &&
        !/\p{Script=Han}/u.test(compact) &&
        Math.max(coords.width, coords.height) > Math.min(coords.width, coords.height) * 2.5
    ) {
        return "sfx";
    }

    if (/^[!?！？…ー~〜]+$/.test(compact)) {
        return "sfx";
    }

    if (/^[\p{Script=Katakana}ーっッ]{2,4}$/u.test(compact)) {
        return "sfx";
    }

    return "dialogue";
}

function isTallTextRegion(rect, items) {
    const textLength = items.reduce((total, item) => total + String(item.text || "").replace(/\s+/g, "").length, 0);
    return rect.height > rect.width * 1.15 && textLength >= 4;
}

function readingSort(a, b) {
    const aRect = a.coords;
    const bRect = b.coords;
    const sameColumn = Math.abs(centerX(aRect) - centerX(bRect)) < Math.max(aRect.width, bRect.width) * 0.85;
    const sameBand = Math.abs(centerY(aRect) - centerY(bRect)) < Math.max(aRect.height, bRect.height) * 0.6;

    if (sameColumn) {
        return aRect.y - bRect.y;
    }

    if (sameBand) {
        return bRect.x - aRect.x;
    }

    return aRect.y - bRect.y;
}

function topToBottomSort(a, b) {
    return a.coords.y - b.coords.y;
}

function centerX(rect) {
    return rect.x + rect.width / 2;
}

function centerY(rect) {
    return rect.y + rect.height / 2;
}

function mergeRects(rects) {
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

function roundRect(rect) {
    return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
}
