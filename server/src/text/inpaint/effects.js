import { cv } from "ppu-ocv";
import { outlinedGlyphMask } from "./outlined-mask.js";
import { eraseOutlinedArtCaption } from "../art-caption.js";
import { clamp, parseHexColor } from "./shared.js";

// Erasers for blocks flagged as outlined effects. Each returns
// true when it handled the block so the caller can skip the generic path.
export function eraseOutlinedFootstep(ctx, canvasWidth, canvasHeight, block) {
    const box = block.eraseCoords || block.coords;
    const pad = 5;
    const x = clamp(Math.round(box.x - pad), 0, canvasWidth - 1);
    const y = clamp(Math.round(box.y - pad), 0, canvasHeight - 1);
    const width = clamp(Math.round(box.width + pad * 2), 1, canvasWidth - x);
    const height = clamp(Math.round(box.height + pad * 2), 1, canvasHeight - y);
    if (width < 80 || height < 65) return false;
    const image = ctx.getImageData(x, y, width, height);
    const color = (column, row) => {
        const offset = (row * width + column) * 4;
        return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    };
    const lightness = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3;
    const leftTop = color(2, 2);
    const leftBottom = color(2, height - 3);
    const rightTop = color(width - 3, 2);
    const rightBottom = color(width - 3, height - 3);
    const dark = [leftTop, leftBottom].map(lightness);
    const bright = [rightTop, rightBottom].map(lightness);
    const twoTone = dark.every((value) => value >= 75 && value <= 155) && bright.every((value) => value >= 225);
    const boundary = (row) => {
        for (let column = 3; column < width - 3; column += 1) {
            if (lightness(color(column, row)) >= 200 && lightness(color(column - 3, row)) <= 160) return column;
        }
        return null;
    };
    const upper = twoTone ? boundary(2) : null;
    const lower = twoTone ? boundary(height - 3) : null;
    if (twoTone && upper !== null && lower !== null && Math.abs(upper - lower) <= height * 0.6) {
        const gray = leftTop.map((channel, index) => Math.round((channel + leftBottom[index]) / 2));
        const white = rightTop.map((channel, index) => Math.round((channel + rightBottom[index]) / 2));
        for (let row = 0; row < height; row += 1) {
            const edge = upper + ((lower - upper) * row) / Math.max(1, height - 1);
            for (let column = 0; column < width; column += 1) {
                const blend = Math.max(0, Math.min(1, (column - edge + 1) / 2));
                const offset = (row * width + column) * 4;
                for (let channel = 0; channel < 3; channel += 1) {
                    image.data[offset + channel] = Math.round(gray[channel] * (1 - blend) + white[channel] * blend);
                }
            }
        }
    } else {
        const corners = [leftTop, leftBottom, rightTop, rightBottom];
        const values = corners.map(lightness).sort((a, b) => a - b);
        if (values[2] - values[0] > 25 || values[2] < 70 || values[2] > 170) return false;
        const background = leftTop.map((_, channel) => Math.round(corners.map((rgb) => rgb[channel]).sort((a, b) => a - b)[1]));
        for (let index = 0; index < width * height; index += 1) {
            const offset = index * 4;
            for (let channel = 0; channel < 3; channel += 1) image.data[offset + channel] = background[channel];
        }
    }
    ctx.putImageData(image, x, y);
    return true;
}

export function eraseSplitEffectInk(ctx, canvasWidth, canvasHeight, block) {
    if (typeof cv.Mat !== "function" || typeof cv.inpaint !== "function") return false;
    const box = block.eraseCoords || block.coords;
    if (box.width < 115 || box.width > 170 || box.height < 55 || box.height > 100) return false;
    const x = clamp(Math.round(box.x), 0, canvasWidth - 1);
    const y = clamp(Math.round(box.y), 0, canvasHeight - 1);
    const width = clamp(Math.round(box.width), 1, canvasWidth - x);
    const height = clamp(Math.round(box.height), 1, canvasHeight - y);
    const image = ctx.getImageData(x, y, width, height);
    const { data } = image;
    const brightness = (column, row) => {
        const index = (row * width + column) * 4;
        return (data[index] + data[index + 1] + data[index + 2]) / 3;
    };
    if (brightness(15, 4) < 180 || brightness(width - 15, 4) > 140) return false;
    const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
    const resources = [mask];
    try {
        const split = Math.round(width * 0.47);
        for (let row = 7; row < height - 7; row += 1) {
            for (let column = 8; column < width - 8; column += 1) {
                const index = row * width + column;
                const offset = index * 4;
                const red = data[offset];
                const green = data[offset + 1];
                const blue = data[offset + 2];
                const blackOnLight = column < split && Math.max(red, green, blue) < 85;
                const whiteOnDark = column >= split && Math.min(red, green, blue) > 220;
                if (blackOnLight || whiteOnDark) mask.data[index] = 255;
            }
        }
        const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
        const dilated = new cv.Mat();
        const source = cv.matFromImageData(image);
        const rgb = new cv.Mat();
        const output = new cv.Mat();
        resources.push(kernel, dilated, source, rgb, output);
        cv.dilate(mask, dilated, kernel);
        cv.cvtColor(source, rgb, cv.COLOR_RGBA2RGB);
        cv.inpaint(rgb, dilated, output, 4, cv.INPAINT_TELEA);
        for (let row = 7; row < height - 7; row += 1) {
            const surface = (row * width + width - 10) * 4;
            for (let column = split + 6; column < width - 9; column += 1) {
                const index = (row * width + column) * 3;
                const lightness = (output.data[index] + output.data[index + 1] + output.data[index + 2]) / 3;
                if (lightness <= 90) continue;
                for (let channel = 0; channel < 3; channel += 1) output.data[index + channel] = data[surface + channel];
            }
        }
        for (let index = 0; index < width * height; index += 1) {
            const from = index * 3;
            const to = index * 4;
            data[to] = output.data[from];
            data[to + 1] = output.data[from + 1];
            data[to + 2] = output.data[from + 2];
        }
        ctx.putImageData(image, x, y);
        return true;
    } finally {
        for (const resource of resources) resource.delete();
    }
}

export function erasePastelBadgeInk(ctx, canvasWidth, canvasHeight, block) {
    const box = block.eraseCoords || block.coords;
    const topY = clamp(Math.round(box.y - 20), 0, canvasHeight - 1);
    const bottomY = clamp(Math.round(box.y + box.height + 20), 0, canvasHeight - 1);
    const left = clamp(Math.round(box.x - 12), 0, canvasWidth - 1);
    const right = clamp(Math.round(box.x + box.width + 40), 0, canvasWidth - 1);
    const strip = ctx.getImageData(left, topY, right - left + 1, bottomY - topY + 1);
    const darkRun = (row, start, end) => {
        const values = [];
        for (let x = start; x <= end; x += 1) {
            const offset = (row * strip.width + x - left) * 4;
            if (Math.max(strip.data[offset], strip.data[offset + 1], strip.data[offset + 2]) < 110) values.push(x);
        }
        return values;
    };
    const upper = darkRun(0, Math.round(box.x + box.width * 0.75), right);
    const lower = darkRun(strip.height - 1, left, Math.round(box.x + box.width * 0.55));
    if (upper.length === 0 || lower.length === 0) return false;
    const topX = upper[Math.floor(upper.length / 2)];
    const bottomX = lower[Math.floor(lower.length / 2)];
    if (topX - bottomX < 25 || topX - bottomX > strip.height * 1.1) return false;

    const eraseLeft = clamp(Math.round(box.x), 0, canvasWidth - 1);
    const eraseRight = clamp(Math.round(box.x + box.width), 0, canvasWidth - 1);
    const eraseTop = clamp(Math.round(box.y), 0, canvasHeight - 1);
    const eraseBottom = clamp(Math.round(box.y + box.height), 0, canvasHeight - 1);
    for (let y = eraseTop; y <= eraseBottom; y += 1) {
        const sleeveX = topX + ((bottomX - topX) * (y - topY)) / (bottomY - topY);
        for (let x = eraseLeft; x <= Math.min(eraseRight, sleeveX - 4); x += 1) {
            const offset = ((y - topY) * strip.width + x - left) * 4;
            if (Math.min(strip.data[offset], strip.data[offset + 1], strip.data[offset + 2]) >= 252) continue;
            // Keep the colored flower and its outline; only clear the ink on
            // the white paper label to the left of the diagonal sleeve edge.
            if (strip.data[offset] - strip.data[offset + 1] > 25 && strip.data[offset + 2] - strip.data[offset + 1] > 5) continue;
            strip.data[offset] = 255;
            strip.data[offset + 1] = 255;
            strip.data[offset + 2] = 255;
        }
    }
    ctx.putImageData(strip, left, topY);
    return true;
}

export function eraseOutlinedEffectInk(ctx, canvasWidth, canvasHeight, block) {
    const box = block.eraseCoords || block.coords;
    const pad = Math.max(12, Math.round(canvasWidth * 0.01));
    const x = Math.max(0, Math.round(box.x - pad));
    const y = Math.max(0, Math.round(box.y - pad));
    const width = Math.min(canvasWidth - x, Math.round(box.width + pad * 2));
    const height = Math.min(canvasHeight - y, Math.round(box.height + pad * 2));
    if (width < 20 || height < 20) return false;
    const image = ctx.getImageData(x, y, width, height);
    const mask = outlinedGlyphMask(image.data, width, height);
    dilateMask(mask, width, height, 3);
    if (block.largeOutlinedEffect) {
        restoreLargeOutlinedBackground(image.data, mask, width, height);
        ctx.putImageData(image, x, y);
        return true;
    }
    const original = image.data.slice();
    for (let row = 0; row < height; row += 1) {
        let column = 0;
        while (column < width) {
            if (!mask[row * width + column]) {
                column += 1;
                continue;
            }
            const start = column;
            while (column < width && mask[row * width + column]) column += 1;
            const end = column - 1;
            const left = start - 1;
            const right = column;
            for (let px = start; px <= end; px += 1) {
                const offset = (row * width + px) * 4;
                for (let channel = 0; channel < 3; channel += 1) {
                    const leftColor =
                        left >= 0
                            ? original[(row * width + left) * 4 + channel]
                            : right < width
                              ? original[(row * width + right) * 4 + channel]
                              : 255;
                    const rightColor = right < width ? original[(row * width + right) * 4 + channel] : leftColor;
                    image.data[offset + channel] = Math.round(leftColor + ((rightColor - leftColor) * (px - left)) / Math.max(1, right - left));
                }
            }
        }
    }
    ctx.putImageData(image, x, y);
    return true;
}

function restoreLargeOutlinedBackground(data, mask, width, height) {
    const original = data.slice();
    const visited = new Uint8Array(mask.length);
    const brightness = (index) => (original[index * 4] + original[index * 4 + 1] + original[index * 4 + 2]) / 3;
    for (let seed = 0; seed < mask.length; seed += 1) {
        if (!mask[seed] || visited[seed]) continue;
        const pixels = [];
        const stack = [seed];
        visited[seed] = 1;
        let lightBorder = 0;
        let darkBorder = 0;
        while (stack.length > 0) {
            const index = stack.pop();
            pixels.push(index);
            const px = index % width;
            const py = Math.floor(index / width);
            for (const neighbor of [
                px > 0 ? index - 1 : -1,
                px < width - 1 ? index + 1 : -1,
                py > 0 ? index - width : -1,
                py < height - 1 ? index + width : -1,
            ]) {
                if (neighbor < 0) continue;
                if (mask[neighbor]) {
                    if (!visited[neighbor]) {
                        visited[neighbor] = 1;
                        stack.push(neighbor);
                    }
                } else if (brightness(neighbor) > 150) {
                    lightBorder += 1;
                } else {
                    darkBorder += 1;
                }
            }
        }
        const componentLight = lightBorder > darkBorder;
        for (const index of pixels) {
            const px = index % width;
            const py = Math.floor(index / width);
            let left = px;
            let right = px;
            while (left >= 0 && mask[py * width + left]) left -= 1;
            while (right < width && mask[py * width + right]) right += 1;
            const leftIsLight = left >= 0 && brightness(py * width + left) > 150;
            const rightIsLight = right < width && brightness(py * width + right) > 150;
            const rowLight = left >= 0 && right < width && leftIsLight === rightIsLight ? leftIsLight : componentLight;
            const samples = [];
            for (const [dx, dy] of [
                [-1, 0],
                [1, 0],
                [0, -1],
                [0, 1],
            ]) {
                let sx = px;
                let sy = py;
                while (true) {
                    sx += dx;
                    sy += dy;
                    if (sx < 0 || sx >= width || sy < 0 || sy >= height) break;
                    const sample = sy * width + sx;
                    if (mask[sample]) continue;
                    if (brightness(sample) > 150 === rowLight) {
                        samples.push({ index: sample, distance: Math.abs(sx - px) + Math.abs(sy - py) });
                    }
                    break;
                }
            }
            samples.sort((a, b) => a.distance - b.distance);
            if (samples.length === 0) continue;
            const nearest = samples.slice(0, 2);
            const totalWeight = nearest.reduce((sum, sample) => sum + 1 / sample.distance, 0);
            for (let channel = 0; channel < 3; channel += 1) {
                data[index * 4 + channel] = Math.round(
                    nearest.reduce((sum, sample) => sum + original[sample.index * 4 + channel] / sample.distance, 0) / totalWeight,
                );
            }
        }
    }
}

export function eraseTinyLabelInk(ctx, canvasWidth, canvasHeight, block) {
    const box = block.coords;
    const x = clamp(Math.round(box.x), 0, canvasWidth - 1);
    const y = clamp(Math.round(box.y), 0, canvasHeight - 1);
    const width = clamp(Math.round(box.width), 1, canvasWidth - x);
    const height = clamp(Math.round(box.height), 1, canvasHeight - y);
    if (width < 25 || height < 20) return false;

    const image = ctx.getImageData(x, y, width, height);
    const isWhite = (index) => {
        const offset = index * 4;
        const red = image.data[offset];
        const green = image.data[offset + 1];
        const blue = image.data[offset + 2];
        return Math.min(red, green, blue) >= 235 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 20;
    };
    const columns = new Uint8Array(width);
    const rows = new Uint8Array(height);
    for (let px = 0; px < width; px += 1) {
        let white = 0;
        for (let py = 0; py < height; py += 1) white += Number(isWhite(py * width + px));
        columns[px] = white / height >= 0.55 ? 1 : 0;
    }
    for (let py = 0; py < height; py += 1) {
        let white = 0;
        for (let px = 0; px < width; px += 1) white += Number(isWhite(py * width + px));
        rows[py] = white / width >= 0.38 ? 1 : 0;
    }

    const text = block.eraseCoords || box;
    const centerX = clamp(Math.round(text.x + text.width / 2 - x), 0, width - 1);
    const centerY = clamp(Math.round(text.y + text.height / 2 - y), 0, height - 1);
    const xRange = whiteRun(columns, centerX);
    const yRange = whiteRun(rows, centerY);
    if (!xRange || !yRange || xRange[1] - xRange[0] < 20 || yRange[1] - yRange[0] < 15) return false;

    xRange[0] = Math.max(xRange[0], Math.round(text.x - x));
    xRange[1] = Math.min(xRange[1], Math.round(text.x + text.width + 12 - x));
    yRange[0] = Math.max(yRange[0], Math.round(text.y - 8 - y));
    yRange[1] = Math.min(yRange[1], Math.round(text.y + text.height + 12 - y));

    for (let py = yRange[0]; py <= yRange[1]; py += 1) {
        for (let px = xRange[0]; px <= xRange[1]; px += 1) {
            const offset = (py * width + px) * 4;
            image.data[offset] = 255;
            image.data[offset + 1] = 255;
            image.data[offset + 2] = 255;
        }
    }
    ctx.putImageData(image, x, y);
    return true;
}

function whiteRun(mask, center) {
    let pivot = center;
    if (!mask[pivot]) {
        for (let distance = 1; distance <= 8; distance += 1) {
            if (mask[center - distance]) {
                pivot = center - distance;
                break;
            }
            if (mask[center + distance]) {
                pivot = center + distance;
                break;
            }
        }
    }
    if (!mask[pivot]) return null;
    let left = pivot;
    let right = pivot;
    // Bridge short non-white gaps on both sides so a speckled label edge does
    // not truncate the erase run.
    while (left > 0 && Array.from({ length: 3 }, (_, offset) => mask[left - offset - 1]).some(Boolean)) left -= 1;
    while (right < mask.length - 1 && (mask[right + 1] || mask[right + 2] || mask[right + 3])) right += 1;
    return [left, right];
}
