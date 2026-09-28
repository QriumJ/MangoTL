// Restrict horizontal Korean lettering to the light part of a source box when
// an OCR rectangle also includes nearby coloured artwork.
export function findLightSurfaceColumnBox(ctx, box, style) {
    if (!box || box.width < 250 || box.height < 300 || !/^#(?:f[0-9a-f]){3}$/i.test(style?.background || "")) {
        return box;
    }

    const width = Math.floor(box.width);
    const height = Math.floor(box.height);
    const { data } = ctx.getImageData(Math.floor(box.x), Math.floor(box.y), width, height);
    const stride = 8;
    const ratios = [];
    for (let x = 0; x < width; x += stride) {
        let light = 0;
        let sampled = 0;
        for (let y = 0; y < height; y += stride) {
            const offset = (y * width + x) * 4;
            light += Number(Math.min(data[offset], data[offset + 1], data[offset + 2]) >= 235);
            sampled += 1;
        }
        ratios.push(light / Math.max(1, sampled));
    }

    const smoothed = ratios.map((_, index) => {
        const near = ratios.slice(Math.max(0, index - 2), Math.min(ratios.length, index + 3));
        return near.reduce((sum, value) => sum + value, 0) / near.length;
    });
    let bestStart = -1;
    let bestEnd = -1;
    let start = -1;
    for (let index = 0; index <= smoothed.length; index += 1) {
        if (index < smoothed.length && smoothed[index] >= 0.65) {
            start = start < 0 ? index : start;
            continue;
        }
        if (start >= 0 && index - start > bestEnd - bestStart) {
            bestStart = start;
            bestEnd = index;
        }
        start = -1;
    }

    const safeWidth = (bestEnd - bestStart) * stride;
    if (safeWidth < Math.max(140, width * 0.42) || safeWidth >= width * 0.9) {
        return box;
    }
    const left = Math.max(0, bestStart * stride + 8);
    const right = Math.min(width, bestEnd * stride - 8);
    if (right - left < 120) {
        return box;
    }
    return { ...box, x: box.x + left, width: right - left };
}
