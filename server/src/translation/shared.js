/**
 * True when the model returned no real translation for a block — an empty
 * string, the source echoed back, or text still written in the source script.
 * Used both by providers (per-block retry) and the pipeline (drop such blocks).
 */
export function isUntranslatedText(sourceText, translatedText, targetLanguage) {
    const source = String(sourceText || "").replace(/\s+/g, "");
    const translated = String(translatedText || "").replace(/\s+/g, "");

    if (!translated) {
        return Boolean(source);
    }

    if (source && source === translated) {
        return true;
    }

    if (targetLanguage === "ko") {
        return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(translated) && !/\p{Script=Hangul}/u.test(translated);
    }

    if (["en", "de", "sv"].includes(targetLanguage)) {
        return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}]/u.test(translated) && !/[A-Za-z]/u.test(translated);
    }

    return false;
}
