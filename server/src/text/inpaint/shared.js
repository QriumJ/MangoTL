// Pixel/surface helpers shared by the inpaint dispatcher and the flag
// erasers.
export function hasLightTextSurface(ctx, box) {
    if (box.width < 250 || box.height < 300) return false;
    const width = Math.floor(box.width);
    const height = Math.floor(box.height);
    const { data } = ctx.getImageData(Math.floor(box.x), Math.floor(box.y), width, height);
    let light = 0;
    let sampled = 0;
    for (let y = 0; y < height; y += 8) {
        for (let x = 0; x < width; x += 8) {
            const offset = (y * width + x) * 4;
            light += Number(Math.min(data[offset], data[offset + 1], data[offset + 2]) >= 235);
            sampled += 1;
        }
    }
    return light / Math.max(1, sampled) >= 0.8;
}

export function isLightBackground(hex) {
    const rgb = parseHexColor(hex);
    return rgb && Math.min(...rgb) > 225 && Math.max(...rgb) - Math.min(...rgb) < 35;
}

export function isDarkBackground(hex) {
    const rgb = parseHexColor(hex);
    return rgb && Math.max(...rgb) < 80;
}

export function parseHexColor(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!match) {
        return null;
    }
    const value = Number.parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// A speech bubble's outline reaches the crop edge, while each glyph is a
// compact dark component inside it. Erase those components and their antialias
// fringe without flattening the bubble or its tail.
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
