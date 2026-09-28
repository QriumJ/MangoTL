import { createCanvas } from "ppu-ocv/canvas";
import { makeScanCanvas } from "../../../utils/scan-canvas.js";

// Find white lettering enclosed by a dark speech balloon or effect shape.
// The lettering is copied onto a plain white canvas as black ink so manga-ocr
// can read it without the surrounding shape or artwork.
// The scan runs on a downscaled working canvas; the mask canvas stays at
// working resolution (manga-ocr resizes crops anyway) while the returned
// boxes are scaled back to source coordinates.
export function detectDarkTextRegions(sourceCanvas) {
    const { canvas, scale: pixelScale, boxToSource } = makeScanCanvas(sourceCanvas, 1400);
    const width = canvas.width;
    const height = canvas.height;
    const { data } = canvas.getContext("2d").getImageData(0, 0, width, height);
    const regions = [];
    const isDark = (index) => {
        const offset = index * 4;
        return data[offset] < 80 && data[offset + 1] < 80 && data[offset + 2] < 80;
    };
    const isRose = (index) => {
        const offset = index * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        return (
            red >= 130 && red <= 205 && green >= 70 && green <= 155 && blue >= 70 && blue <= 160 && red - green >= 30 && Math.abs(green - blue) <= 30
        );
    };

    for (const isBackground of [isDark, isRose]) {
        regions.push(...findRegions(data, width, height, isBackground, isBackground === isRose, pixelScale));
    }

    return regions.map((region) => ({ ...region, darkBox: boxToSource(region.darkBox), glyphBox: boxToSource(region.glyphBox) }));
}

function findRegions(data, width, height, isBackground, extractDarkCore, pixelScale) {
    const imageArea = width * height;
    const visited = new Uint8Array(imageArea);
    const regions = [];

    for (let seed = 0; seed < imageArea; seed += 1) {
        if (visited[seed] || !isBackground(seed)) {
            continue;
        }
        const stack = [seed];
        visited[seed] = 1;
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;
        let area = 0;
        while (stack.length) {
            const index = stack.pop();
            const x = index % width;
            const y = (index / width) | 0;
            area += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            for (const neighbor of [
                x > 0 ? index - 1 : -1,
                x + 1 < width ? index + 1 : -1,
                y > 0 ? index - width : -1,
                y + 1 < height ? index + width : -1,
            ]) {
                if (neighbor >= 0 && !visited[neighbor] && isBackground(neighbor)) {
                    visited[neighbor] = 1;
                    stack.push(neighbor);
                }
            }
        }

        const region = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
        const boxArea = region.width * region.height;
        // 픽셀 수 임계값은 스캔 해상도에 맞춰 스케일한다
        if (
            area < 5000 * pixelScale * pixelScale ||
            boxArea > imageArea * (extractDarkCore ? 0.25 : 0.14) ||
            region.width < 80 * pixelScale ||
            region.height < 120 * pixelScale ||
            region.width / region.height >= 0.8 ||
            area / boxArea <= 0.2
        ) {
            continue;
        }

        const text = makeLightLetterMask(data, width, region, isBackground, extractDarkCore, pixelScale);
        if (text) {
            regions.push({ ...text, darkBox: region });
        }
    }

    return regions;
}

function makeLightLetterMask(data, imageWidth, region, isDark, extractDarkCore, pixelScale) {
    const { x, y, width, height } = region;
    const seen = new Uint8Array(width * height);
    const selected = new Uint8Array(width * height);
    let holeCount = 0;
    let selectedCount = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    const glyphs = [];

    for (let seed = 0; seed < seen.length; seed += 1) {
        const sx = seed % width;
        const sy = (seed / width) | 0;
        if (seen[seed] || isDark((y + sy) * imageWidth + x + sx)) {
            continue;
        }
        const stack = [seed];
        const pixels = [];
        seen[seed] = 1;
        let touchesEdge = false;
        let bright = 0;
        while (stack.length) {
            const index = stack.pop();
            const px = index % width;
            const py = (index / width) | 0;
            const global = (y + py) * imageWidth + x + px;
            const offset = global * 4;
            pixels.push(index);
            touchesEdge ||= px === 0 || py === 0 || px === width - 1 || py === height - 1;
            bright += data[offset] > 200 && data[offset + 1] > 200 && data[offset + 2] > 200 ? 1 : 0;
            for (const neighbor of [
                px > 0 ? index - 1 : -1,
                px + 1 < width ? index + 1 : -1,
                py > 0 ? index - width : -1,
                py + 1 < height ? index + width : -1,
            ]) {
                if (neighbor < 0 || seen[neighbor]) {
                    continue;
                }
                const nx = neighbor % width;
                const ny = (neighbor / width) | 0;
                if (!isDark((y + ny) * imageWidth + x + nx)) {
                    seen[neighbor] = 1;
                    stack.push(neighbor);
                }
            }
        }
        if (touchesEdge || pixels.length < 15 * pixelScale * pixelScale || bright / pixels.length <= (extractDarkCore ? 0.6 : 0.65)) {
            continue;
        }
        holeCount += 1;
        let glyphMinX = width;
        let glyphMinY = height;
        let glyphMaxX = 0;
        let glyphMaxY = 0;
        for (const index of pixels) {
            const px = index % width;
            const py = (index / width) | 0;
            selected[index] = 1;
            selectedCount += 1;
            minX = Math.min(minX, px);
            minY = Math.min(minY, py);
            maxX = Math.max(maxX, px);
            maxY = Math.max(maxY, py);
            glyphMinX = Math.min(glyphMinX, px);
            glyphMinY = Math.min(glyphMinY, py);
            glyphMaxX = Math.max(glyphMaxX, px);
            glyphMaxY = Math.max(glyphMaxY, py);
        }
        glyphs.push({ minX: glyphMinX, minY: glyphMinY, maxX: glyphMaxX, maxY: glyphMaxY });
    }

    if (holeCount < 4 || selectedCount < 300 * pixelScale * pixelScale) {
        return null;
    }
    if (extractDarkCore) {
        selected.fill(0);
        for (const glyph of glyphs) {
            for (let py = glyph.minY; py <= glyph.maxY; py += 1) {
                for (let px = glyph.minX; px <= glyph.maxX; px += 1) {
                    const offset = ((y + py) * imageWidth + x + px) * 4;
                    if (data[offset] < 100 && data[offset + 1] < 100 && data[offset + 2] < 100) {
                        selected[py * width + px] = 1;
                    }
                }
            }
        }
    }
    const padding = 20 * pixelScale;
    const left = Math.max(0, minX - padding);
    const top = Math.max(0, minY - padding);
    const right = Math.min(width, maxX + padding + 1);
    const bottom = Math.min(height, maxY + padding + 1);
    const maskCanvas = createCanvas(right - left, bottom - top);
    const ctx = maskCanvas.getContext("2d");
    const mask = ctx.createImageData(right - left, bottom - top);
    for (let py = top; py < bottom; py += 1) {
        for (let px = left; px < right; px += 1) {
            const target = ((py - top) * maskCanvas.width + px - left) * 4;
            const value = selected[py * width + px] ? 0 : 255;
            mask.data[target] = value;
            mask.data[target + 1] = value;
            mask.data[target + 2] = value;
            mask.data[target + 3] = 255;
        }
    }
    ctx.putImageData(mask, 0, 0);
    return {
        canvas: maskCanvas,
        glyphBox: { x: x + left, y: y + top, width: right - left, height: bottom - top },
    };
}
