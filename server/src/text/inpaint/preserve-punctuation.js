import { intersectionArea } from "../../utils/geometry.js";

export function captureAdjacentPunctuation(canvas, ocrItems, translatedBlocks) {
    const ctx = canvas.getContext("2d");
    const patches = [];
    for (const item of ocrItems) {
        if (!/^[!?！？]{1,3}$/u.test(String(item.text || "").trim()) || (item.confidence ?? 0) < 0.95 || !item.coords) continue;
        const area = item.coords.width * item.coords.height;
        const clippedByTranslation = translatedBlocks.some((block) => {
            const overlap = intersectionArea(item.coords, block.eraseCoords || block.coords) / Math.max(1, area);
            return overlap > 0.1 && overlap < 0.8;
        });
        if (!clippedByTranslation) continue;
        const pad = 6;
        const x = Math.max(0, Math.floor(item.coords.x - pad));
        const y = Math.max(0, Math.floor(item.coords.y - pad));
        const width = Math.min(canvas.width - x, Math.ceil(item.coords.x + item.coords.width + pad) - x);
        const height = Math.min(canvas.height - y, Math.ceil(item.coords.y + item.coords.height + pad) - y);
        patches.push({ x, y, image: ctx.getImageData(x, y, width, height) });
    }
    return patches;
}

export function restoreAdjacentPunctuation(canvas, patches) {
    const ctx = canvas.getContext("2d");
    for (const patch of patches) ctx.putImageData(patch.image, patch.x, patch.y);
}
