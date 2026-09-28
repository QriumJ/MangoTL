import { ensureRenderFonts } from "../fonts.js";
import { HttpError } from "../../utils/http-error.js";

/**
 * 렌더러 type → 구현 로더 레지스트리. 지연 로딩이라 선택되지 않은
 * 렌더러의 의존성은 로드되지 않는다.
 * 새 렌더러 추가 = 구현 모듈 + 여기 한 줄. 파이프라인은 ID만 넘긴다.
 */
const RENDERERS = {
    canvas: async () => (await import("./canvas.js")).renderTranslatedText,
};

/**
 * @param canvas ppu-ocv 캔버스 (직접 수정됨)
 * @param blocks 번역된 블록 배열
 * @param rendererId config에서 선택된 렌더러 ID (기본 "canvas")
 */
export async function renderImage(canvas, blocks, rendererId = "canvas") {
    const load = RENDERERS[rendererId];
    if (!load) {
        throw new HttpError(400, "render_engine_not_supported", `Unsupported render engine: ${rendererId || "(none)"}`);
    }
    await ensureRenderFonts();
    const render = await load();
    render(canvas, blocks);
}
