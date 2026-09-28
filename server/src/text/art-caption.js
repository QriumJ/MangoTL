import { cv } from "ppu-ocv";

export function isOutlinedArtCaption(block) {
    const match = /^#([0-9a-f]{6})$/i.exec(block.style?.background || "");
    if (!match || block.confidence < 0.9) return false;
    const [red, green, blue] = [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16));
    const brightest = Math.max(red, green, blue);
    const saturation = brightest - Math.min(red, green, blue);
    return (
        brightest > 120 &&
        saturation > 40 &&
        block.style.textColor === "#f5f5f5" &&
        block.style.strokeColor === "#121212" &&
        block.coords.width >= 250 &&
        block.coords.width <= 650 &&
        block.coords.height >= 125 &&
        block.coords.height <= 360 &&
        String(block.sourceText).replace(/\s+/gu, "").length >= 20
    );
}

// Black lettering with a thick white outline is common on textured art. Mask
// only the compact white outline components, fill their enclosed dark cores,
// then reconstruct the table or panel texture from neighboring pixels.
export function eraseOutlinedArtCaption(ctx, canvasWidth, canvasHeight, block) {
    if (typeof cv.Mat !== "function" || typeof cv.inpaint !== "function") return false;
    const pad = 15;
    const box = block.eraseCoords || block.coords;
    const x = Math.max(0, Math.round(box.x - pad));
    const y = Math.max(0, Math.round(box.y - pad));
    const width = Math.min(canvasWidth - x, Math.round(box.width + pad * 2));
    const height = Math.min(canvasHeight - y, Math.round(box.height + pad * 2));
    if (width < 30 || height < 30) return false;
    const image = ctx.getImageData(x, y, width, height);
    const pixels = image.data;
    const white = new Uint8Array(width * height);
    for (let index = 0; index < white.length; index += 1) {
        const offset = index * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        if (Math.min(red, green, blue) > 235 && Math.max(red, green, blue) - Math.min(red, green, blue) < 20) white[index] = 1;
    }

    const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
    const resources = [mask];
    try {
        for (let origin = 0; origin < white.length; origin += 1) {
            if (white[origin] !== 1) continue;
            const queue = [origin];
            white[origin] = 2;
            let left = width;
            let top = height;
            let right = 0;
            let bottom = 0;
            for (let cursor = 0; cursor < queue.length; cursor += 1) {
                const current = queue[cursor];
                const px = current % width;
                const py = Math.floor(current / width);
                left = Math.min(left, px);
                top = Math.min(top, py);
                right = Math.max(right, px);
                bottom = Math.max(bottom, py);
                for (const next of [current - 1, current + 1, current - width, current + width]) {
                    if (next < 0 || next >= white.length || white[next] !== 1 || Math.abs((next % width) - px) > 1) continue;
                    white[next] = 2;
                    queue.push(next);
                }
            }
            if (queue.length <= 200 || left === 0 || top === 0 || right === width - 1 || bottom === height - 1 || bottom - top >= 85) continue;
            for (const pixel of queue) mask.data[pixel] = 255;
        }
        const totalWhite = white.reduce((count, value) => count + Number(value === 2), 0);
        const selectedWhite = mask.data.reduce((count, value) => count + Number(value === 255), 0);
        if (totalWhite > 0 && selectedWhite / totalWhite < 0.7) {
            for (let index = 0; index < white.length; index += 1) {
                if (white[index] === 2) mask.data[index] = 255;
            }
        }
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
        const dilated = new cv.Mat();
        const source = cv.matFromImageData(image);
        const rgb = new cv.Mat();
        const output = new cv.Mat();
        resources.push(contours, hierarchy, kernel, dilated, source, rgb, output);
        cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        cv.drawContours(mask, contours, -1, new cv.Scalar(255), -1);
        cv.dilate(mask, dilated, kernel);
        cv.cvtColor(source, rgb, cv.COLOR_RGBA2RGB);
        cv.inpaint(rgb, dilated, output, 7, cv.INPAINT_TELEA);
        for (let index = 0; index < white.length; index += 1) {
            const from = index * 3;
            const to = index * 4;
            pixels[to] = output.data[from];
            pixels[to + 1] = output.data[from + 1];
            pixels[to + 2] = output.data[from + 2];
        }
        ctx.putImageData(image, x, y);
        return true;
    } finally {
        for (const resource of resources) resource.delete();
    }
}
