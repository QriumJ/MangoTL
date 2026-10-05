// Shared pixel mask for erasing outlined lettering; independent of OCR engines.
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
