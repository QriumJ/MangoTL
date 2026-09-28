import { createCanvas } from "ppu-ocv/canvas";
import { makeScanCanvas } from "../../utils/scan-canvas.js";

// Find groups of isolated navy outline glyphs on pale manga backgrounds.
// Paddle's text detector misses this lettering because each stroke is hollow.
// The component scan runs on a downscaled working canvas; candidate boxes are
// scaled back to source coordinates. The internal `scale` factor already
// normalizes every threshold, so the same rules apply at the working size.
export function findOutlinedEffectCandidates(sourceCanvas, existingItems = []) {
    const { canvas, boxToSource } = makeScanCanvas(sourceCanvas, 1600);
    const width = canvas.width;
    const height = canvas.height;
    const scale = width / 2150;
    if (width < 900 || height < 900) return [];
    const { data } = canvas.getContext("2d").getImageData(0, 0, width, height);
    const ink = new Uint8Array(width * height);
    for (let index = 0; index < ink.length; index += 1) {
        const offset = index * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        ink[index] = red < 100 && green < 140 && blue < 190 && blue > red * 1.2 ? 1 : 0;
    }

    const visited = new Uint8Array(ink.length);
    const components = [];
    const largeComponents = [];
    for (let seed = 0; seed < ink.length; seed += 1) {
        if (!ink[seed] || visited[seed]) continue;
        const stack = [seed];
        visited[seed] = 1;
        let area = 0;
        let left = width;
        let top = height;
        let right = 0;
        let bottom = 0;
        while (stack.length > 0) {
            const index = stack.pop();
            const x = index % width;
            const y = Math.floor(index / width);
            area += 1;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
            for (const neighbor of [
                x > 0 ? index - 1 : -1,
                x < width - 1 ? index + 1 : -1,
                y > 0 ? index - width : -1,
                y < height - 1 ? index + width : -1,
            ]) {
                if (neighbor >= 0 && ink[neighbor] && !visited[neighbor]) {
                    visited[neighbor] = 1;
                    stack.push(neighbor);
                }
            }
        }
        const boxWidth = right - left + 1;
        const boxHeight = bottom - top + 1;
        if (
            area >= 140 * scale * scale &&
            area <= 1400 * scale * scale &&
            boxWidth >= 20 * scale &&
            boxWidth <= 130 * scale &&
            boxHeight >= 15 * scale &&
            boxHeight <= 160 * scale
        ) {
            components.push({ x: left, y: top, width: boxWidth, height: boxHeight });
        }
        if (
            area >= 600 * scale * scale &&
            area <= 6000 * scale * scale &&
            boxWidth >= 55 * scale &&
            boxWidth <= 190 * scale &&
            boxHeight >= 55 * scale &&
            boxHeight <= 185 * scale
        ) {
            largeComponents.push({ x: left, y: top, width: boxWidth, height: boxHeight });
        }
    }

    const candidates = groupOutlinedComponents(components, 65 * scale, 5, 8)
        .filter(
            (candidate) =>
                candidate.width >= 120 * scale &&
                candidate.width <= 250 * scale &&
                candidate.height >= 200 * scale &&
                candidate.height <= 350 * scale &&
                candidate.height / candidate.width >= 1.1,
        )
        .map((candidate) => ({ ...candidate, kind: "small" }));
    candidates.push(
        ...groupOutlinedComponents(largeComponents, 50 * scale, 3, 4)
            .filter(
                (candidate) =>
                    candidate.width >= 250 * scale &&
                    candidate.width <= 390 * scale &&
                    candidate.height >= 330 * scale &&
                    candidate.height <= 470 * scale &&
                    candidate.height / candidate.width >= 1.15,
            )
            .map((candidate) => ({ ...candidate, kind: "large" })),
    );
    // 겹침 검사는 원본 좌표계에서 해야 하므로 좌표 복원 후에 필터링한다
    return candidates
        .map((candidate) => ({ ...boxToSource(candidate), kind: candidate.kind }))
        .filter((candidate) => !existingItems.some((item) => overlapRatio(candidate, item.coords) > 0.2));
}

function groupOutlinedComponents(components, maxGap, minCount, maxCount) {
    const parent = components.map((_, index) => index);
    const find = (index) => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    for (let first = 0; first < components.length; first += 1) {
        for (let second = first + 1; second < components.length; second += 1) {
            const a = components[first];
            const b = components[second];
            const gapX = Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width);
            const gapY = Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height);
            if (Math.hypot(gapX, gapY) < maxGap) parent[find(second)] = find(first);
        }
    }

    const groups = new Map();
    for (let index = 0; index < components.length; index += 1) {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(components[index]);
    }
    const candidates = [];
    for (const members of groups.values()) {
        if (members.length < minCount || members.length > maxCount) continue;
        const x = Math.min(...members.map((box) => box.x));
        const y = Math.min(...members.map((box) => box.y));
        const right = Math.max(...members.map((box) => box.x + box.width));
        const bottom = Math.max(...members.map((box) => box.y + box.height));
        candidates.push({ x, y, width: right - x, height: bottom - y });
    }
    return candidates;
}

export function makeOutlinedEffectRecognitionCrop(canvas, box, angle = 25) {
    const pad = Math.max(12, Math.round(canvas.width * 0.01));
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const width = Math.min(canvas.width - x, box.width + pad * 2);
    const height = Math.min(canvas.height - y, box.height + pad * 2);
    const source = canvas.getContext("2d").getImageData(x, y, width, height);
    const mask = outlinedGlyphMask(source.data, width, height);
    const result = createCanvas(650, 650);
    const ctx = result.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 650, 650);
    const blackWhite = createCanvas(width, height);
    const pixels = blackWhite.getContext("2d").createImageData(width, height);
    for (let index = 0; index < mask.length; index += 1) {
        const value = mask[index] ? 0 : 255;
        const offset = index * 4;
        pixels.data[offset] = value;
        pixels.data[offset + 1] = value;
        pixels.data[offset + 2] = value;
        pixels.data[offset + 3] = 255;
    }
    blackWhite.getContext("2d").putImageData(pixels, 0, 0);
    ctx.translate(325, 325);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(blackWhite, -width / 2, -height / 2);
    return result;
}

export function outlinedGlyphMask(data, width, height) {
    const stroke = new Uint8Array(width * height);
    for (let index = 0; index < stroke.length; index += 1) {
        const offset = index * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        stroke[index] = red < 100 && green < 140 && blue < 190 && blue > red * 1.2 ? 1 : 0;
    }
    const closed = stroke.slice();
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            const index = y * width + x;
            if (!stroke[index]) continue;
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) closed[index + dy * width + dx] = 1;
            }
        }
    }
    const outside = new Uint8Array(width * height);
    const stack = [];
    for (let x = 0; x < width; x += 1) {
        for (const index of [x, (height - 1) * width + x]) {
            if (!closed[index] && !outside[index]) {
                outside[index] = 1;
                stack.push(index);
            }
        }
    }
    for (let y = 0; y < height; y += 1) {
        for (const index of [y * width, y * width + width - 1]) {
            if (!closed[index] && !outside[index]) {
                outside[index] = 1;
                stack.push(index);
            }
        }
    }
    while (stack.length > 0) {
        const index = stack.pop();
        const x = index % width;
        const y = Math.floor(index / width);
        for (const neighbor of [
            x > 0 ? index - 1 : -1,
            x < width - 1 ? index + 1 : -1,
            y > 0 ? index - width : -1,
            y < height - 1 ? index + width : -1,
        ]) {
            if (neighbor >= 0 && !closed[neighbor] && !outside[neighbor]) {
                outside[neighbor] = 1;
                stack.push(neighbor);
            }
        }
    }
    const filled = new Uint8Array(width * height);
    for (let index = 0; index < filled.length; index += 1) filled[index] = closed[index] || !outside[index] ? 1 : 0;
    return filled;
}

function overlapRatio(a, b) {
    if (!b) return 0;
    const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return (width * height) / Math.max(1, a.width * a.height);
}

// An outlined effect read is accepted only when it is a short kana effect;
// anything else is discarded rather than guessed.
export function normalizeOutlinedEffect(text) {
    const compact = String(text || "").replace(/[\s.。…!！?？]/gu, "");
    return /^[\p{Script=Hiragana}\p{Script=Katakana}ーっッ]{2,5}$/u.test(compact) ? compact : null;
}
