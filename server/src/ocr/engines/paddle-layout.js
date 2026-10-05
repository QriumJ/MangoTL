import { createCanvas } from "ppu-ocv/canvas";

// CTC recognizers consume horizontal sequences. Japanese vertical glyphs are
// upright, so rotating the whole column is not equivalent to laying it out.
// Only image geometry/ink projections are used; no vocabulary or page IDs.
export function verticalStrip(crop) {
    const { width, height } = crop;
    const pixels = crop.getContext("2d").getImageData(0, 0, width, height).data;
    const rows = new Uint32Array(height);
    const columns = new Uint32Array(width);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (isInk(pixels, i)) {
                rows[y]++;
                columns[x]++;
            }
        }
    const inkColumns = runs(columns);
    if (!inkColumns.length) return null;
    const left = inkColumns[0][0],
        right = inkColumns.at(-1)[1];
    const glyphWidth = right - left;
    if (glyphWidth < 3 || height < glyphWidth * 1.8) return null;
    let segments = runs(rows);
    // Join separated strokes within one glyph; retain genuine character gaps.
    const joined = [];
    for (const segment of segments) {
        const prev = joined.at(-1);
        if (prev && segment[1] - prev[0] <= glyphWidth * 1.15 && (segment[0] - prev[1] < glyphWidth * 0.16 || prev[1] - prev[0] < glyphWidth * 0.35))
            prev[1] = segment[1];
        else joined.push([...segment]);
    }
    segments = [];
    for (const [start, end] of joined) {
        const n = Math.max(1, Math.round((end - start) / glyphWidth));
        let from = start;
        for (let i = 1; i < n; i++) {
            const expected = start + ((end - start) * i) / n;
            let cut = Math.round(expected),
                best = Infinity;
            for (let y = Math.max(from + 1, Math.round(expected - glyphWidth * 0.2)); y < Math.min(end, expected + glyphWidth * 0.2); y++) {
                const score = rows[y] + Math.abs(y - expected) * 0.05;
                if (score < best) {
                    best = score;
                    cut = y;
                }
            }
            segments.push([from, cut]);
            from = cut;
        }
        segments.push([from, end]);
    }
    if (segments.length < 2 || segments.length > 128) return null;
    const cell = Math.max(8, Math.ceil(glyphWidth));
    const strip = createCanvas(cell * segments.length + 8, cell + 8);
    const ctx = strip.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, strip.width, strip.height);
    segments.forEach(([top, bottom], i) => {
        const h = bottom - top;
        const scale = Math.min(1, cell / h);
        let minX = right,
            maxX = left,
            inkRows = 0;
        for (let y = top; y < bottom; y++) {
            let ink = false;
            for (let x = left; x < right; x++) {
                const p = (y * width + x) * 4;
                if (isInk(pixels, p)) {
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                    ink = true;
                }
            }
            if (ink) inkRows++;
        }
        // Japanese prolonged-sound marks turn vertical in vertical layout.
        // A continuous narrow stroke is restored without rewriting OCR text.
        if (maxX - minX + 1 <= cell * 0.28 && h >= cell * 0.55 && inkRows >= h * 0.9) {
            ctx.save();
            ctx.translate(4 + i * cell + cell / 2, 4 + cell / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.drawImage(crop, left, top, glyphWidth, h, (-glyphWidth * scale) / 2, (-h * scale) / 2, glyphWidth * scale, h * scale);
            ctx.restore();
        } else {
            ctx.drawImage(
                crop,
                left,
                top,
                glyphWidth,
                h,
                4 + i * cell + (cell - glyphWidth * scale) / 2,
                4 + (cell - h * scale) * (h < cell * 0.75 && maxX - minX + 1 < cell * 0.75 ? 1 : 0.5),
                glyphWidth * scale,
                h * scale,
            );
        }
    });
    return strip;
}
function isInk(pixels, index) {
    return pixels[index + 3] > 128 && pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114 < 160;
}

function runs(values) {
    const result = [];
    let start = null;
    for (let i = 0; i <= values.length; i++) {
        if (values[i] > 0) {
            if (start === null) start = i;
        } else if (start !== null) {
            result.push([start, i]);
            start = null;
        }
    }
    return result;
}

export async function recognizeJapaneseLayout(recognizer, detection, dictionary, { vertical = true } = {}) {
    const results = [];
    for (const box of detection.boxes) {
        const crop = recognizer.cropRegion(detection.canvas, box);
        const direct = await recognizer.recognizeText(crop, dictionary);
        let best = direct;
        let verticalLine = false;
        if (vertical && box.height > box.width * 1.5) {
            const strip = verticalStrip(crop);
            if (strip) {
                verticalLine = true;
                const candidate = await recognizer.recognizeText(strip, dictionary);
                // A vertically crushed read can be confidently one character.
                if (
                    candidate.text.trim().length >= 2 &&
                    candidate.confidence >= 0.45 &&
                    (candidate.confidence > direct.confidence || direct.text.trim().length < 2)
                )
                    best = candidate;
            }
        }
        results.push({ ...best, box, verticalLine });
    }
    return results;
}
