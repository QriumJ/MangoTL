import { LOG, recognizeRegion, cropRegion } from "./session.js";
import { findInteriorTextBox } from "./text-boxes.js";
import { intersectionArea } from "../../../utils/geometry.js";

// Post-recognition repairs that re-read crops to fix clipped, split, or
// overlapping results. Runs on the main pass only — supplemental crop reads
// must stay 1:1 with their requested boxes.
export function trimOverlappingSpeechTails(results) {
    for (const upper of results) {
        const match = /^(.*?[!！?？])([\p{Script=Hiragana}\p{Script=Katakana}]{2,5})$/u.exec(upper.text);
        if (!match || upper.confidence < 0.9) continue;
        const tail = match[2];
        const lower = results.find(
            (candidate) =>
                candidate !== upper &&
                candidate.confidence >= 0.9 &&
                candidate.text.replace(/^[.。…・]+/u, "").startsWith(tail) &&
                candidate.box.y > upper.box.y + upper.box.height * 0.45 &&
                candidate.box.y < upper.box.y + upper.box.height &&
                Math.min(upper.box.x + upper.box.width, candidate.box.x + candidate.box.width) - Math.max(upper.box.x, candidate.box.x) >
                    Math.min(upper.box.width, candidate.box.width) * 0.5,
        );
        if (!lower) continue;
        upper.text = match[1];
        upper.box = { ...upper.box, height: Math.max(1, Math.min(upper.box.height, lower.box.y - upper.box.y + 40)) };
        console.log(`${LOG} Removed repeated tail from upper speech bubble: "${upper.text}"`);
    }
}

export async function repairAdjacentSpeechBubbles(results, canvas, model) {
    const letters = (value) => String(value).replace(/[^\p{L}\p{N}]/gu, "");
    for (const broad of [...results]) {
        if (broad.box.width < 450 || broad.box.height < 500 || !/[?？]/u.test(broad.text)) continue;
        const full = letters(broad.text);
        const left = results.find((part) => {
            const fragment = letters(part.text);
            return (
                part !== broad &&
                part.confidence >= 0.96 &&
                fragment.length >= 9 &&
                full.includes(fragment) &&
                part.box.x + part.box.width < broad.box.x + broad.box.width * 0.65 &&
                part.box.y > broad.box.y + broad.box.height * 0.15
            );
        });
        if (!left) continue;

        const rightX = Math.round(left.box.x + left.box.width + 24);
        const rightLimit = Math.round(broad.box.x + broad.box.width);
        if (rightLimit - rightX < 110) continue;
        const candidateBox = {
            x: rightX,
            y: Math.max(0, Math.round(broad.box.y - 40)),
            width: rightLimit - rightX,
            height: Math.round(broad.box.height * 0.7),
        };
        const focusedBox = findInteriorTextBox(canvas, candidateBox) || candidateBox;
        const focused = await recognizeRegion(cropRegion(canvas, focusedBox, model.imageSize), model);
        const prefix = letters(broad.text.split(/[?？]/u)[0]);
        if (focused.confidence < 0.9 || !/[?？]/u.test(focused.text) || !letters(focused.text).startsWith(prefix)) continue;
        if (process.env.MANGOTL_OCR_DEBUG) {
            console.log(`${LOG} Separated adjacent bubble: "${focused.text}" (${focused.confidence.toFixed(3)}) ${JSON.stringify(focusedBox)}`);
        }
        results.push({ ...focused, box: focusedBox });
    }
}

export function isLowInkArtworkHallucination(result, canvas) {
    const box = result.box;
    const letters = [...result.text].filter((character) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character));
    if (
        result.darkBox ||
        result.confidence < 0.78 ||
        result.confidence >= 0.9 ||
        letters.length < 2 ||
        letters.length > 4 ||
        box.width < 100 ||
        box.width > 230 ||
        box.height < 300 ||
        box.height / box.width < 1.8
    ) {
        return false;
    }
    const { data } = canvas.getContext("2d").getImageData(Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height));
    let light = 0;
    let colored = 0;
    let dark = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 16) {
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        light += Number(Math.min(red, green, blue) > 235);
        colored += Number(Math.max(red, green, blue) - Math.min(red, green, blue) > 25);
        dark += Number(Math.max(red, green, blue) < 100);
        count += 1;
    }
    const spurious = light / count < 0.75 && colored / count > 0.1 && dark / count < 0.055;
    if (spurious) {
        console.log(`${LOG} Discarded low-ink artwork read: "${result.text}" (${result.confidence.toFixed(3)})`);
    }
    return spurious;
}

export async function repairOverlappingVerticalColumns(results, canvas, model) {
    for (const right of results) {
        const rightLetters = right.text.replace(/[\s\p{P}\p{S}]/gu, "");
        if (rightLetters.length < 5 || right.box.width < 140 || right.box.height < 250 || right.confidence < 0.95) {
            continue;
        }

        for (const left of results) {
            if (left === right || left.box.x >= right.box.x || left.box.width < 300 || left.box.height < 500 || left.confidence < 0.9) {
                continue;
            }
            const leftLetters = left.text.replace(/[\s\p{P}\p{S}]/gu, "");
            const overlap = [...Array(Math.min(6, rightLetters.length, leftLetters.length) - 1).keys()]
                .map((value) => value + 2)
                .filter((length) => rightLetters.slice(-length) === leftLetters.slice(0, length))
                .at(-1);
            const horizontalOverlap = Math.min(right.box.x + right.box.width, left.box.x + left.box.width) - right.box.x;
            const verticalOverlap = Math.min(right.box.y + right.box.height, left.box.y + left.box.height) - Math.max(right.box.y, left.box.y);
            if (!overlap || horizontalOverlap < 35 || verticalOverlap < 25 || left.box.y < right.box.y) {
                continue;
            }

            const rightBox = {
                ...right.box,
                height: Math.min(canvas.height - right.box.y, Math.max(right.box.height * 1.9, left.box.y + left.box.height * 0.55 - right.box.y)),
            };
            const leftBox = { ...left.box, width: Math.max(1, right.box.x - left.box.x + 15) };
            const [rightRead, leftRead] = await Promise.all([
                recognizeRegion(cropRegion(canvas, rightBox, model.imageSize), model),
                recognizeRegion(cropRegion(canvas, leftBox, model.imageSize), model),
            ]);
            const newRight = rightRead.text.replace(/[\s\p{P}\p{S}]/gu, "");
            const newLeft = leftRead.text.replace(/[\s\p{P}\p{S}]/gu, "");
            if (
                rightRead.confidence < 0.98 ||
                leftRead.confidence < 0.98 ||
                !newRight.startsWith(rightLetters) ||
                newRight.length < rightLetters.length + 2 ||
                !leftLetters.endsWith(newLeft) ||
                newLeft.length < 6
            ) {
                continue;
            }
            console.log(`${LOG} Recovered two overlapping columns: "${rightRead.text}" | "${leftRead.text}"`);
            Object.assign(right, { ...rightRead, box: rightBox });
            Object.assign(left, { ...leftRead, box: leftBox });
            for (let index = results.length - 1; index >= 0; index -= 1) {
                const other = results[index];
                if (other === right || other === left || other.confidence > Math.min(rightRead.confidence, leftRead.confidence) - 0.015) {
                    continue;
                }
                const otherLetters = other.text.replace(/[\s\p{P}\p{S}]/gu, "");
                const overlapsRight =
                    intersectionArea(other.box, rightBox) / Math.min(other.box.width * other.box.height, rightBox.width * rightBox.height);
                const overlapsLeft =
                    intersectionArea(other.box, leftBox) / Math.min(other.box.width * other.box.height, leftBox.width * leftBox.height);
                const combinesColumns =
                    overlapsRight >= 0.25 &&
                    overlapsLeft >= 0.25 &&
                    otherLetters.includes(newRight.slice(0, 3)) &&
                    otherLetters.includes(newLeft.slice(0, 3));
                const repeatsLeft = overlapsLeft >= 0.7 && otherLetters.length > newLeft.length && otherLetters.endsWith(newLeft);
                if (combinesColumns || repeatsLeft) {
                    results.splice(index, 1);
                }
            }
            return;
        }
    }
}

export function overlapsStrongRead(results, box, candidate = null) {
    const area = box.width * box.height;
    return results.some((read) => {
        const other = read.box;
        const overlap = intersectionArea(other, box) / Math.min(area, other.width * other.height);
        if (overlap < 0.7 || read.confidence < 0.9 || [...read.text].filter((character) => /\p{L}/u.test(character)).length < 4) {
            return false;
        }
        if (candidate && isClearerReading(candidate, read)) {
            return false;
        }
        if (process.env.MANGOTL_OCR_DEBUG) {
            console.log(`${LOG} Candidate overlaps "${read.text}" (${read.confidence.toFixed(3)}) ${JSON.stringify(other)}`);
        }
        return true;
    });
}

function isClearerReading(candidate, previous) {
    const a = [...candidate.text].filter((character) => /\p{L}|\p{N}/u.test(character));
    const b = [...previous.text].filter((character) => /\p{L}|\p{N}/u.test(character));
    if (a.length < b.length) {
        return false;
    }
    if (candidate.confidence <= previous.confidence + 0.004 && !(a.length >= b.length + 2 && candidate.confidence >= previous.confidence - 0.05)) {
        return false;
    }
    let cursor = 0;
    for (const character of a) {
        if (character === b[cursor]) {
            cursor += 1;
        }
    }
    return cursor / b.length >= 0.92;
}

export function isNearIdenticalText(first, second) {
    if ((/^[!?！？]/u.test(second) && !/^[!?！？]/u.test(first)) || (/[!?！？]$/u.test(first) && !/[!?！？]$/u.test(second))) {
        return false;
    }
    if (/[「」『』]/u.test(second) && !/[「」『』]/u.test(first)) {
        return false;
    }
    const punctuationClass = (value) =>
        /[?？]$/u.test(value) ? "question" : /[!！]$/u.test(value) ? "exclamation" : /[。.]$/u.test(value) ? "period" : "other";
    if (punctuationClass(first) !== punctuationClass(second)) {
        return false;
    }
    const a = [...first].filter((character) => /\p{L}|\p{N}/u.test(character));
    const b = [...second].filter((character) => /\p{L}|\p{N}/u.test(character));
    if (a.length < 4 || a.length !== b.length) {
        return false;
    }
    const differences = a.reduce((count, character, index) => count + Number(character !== b[index]), 0);
    return differences >= 1 && differences <= 2;
}
