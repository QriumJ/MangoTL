// 완성된 캔버스를 JPEG data URL로 직렬화한다.
export function encodeImage(canvas) {
    // @napi-rs/canvas takes JPEG quality on a 0–100 scale.
    const buffer = canvas.toBuffer("image/jpeg", 96);
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}
