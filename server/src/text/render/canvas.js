import { RENDER_FONT_FAMILY } from "../fonts.js";
import { findLightSurfaceColumnBox } from "../light-surface.js";

/**
 * Draws the translated text directly onto the (already inpainted) canvas, so
 * the server produces a finished image and the extension only has to swap it
 * in. Text is fitted to each detected box with real canvas measurement.
 *
 * Rendering prefers the bundled font registered by `ensureRenderFonts` so the
 * output is identical on every platform; the system families below are only a
 * fallback for local runs where that download failed.
 */
const FONT_FAMILY = `'${RENDER_FONT_FAMILY}', 'Apple SD Gothic Neo', 'Hiragino Sans', 'Noto Sans JP', 'Noto Sans CJK JP', sans-serif`;
const FONT_WEIGHT = 500;
const MIN_FONT = 9;
const MAX_FONT = 200;
const LINE_HEIGHT = 1.22;
const MAX_DIALOGUE_FONT = 24;

export function renderTranslatedText(canvas, blocks) {
    let ctx;

    try {
        ctx = canvas.getContext("2d");
    } catch {
        return;
    }

    const pageScale = Math.max(0.75, Math.min(3.2, Math.sqrt((canvas.width * canvas.height) / (864 * 1200))));

    for (const block of blocks || []) {
        try {
            renderBlock(ctx, block, pageScale, blocks);
        } catch {
            // One bad block must not abort the rest of the page.
        }
    }
}

function renderBlock(ctx, block, pageScale, blocks) {
    const text = normalizeText(block.translatedText);
    // Handwritten effects and recovered labels render inside their detected
    // box; everything else is fitted to the light surface around it.
    const effectLike = block.standalone || block.darkBox || block.artCaption;
    const box = effectLike ? block.coords : shortSpeechBalloonBox(block) || findLightSurfaceColumnBox(ctx, block.coords, block.style);

    if (!text || !box || box.width < 4 || box.height < 4) {
        return;
    }

    const compactTextLength = [...text.replace(/\s+/g, "")].length;
    const padRatio = compactTextLength > 34 ? 0.11 : 0.09;
    const padX = Math.min(box.width * padRatio, 16 * pageScale);
    const padY = Math.min(box.height * padRatio, 16 * pageScale);
    const expandedVerticalBubble =
        block.style?.bubbleBox && block.eraseCoords?.height > block.eraseCoords?.width * 1.15 && block.coords.width > block.eraseCoords.width * 1.2;
    const adjacentBubble = expandedVerticalBubble && findAdjacentBubble(block, blocks);
    const verticalOcrOvershootsBubble = expandedVerticalBubble && block.eraseCoords.height > box.height * 1.1;
    const bubbleWidthRatio = box.width >= 300 && compactTextLength >= 10 ? (expandedVerticalBubble ? 0.55 : 0.4) : 0.66;
    const narrowUnboxedLight =
        !block.style?.bubbleBox &&
        /^#(?:f[0-9a-f]){3}$/i.test(block.style?.background || "") &&
        box.width >= 400 &&
        box.height >= 500 &&
        compactTextLength >= 10;
    const maxWidth = Math.min(
        box.width - padX * 2,
        block.style?.bubbleBox ? box.width * bubbleWidthRatio : narrowUnboxedLight ? box.width * 0.55 : box.width,
        adjacentBubble ? block.eraseCoords.width * 0.58 : Number.POSITIVE_INFINITY,
    );
    const maxHeight = box.height - padY * 2;

    if (maxWidth < 2 || maxHeight < 2) {
        return;
    }

    const textColor = block.style?.textColor || "#161616";
    const strokeColor = block.style?.strokeColor ?? null;
    fillRenderBackground(ctx, block, box);

    if (block.direction === "vertical") {
        renderVertical(ctx, [...text], box, maxWidth, maxHeight, textColor, strokeColor, pageScale);
    } else {
        renderHorizontal(
            ctx,
            text,
            box,
            maxWidth,
            maxHeight,
            textColor,
            strokeColor,
            block.footstepEffect
                ? pageScale * 1.5
                : block.confirmedRepeatedEffect
                  ? pageScale * 1.4
                  : block.insetHandwritten
                    ? Math.min(pageScale, 1.6)
                    : pageScale,
            Boolean(block.darkBox),
            adjacentBubble
                ? adjacentBubble.x > block.eraseCoords.x
                    ? -Math.min(50, block.eraseCoords.width * 0.2)
                    : Math.min(30, block.eraseCoords.width * 0.12)
                : verticalOcrOvershootsBubble
                  ? box.width * 0.08
                  : 0,
            0,
            Boolean(block.footstepEffect) || Boolean(block.confirmedRepeatedEffect) || Boolean(block.outlinedEffect),
            false,
        );
    }
}

function shortSpeechBalloonBox(block) {
    const bubble = block.style?.bubbleBox;
    const source = block.coords;
    const length = [...String(block.originalText || "").replace(/\s+/gu, "")].length;
    if (!bubble || block.type !== "dialogue" || length > 8 || !source) return null;
    if (bubble.width < source.width * 1.2 || bubble.height < source.height * 1.5) return null;
    // A line detector returns a single narrow vertical column, not the full
    // balloon. Allow its centred, bounded light surface to fit the target
    // language horizontally instead of shrinking each syllable to column width.
    const narrowVerticalLine = block.verticalLine && source.height > source.width * 2.5;
    if (bubble.width > source.width * (narrowVerticalLine ? 8 : 3) || bubble.height > source.height * 5) return null;
    const centerX = source.x + source.width / 2;
    const centerY = source.y + source.height / 2;
    if (Math.abs(centerX - bubble.x - bubble.width / 2) > bubble.width * 0.22) return null;
    if (Math.abs(centerY - bubble.y - bubble.height / 2) > bubble.height * 0.22) return null;
    return {
        x: bubble.x + bubble.width * 0.12,
        y: bubble.y + bubble.height * 0.12,
        width: bubble.width * 0.76,
        height: bubble.height * 0.76,
    };
}

function findAdjacentBubble(block, blocks) {
    const source = block.eraseCoords || block.coords;
    let closest = null;
    let closestDistance = Infinity;
    for (const neighbor of blocks) {
        if (neighbor === block || !neighbor.style?.bubbleBox) continue;
        const other = neighbor.eraseCoords || neighbor.coords;
        const distanceX = Math.abs(source.x + source.width / 2 - other.x - other.width / 2);
        const overlapY = Math.max(0, Math.min(source.y + source.height, other.y + other.height) - Math.max(source.y, other.y));
        if (
            distanceX > Math.min(source.width, other.width) * 0.4 &&
            distanceX < (source.width + other.width) / 2 + Math.min(120, source.width * 0.5) &&
            overlapY > Math.min(source.height, other.height) * 0.4 &&
            distanceX < closestDistance
        ) {
            closest = other;
            closestDistance = distanceX;
        }
    }
    return closest;
}

function fillRenderBackground(ctx, block, box) {
    if (!block.renderBackground) {
        return;
    }

    ctx.fillStyle = block.style?.background || "#ffffff";
    ctx.fillRect(box.x, box.y, box.width, box.height);
}

function renderHorizontal(
    ctx,
    text,
    box,
    maxWidth,
    maxHeight,
    textColor,
    strokeColor,
    pageScale,
    enclosedText,
    centerOffsetX = 0,
    centerOffsetY = 0,
    emphasisEffect = false,
    boldText = false,
) {
    const minFont = Math.max(1, Math.round(MIN_FONT * pageScale));
    let low = minFont;
    let high = getMaxHorizontalFont(text, maxWidth, maxHeight, pageScale, enclosedText, emphasisEffect);
    let best = null;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const layout = layoutHorizontal(ctx, text, mid, maxWidth);

        if (layout.maxLineWidth <= maxWidth && layout.totalHeight <= maxHeight && !layout.brokenWord) {
            best = { size: mid, layout };
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    if (!best) {
        best = { size: minFont, layout: layoutHorizontal(ctx, text, minFont, maxWidth) };
    }

    setFont(ctx, best.size, boldText ? 800 : FONT_WEIGHT);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.5, best.size * 0.12);
    ctx.fillStyle = textColor;

    if (strokeColor) {
        ctx.strokeStyle = strokeColor;
    }

    const centerX = box.x + box.width / 2 + centerOffsetX;
    const startY = box.y + box.height / 2 - best.layout.totalHeight / 2 + best.layout.lineHeight / 2 + centerOffsetY;

    for (let line = 0; line < best.layout.lines.length; line += 1) {
        const y = startY + line * best.layout.lineHeight;
        if (strokeColor) {
            ctx.strokeText(best.layout.lines[line], centerX, y);
        }
        ctx.fillText(best.layout.lines[line], centerX, y);
    }
}

function getMaxHorizontalFont(text, maxWidth, maxHeight, pageScale, enclosedText, emphasisEffect) {
    const compactLength = [...text.replace(/\s+/g, "")].length;
    const dialogueMax = (compactLength > 42 ? 17 : compactLength > 26 ? 21 : enclosedText ? 36 : MAX_DIALOGUE_FONT) * pageScale;
    const naturalMax = Math.ceil(Math.min(MAX_FONT, maxHeight, dialogueMax));

    if (compactLength <= 4) {
        return Math.max(
            Math.round(MIN_FONT * pageScale),
            Math.min(naturalMax, Math.floor(maxHeight * (emphasisEffect ? 0.75 : 0.42)), Math.floor(maxWidth * (emphasisEffect ? 0.55 : 0.28))),
        );
    }

    return naturalMax;
}

function layoutHorizontal(ctx, text, size, maxWidth) {
    setFont(ctx, size);
    const widthOf = (value) => ctx.measureText(value).width;
    if (text.includes("\n")) {
        const lines = text.split("\n").filter(Boolean);
        const lineHeight = size * LINE_HEIGHT;
        return {
            lines,
            lineHeight,
            totalHeight: lines.length * lineHeight,
            maxLineWidth: lines.reduce((widest, line) => Math.max(widest, widthOf(line)), 0),
            brokenWord: lines.some((line) => widthOf(line) > maxWidth),
        };
    }
    const words = tokenizeForWrapping(text);
    const lines = [];
    let current = "";
    let brokenWord = false;

    const pushWord = (word) => {
        if (widthOf(word) <= maxWidth) {
            current = word;
            return;
        }

        const chunks = breakWord(word, widthOf, maxWidth);
        brokenWord ||= chunks.length > 1;

        for (let index = 0; index < chunks.length - 1; index += 1) {
            lines.push(chunks[index]);
        }

        current = chunks[chunks.length - 1];
    };

    for (const word of words) {
        if (!current) {
            pushWord(word);
            continue;
        }

        if (widthOf(`${current} ${word}`) <= maxWidth) {
            current = `${current} ${word}`;
        } else {
            lines.push(current);
            current = "";
            pushWord(word);
        }
    }

    if (current) {
        lines.push(current);
    }

    const lineHeight = size * LINE_HEIGHT;
    const maxLineWidth = lines.reduce((widest, line) => Math.max(widest, widthOf(line)), 0);

    return { lines, lineHeight, totalHeight: lines.length * lineHeight, maxLineWidth, brokenWord };
}

function tokenizeForWrapping(text) {
    const words = text.split(/\s+/).filter(Boolean);

    if (words.length > 1) {
        return words;
    }

    const compact = text.replace(/\s+/g, "");
    return compact.length >= 12 ? [...compact] : [compact];
}

function breakWord(word, widthOf, maxWidth) {
    const chunks = [];
    let chunk = "";

    for (const character of word) {
        if (chunk && widthOf(chunk + character) > maxWidth) {
            chunks.push(chunk);
            chunk = character;
        } else {
            chunk += character;
        }
    }

    if (chunk) {
        chunks.push(chunk);
    }

    return chunks.length > 0 ? chunks : [word];
}

function renderVertical(ctx, characters, box, maxWidth, maxHeight, textColor, strokeColor, pageScale) {
    const glyphs = characters.filter((character) => character !== "\n");
    const minFont = Math.max(1, Math.round(MIN_FONT * pageScale));
    let low = minFont;
    let high = Math.ceil(Math.min(MAX_FONT, maxWidth));
    let best = null;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const layout = layoutVertical(glyphs, mid, maxHeight);

        if (layout.totalWidth <= maxWidth) {
            best = { size: mid, layout };
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    if (!best) {
        best = { size: minFont, layout: layoutVertical(glyphs, minFont, maxHeight) };
    }

    setFont(ctx, best.size);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.5, best.size * 0.12);
    ctx.fillStyle = textColor;

    if (strokeColor) {
        ctx.strokeStyle = strokeColor;
    }

    const { columns, columnWidth, step } = best.layout;
    const blockWidth = columns.length * columnWidth;
    const startX = box.x + box.width / 2 + blockWidth / 2 - columnWidth / 2;

    for (let column = 0; column < columns.length; column += 1) {
        const x = startX - column * columnWidth;
        const startY = box.y + box.height / 2 - (columns[column].length * step) / 2 + step / 2;

        for (let row = 0; row < columns[column].length; row += 1) {
            const y = startY + row * step;
            if (strokeColor) {
                ctx.strokeText(columns[column][row], x, y);
            }
            ctx.fillText(columns[column][row], x, y);
        }
    }
}

function layoutVertical(glyphs, size, maxHeight) {
    const step = size * LINE_HEIGHT;
    const perColumn = Math.max(1, Math.floor(maxHeight / step));
    const columns = [];

    for (let index = 0; index < glyphs.length; index += perColumn) {
        columns.push(glyphs.slice(index, index + perColumn));
    }

    return { columns, columnWidth: size * 1.12, step, totalWidth: columns.length * size * 1.12 };
}

function setFont(ctx, size, weight = FONT_WEIGHT) {
    ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
}

function normalizeText(text) {
    return String(text || "")
        .replace(/\s*\n\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
