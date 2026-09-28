import { createCanvas } from "ppu-ocv/canvas";

/**
 * 픽셀 스캔용 축소 캔버스를 만든다. 전체 이미지 flood fill은 원본 해상도에서
 * 수백만 픽셀을 순회하므로 작업 해상도로 내려 비용을 줄인다.
 * scale로 축소 비율을, toSource로 원본 좌표 복원 함수를 돌려준다.
 */
export function makeScanCanvas(canvas, maxWidth = 1400) {
    const scale = Math.min(1, maxWidth / Math.max(1, canvas.width));
    if (scale >= 0.985) {
        return { canvas, scale: 1, toSource: (value) => value, boxToSource: (box) => box };
    }

    const scan = createCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.round(canvas.height * scale)));
    const ctx = scan.getContext("2d");
    // 투명 영역이 스캔 대상 픽셀로 잡히지 않도록 흰색으로 초기화한다
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, scan.width, scan.height);
    ctx.drawImage(canvas, 0, 0, scan.width, scan.height);

    const inverse = 1 / scale;
    return {
        canvas: scan,
        scale,
        toSource: (value) => Math.round(value * inverse),
        boxToSource: (box) => ({
            x: Math.round(box.x * inverse),
            y: Math.round(box.y * inverse),
            width: Math.round(box.width * inverse),
            height: Math.round(box.height * inverse),
        }),
    };
}
