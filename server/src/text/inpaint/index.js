import { createCanvas } from "ppu-ocv";
import { HttpError } from "../../utils/http-error.js";

/**
 * 인페인팅 엔진 레지스트리. 두 역할이 분리되어 있다:
 * - erase:   원문 잉크를 배경으로 덮어 지우는 엔진 (예: local)
 * - restore: 세부 영역을 모델로 복원하는 엔진 (예: lama) — 선택 사항
 *
 * 실행 순서(기본 "local" + "lama"):
 *   1. restore 엔진이 상세 후보 블록을 고른다
 *   2. 후보를 제외한 전체 블록을 erase 엔진으로 지운다
 *   3. restore 엔진이 원본 위에서 후보 영역을 복원한다
 *   4. 복원에 실패한 후보만 erase로 다시 지운다
 *
 * 새 엔진 추가 = 구현 모듈 + 레지스트리 한 줄. 파이프라인은 엔진 ID만 넘긴다.
 */
const INPAINTERS = {
    local: async () => (await import("./local.js")).inpaintTextRegions,
};

const RESTORERS = {
    lama: async () => await import("./lama.js"),
};

/**
 * @param canvas ppu-ocv 캔버스 (직접 수정됨)
 * @param blocks 번역된 블록 배열
 * @param options { erase?: string, restore?: string|null } — 엔진 ID
 */
export async function inpaintImage(canvas, blocks, options = {}) {
    const eraseId = options.erase ?? "local";
    const restoreId = options.restore === undefined ? "lama" : options.restore;

    const inpaintTextRegions = await loadEngine(INPAINTERS, eraseId, "inpaint_engine_not_supported", "inpaint erase");
    const restorer = restoreId ? await loadEngine(RESTORERS, restoreId, "inpaint_engine_not_supported", "inpaint restore") : null;

    const detailedIds = restorer ? restorer.findDetailedTextRegionIds(canvas, blocks) : new Set();
    const sourceCanvas = detailedIds.size > 0 ? createCanvas(canvas.width, canvas.height) : null;
    sourceCanvas?.getContext("2d").drawImage(canvas, 0, 0);

    inpaintTextRegions(canvas, blocks, detailedIds);

    if (sourceCanvas) {
        const restored = await restorer.restoreDetailedTextRegions(canvas, blocks, sourceCanvas);
        // 복원에 실패한 세부 영역은 평범한 지우기로라도 원문을 제거한다
        const failed = blocks.filter((block) => detailedIds.has(block.id) && !restored.has(block.id));
        if (failed.length > 0) {
            inpaintTextRegions(canvas, failed);
        }
    }
}

async function loadEngine(registry, id, code, label) {
    const load = registry[id];
    if (!load) {
        throw new HttpError(400, code, `Unsupported ${label} engine: ${id || "(none)"}`);
    }
    return load();
}
