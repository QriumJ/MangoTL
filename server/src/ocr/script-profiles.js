/**
 * 언어별 OCR 노이즈 필터에 쓰는 스크립트 프로필.
 * 소스 언어에 맞는 프로필만 적용되므로, 일본어 전용 가나 규칙이
 * 다른 언어 텍스트에는 발동하지 않는다. 새 언어 추가 = 여기에 프로필 한 줄.
 */
const SCRIPT_PROFILES = {
    ja: {
        // 히라가나/가타카나 음절 문자
        syllabary: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
        // 1~3글자짜리 가나 단어 (저신뢰도 삽화 오독 후보)
        shortSyllabaryWord: /^[\p{Script=Hiragana}\p{Script=Katakana}]{1,3}$/u,
        // 가나+읽기점 조합 (세로 잉크 자국 오독 후보)
        syllabaryComma: /^[\p{Script=Hiragana}\p{Script=Katakana}][、，]$/u,
    },
};

export function scriptProfileFor(language) {
    return SCRIPT_PROFILES[language] || {};
}
