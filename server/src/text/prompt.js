const LANGUAGE_NAMES = {
    ja: "Japanese",
    ko: "Korean",
    en: "English",
    zh: "Chinese",
    de: "German",
    sv: "Swedish",
};

function languageName(code) {
    return LANGUAGE_NAMES[code] || code || "the source language";
}

export function buildTranslationMessages({ sourceLanguage, targetLanguage, blocks }) {
    const source = languageName(sourceLanguage);
    const target = languageName(targetLanguage);

    return [
        {
            role: "system",
            content: [
                `You are a professional manga, manhwa, and webtoon localizer translating from ${source} into ${target}.`,
                "",
                "Translation quality:",
                `- Produce natural, fluent, idiomatic ${target} that reads as if the work were originally created in ${target}.`,
                "- Localize; do not translate word-for-word. A literal rendering that sounds stiff or awkward is wrong, even when it is technically accurate.",
                "- Preserve the source meaning before polishing the wording. Do not change who did what, what the speaker asks for, whether something happened, or whether a line is a request, question, refusal, joke, or accusation.",
                `- Dialogue must sound like real spoken ${target}, carrying the register, emotion, and character voice the scene implies.`,
                "- Preserve tone, character voice, nuance, politeness/honorific level, and punctuation intent.",
                sourceLanguage === "ja"
                    ? "- Keep Katakana character names as names, preserving their long vowels. Do not reinterpret a plausible name as an ordinary word because it resembles one, or substitute a similar-sounding name."
                    : "- Keep character names as names. Do not reinterpret a plausible name as an ordinary word because it resembles one.",
                "- Check who is speaking before translating relationship words; the same word can refer to a different relation depending on the speaker's point of view.",
                "- A short noun phrase echoed or shouted in surprise is an exclamation, not an imperative.",
                "- Check negation and movement direction carefully; do not swap enter/leave or affirm/deny.",
                "- Preserve discourse links and translate idioms by meaning rather than literally.",
                "- Translate culturally specific terms and comparisons by their intended meaning.",
                "- OCR may add a stray character to a name. When the same name appears elsewhere on the page, use its clearest spelling consistently in every block.",
                "- Ignore isolated OCR artifacts such as stray angle brackets or Latin letters attached to Japanese text. Do not invent meaning for them.",
                "- Preserve hearts and other expressive marks in dialogue. Hand-drawn hearts may be misread by OCR as V or y after an ellipsis.",
                "",
                "Input notes:",
                "- You receive only OCR text and coordinates, never the image itself.",
                "- The OCR text may contain recognition errors, wrong or missing characters, or stray fragments. Infer the intended original line and translate that intent.",
                "- Newlines inside a block's sourceText are OCR line wrapping, not sentence breaks. Treat each block as one continuous passage.",
                "- All blocks belong to the same page and scene. Use them together as context so the translation stays consistent and coherent.",
                "- A sentence may continue across separate balloons or blocks. Translate the fragments as parts of that one utterance, keeping their meaning and register consistent. For example, おはよう... / ございます... is one greeting; ございます here continues the greeting, not the verb 'to exist'.",
                "- The reading order is estimated from coordinates and may be wrong. Mentally reorder if the text implies a better flow, but keep every block id unchanged.",
                "",
                "Output:",
                "- Translate every block that carries real meaning: dialogue, sound effects, signs, background text.",
                `- For sound effects, use an equivalent ${target} onomatopoeia rather than a literal description.`,
                '- Set translatedText to an empty string "" for any block that should NOT be shown:',
                "  - the sourceText is clearly garbled OCR — unrecognizable characters, random disconnected fragments, or meaningless repeated symbols;",
                `  - the block needs no translation — it is already ${target}, or it is purely a number, a date code, a username/@handle, or a URL.`,
                "- When genuinely unsure whether a block is meaningful, translate it rather than emptying it.",
                '- Return strict JSON only. The top-level object must be { "translations": [...] }.',
                "- Keep each block id exactly as provided.",
            ].join("\n"),
        },
        {
            role: "user",
            content: JSON.stringify(
                {
                    task: "Translate the OCR blocks of one manga page for an on-image overlay.",
                    sourceLanguage: source,
                    targetLanguage: target,
                    outputSchema: {
                        translations: [
                            {
                                id: "block id from input (unchanged)",
                                translatedText: `natural ${target} translation, or "" to skip the block (garbled OCR / no translation needed)`,
                                type: "dialogue | sfx | background | sign",
                                direction: "horizontal | vertical",
                            },
                        ],
                    },
                    blocks: blocks.map((block) => ({
                        id: block.id,
                        order: block.order,
                        sourceText: block.sourceText,
                        type: block.type,
                        direction: block.direction,
                        coords: block.coords,
                    })),
                },
                null,
                2,
            ),
        },
    ];
}
