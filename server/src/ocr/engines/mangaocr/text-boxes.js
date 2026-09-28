import { intersectionArea } from "../../../utils/geometry.js";
// Geometry helpers that locate readable text inside detected regions:
// interior bubble boxes, ink columns for vertical splits, and light-surface
// component scans.
export function findInteriorTextBox(canvas, sourceBox) {
    const x = Math.max(0, Math.floor(sourceBox.x));
    const y = Math.max(0, Math.floor(sourceBox.y));
    const width = Math.min(canvas.width - x, Math.ceil(sourceBox.width));
    const height = Math.min(canvas.height - y, Math.ceil(sourceBox.height));
    const { data } = canvas.getContext("2d").getImageData(x, y, width, height);
    const visited = new Uint8Array(width * height);
    const components = [];
    const isInk = (index) => {
        const offset = index * 4;
        return (data[offset] + data[offset + 1] + data[offset + 2]) / 3 < 130;
    };

    for (let seed = 0; seed < visited.length; seed += 1) {
        if (visited[seed] || !isInk(seed)) {
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
            const px = index % width;
            const py = (index / width) | 0;
            minX = Math.min(minX, px);
            minY = Math.min(minY, py);
            maxX = Math.max(maxX, px);
            maxY = Math.max(maxY, py);
            area += 1;
            for (const next of [
                px > 0 ? index - 1 : -1,
                px + 1 < width ? index + 1 : -1,
                py > 0 ? index - width : -1,
                py + 1 < height ? index + width : -1,
            ]) {
                if (next >= 0 && !visited[next] && isInk(next)) {
                    visited[next] = 1;
                    stack.push(next);
                }
            }
        }
        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        if (
            area >= 12 &&
            componentWidth < width * 0.32 &&
            componentHeight < height * 0.28 &&
            (minX + maxX) / 2 > width * 0.08 &&
            (minX + maxX) / 2 < width * 0.92
        ) {
            components.push({ minX, minY, maxX, maxY, area });
        }
    }

    if (components.length < 3) {
        return null;
    }
    const columnWidth = Math.max(80, Math.min(160, Math.round(width * 0.3)));
    let bestCenter = 0;
    let bestWeight = -1;
    for (let center = Math.floor(columnWidth / 2); center < width; center += 12) {
        const weight = components.reduce((sum, part) => {
            const partCenter = (part.minX + part.maxX) / 2;
            return sum + (Math.abs(partCenter - center) <= columnWidth / 2 ? Math.min(part.area, 250) : 0);
        }, 0);
        if (weight > bestWeight) {
            bestWeight = weight;
            bestCenter = center;
        }
    }
    const columnParts = components.filter((part) => Math.abs((part.minX + part.maxX) / 2 - bestCenter) <= columnWidth / 2);
    if (columnParts.length < 3) {
        return null;
    }
    const minX = Math.min(...columnParts.map((part) => part.minX));
    const minY = Math.min(...columnParts.map((part) => part.minY));
    const maxX = Math.max(...columnParts.map((part) => part.maxX));
    const maxY = Math.max(...columnParts.map((part) => part.maxY));
    const padding = 15;
    const left = Math.max(0, minX - padding);
    const top = Math.max(0, minY - padding);
    const right = Math.min(width, maxX + padding + 1);
    const bottom = Math.min(height, maxY + padding + 1);
    if ((right - left) * (bottom - top) > width * height * 0.8 || bottom - top < 100) {
        return null;
    }
    return { x: x + left, y: y + top, width: right - left, height: bottom - top };
}

export function findInkColumns(canvas, sourceBox) {
    const x = Math.max(0, Math.floor(sourceBox.x));
    const y = Math.max(0, Math.floor(sourceBox.y));
    const width = Math.min(canvas.width - x, Math.ceil(sourceBox.width));
    const height = Math.min(canvas.height - y, Math.ceil(sourceBox.height));
    if (width < 100 || height < 100) {
        return [];
    }

    const { data } = canvas.getContext("2d").getImageData(x, y, width, height);
    const counts = new Uint16Array(width);
    const isDark = (index) => (data[index] + data[index + 1] + data[index + 2]) / 3 < 160;
    for (let xx = 0; xx < width; xx += 1) {
        for (let yy = 0; yy < height; yy += 3) {
            if (isDark((yy * width + xx) * 4)) {
                counts[xx] += 1;
            }
        }
    }

    const groups = [];
    let start = -1;
    let last = -1;
    for (let xx = 0; xx < width; xx += 1) {
        if (counts[xx] < 3) {
            continue;
        }
        if (start < 0) {
            start = xx;
        } else if (xx - last > 24) {
            groups.push({ start, end: last });
            start = xx;
        }
        last = xx;
    }
    if (start >= 0) {
        groups.push({ start, end: last });
    }

    const columns = groups
        .filter((group) => group.end - group.start >= 20 && group.end - group.start <= width * 0.35)
        .map((group) => {
            const left = Math.max(0, group.start - 20);
            const right = Math.min(width, group.end + 21);
            let top = height;
            let bottom = 0;
            for (let xx = left; xx < right; xx += 1) {
                for (let yy = 0; yy < height; yy += 2) {
                    if (isDark((yy * width + xx) * 4)) {
                        top = Math.min(top, yy);
                        bottom = Math.max(bottom, yy);
                    }
                }
            }
            return {
                x: x + left,
                y: y + Math.max(0, top - 20),
                width: right - left,
                height: Math.min(height, bottom + 21) - Math.max(0, top - 20),
            };
        })
        .filter((column) => column.height >= 80);

    return columns.length >= 2 && columns.length <= 4 ? columns.sort((a, b) => b.x - a.x) : [];
}

export function getRecognitionBoxes(detection) {
    const sourceBoxes = detection.boxes.filter((box) => box.width > 0 && box.height > 0);
    const bubbleBoxes = detectLightBubbleTextBoxes(detection.canvas);
    const boxes = [...sourceBoxes];

    for (const bubbleBox of bubbleBoxes) {
        if (!boxes.some((box) => isSameRegion(box, bubbleBox))) {
            boxes.push(bubbleBox);
        }
    }

    return boxes;
}

function detectLightBubbleTextBoxes(canvas) {
    let ctx;

    try {
        ctx = canvas.getContext("2d");
    } catch {
        return [];
    }

    const width = canvas.width;
    const height = canvas.height;
    const imageArea = Math.max(1, width * height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const visited = new Uint8Array(imageArea);
    const candidates = [];

    for (let seed = 0; seed < imageArea; seed += 1) {
        if (visited[seed] || !isLightNeutralPixel(data, seed)) {
            continue;
        }

        const component = floodLightComponent(data, width, height, seed, visited);
        const componentArea = component.width * component.height;
        const fillRatio = component.pixelIndexes.length / Math.max(1, componentArea);

        if (
            component.pixelIndexes.length < 450 ||
            component.width < 20 ||
            component.height < 20 ||
            componentArea / imageArea >= 0.09 ||
            fillRatio < 0.35
        ) {
            continue;
        }

        const textBox = getInteriorInkBox(data, width, height, component);

        if (textBox && isLikelyVerticalTextBox(textBox) && !candidates.some((candidate) => isSameRegion(candidate, textBox))) {
            candidates.push(textBox);
        }
    }

    return candidates;
}

function floodLightComponent(data, width, height, seed, visited) {
    const stack = [seed];
    const pixelIndexes = [];
    visited[seed] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (stack.length > 0) {
        const index = stack.pop();
        const x = index % width;
        const y = (index / width) | 0;
        pixelIndexes.push(index);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        for (const neighbor of [
            x > 0 ? index - 1 : -1,
            x < width - 1 ? index + 1 : -1,
            y > 0 ? index - width : -1,
            y < height - 1 ? index + width : -1,
        ]) {
            if (neighbor >= 0 && !visited[neighbor] && isLightNeutralPixel(data, neighbor)) {
                visited[neighbor] = 1;
                stack.push(neighbor);
            }
        }
    }

    return {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        pixelIndexes,
    };
}

function getInteriorInkBox(data, width, height, component) {
    const componentMask = new Set(component.pixelIndexes);
    const edgeInset = 7;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let inkPixels = 0;

    for (let y = component.y + edgeInset; y < component.y + component.height - edgeInset; y += 1) {
        for (let x = component.x + edgeInset; x < component.x + component.width - edgeInset; x += 1) {
            const index = y * width + x;

            if (!isDarkInkPixel(data, index) || !hasNearbyComponentPixel(componentMask, width, height, x, y)) {
                continue;
            }

            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            inkPixels += 1;
        }
    }

    if (inkPixels < 18 || maxX < minX || maxY < minY) {
        return null;
    }

    const padding = 4;
    const x = Math.max(0, minX - padding);
    const y = Math.max(0, minY - padding);

    return {
        x,
        y,
        width: Math.max(1, Math.min(width - x, maxX - minX + 1 + padding * 2)),
        height: Math.max(1, Math.min(height - y, maxY - minY + 1 + padding * 2)),
    };
}

function isLikelyVerticalTextBox(box) {
    return box.height > box.width * 1.15;
}

function hasNearbyComponentPixel(componentMask, width, height, x, y) {
    for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
            const xx = x + dx;
            const yy = y + dy;

            if (xx >= 0 && xx < width && yy >= 0 && yy < height && componentMask.has(yy * width + xx)) {
                return true;
            }
        }
    }

    return false;
}

function isLightNeutralPixel(data, index) {
    const offset = index * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const brightness = (r + g + b) / 3;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    return brightness > 246 && saturation < 18;
}

function isDarkInkPixel(data, index) {
    const offset = index * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const brightness = (r + g + b) / 3;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    return brightness < 110 && saturation < 80;
}

function isSameRegion(a, b) {
    const overlap = intersectionArea(a, b);
    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    const smallerArea = Math.min(areaA, areaB);
    const largerArea = Math.max(areaA, areaB);
    return smallerArea > 0 && overlap / smallerArea > 0.85 && largerArea / smallerArea < 1.4;
}
