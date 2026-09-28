import { intersectionArea } from "../../utils/geometry.js";

// Flower-shaped name badges have pale colored borders and small white labels.
// An occluded, single-character label can be too small for the text detector.
// Locate only badges whose color and size match another readable badge on the
// page, then ask a second recognizer to read two overlapping crops.
export function findUnrecognizedPastelBadges(canvas, recognizedItems) {
    const knownNames = recognizedItems
        .filter((item) => item.tinyLabel && /^[\p{Script=Hiragana}\p{Script=Katakana}]{2,6}$/u.test(item.text))
        .map((item) => item.text);
    if (knownNames.length === 0) return [];

    const step = 4;
    const width = Math.ceil(canvas.width / step);
    const height = Math.ceil(canvas.height / step);
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (Math.min(canvas.height - 1, y * step + 2) * canvas.width + Math.min(canvas.width - 1, x * step + 2)) * 4;
            const red = pixels[offset];
            const green = pixels[offset + 1];
            const blue = pixels[offset + 2];
            if (red > 245 && green > 180 && green < 225 && blue > 190 && blue < 240 && blue > green + 8 && red > green + 35) {
                mask[y * width + x] = 1;
            }
        }
    }

    const components = [];
    for (let origin = 0; origin < mask.length; origin += 1) {
        if (mask[origin] !== 1) continue;
        const queue = [origin];
        mask[origin] = 2;
        let left = width;
        let top = height;
        let right = 0;
        let bottom = 0;
        for (let index = 0; index < queue.length; index += 1) {
            const current = queue[index];
            const x = current % width;
            const y = Math.floor(current / width);
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
            for (const next of [current - 1, current + 1, current - width, current + width]) {
                if (next < 0 || next >= mask.length || mask[next] !== 1 || Math.abs((next % width) - x) > 1) continue;
                mask[next] = 2;
                queue.push(next);
            }
        }
        const badge = { x: left * step, y: top * step, width: (right - left + 1) * step, height: (bottom - top + 1) * step };
        if (queue.length >= 250 && badge.width >= 80 && badge.width <= 260 && badge.height >= 100 && badge.height <= 300) {
            components.push(badge);
        }
    }

    return components
        .filter(
            (badge) =>
                !recognizedItems.some(
                    (item) => /\p{L}/u.test(item.text) && intersectionArea(badge, item.coords) > item.coords.width * item.coords.height * 0.3,
                ),
        )
        .slice(0, 8)
        .map((badge) => {
            const crop = (x, y, width, height) => ({
                x: Math.round(badge.x + badge.width * x),
                y: Math.round(badge.y + badge.height * y),
                width: Math.round(badge.width * width),
                height: Math.round(badge.height * height),
            });
            return { badge, crops: [crop(0.4, 0.2, 0.64, 0.34), crop(0.44, 0.25, 0.43, 0.24)], knownNames };
        });
}

export function matchingPastelBadgeRead(reads, knownNames) {
    if (reads.length !== 2 || reads.some((read) => read.confidence < 0.85)) return null;
    const text = String(reads[0].text || "").trim();
    if (!/^[\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text) || text !== String(reads[1].text || "").trim()) return null;
    if (!knownNames.some((name) => name.startsWith(text))) return null;
    return text;
}
