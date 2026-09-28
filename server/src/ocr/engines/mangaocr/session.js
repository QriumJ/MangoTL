import * as ort from "onnxruntime-node";
import { createCanvas } from "ppu-ocv/canvas";
import { fetchAndCacheModel, fetchAndCacheModelPath } from "../../../utils/model-cache.js";
import { ortSessionOptions } from "../../../utils/ort-options.js";
import { HttpError } from "../../../utils/http-error.js";

export const LOG = "[MangoTL-OCR-MangaOcr]";

const SPECIAL_TOKENS = new Set(["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]);

const modelPromises = new Map();

export async function getModel(config) {
    const cacheKey = getModelCacheKey(config);
    const cached = modelPromises.get(cacheKey);

    if (cached) {
        return cached;
    }

    const modelPromise = (async () => {
        const model = config.model || {};
        const repo = String(model.repo || "").replace(/\/+$/, "");

        if (!repo || !model.encoder || !model.decoder || !model.vocab) {
            throw new HttpError(500, "ocr_config_invalid", "Manga OCR model config is incomplete (repo/encoder/decoder/vocab required).");
        }

        console.log(`${LOG} Loading manga-ocr model (first run downloads the model, ~450MB)...`);
        // 세션은 경로로 생성해 ~450MB 가중치를 mmap로 올린다(어휘는 텍스트라 버퍼 유지)
        const [encoderPath, decoderPath, vocabBuffer] = await Promise.all([
            fetchAndCacheModelPath(`${repo}/${model.encoder}`, `mangaocr-${model.encoder}`, LOG),
            fetchAndCacheModelPath(`${repo}/${model.decoder}`, `mangaocr-${model.decoder}`, LOG),
            fetchAndCacheModel(`${repo}/${model.vocab}`, `mangaocr-${model.vocab}`, LOG),
        ]);

        const [encoder, decoder] = await Promise.all([
            ort.InferenceSession.create(encoderPath, ortSessionOptions()),
            ort.InferenceSession.create(decoderPath, ortSessionOptions()),
        ]);

        const vocab = vocabBuffer
            .toString("utf-8")
            .split("\n")
            .map((token) => token.replace(/\r$/, ""));

        console.log(`${LOG} Model ready — encoder in:[${encoder.inputNames}] out:[${encoder.outputNames}]`);
        console.log(`${LOG} Model ready — decoder in:[${decoder.inputNames}] out:[${decoder.outputNames}], vocab:${vocab.length}`);

        const generation = config.generation || {};
        const image = config.image || {};

        return {
            encoder,
            decoder,
            vocab,
            io: resolveModelIo(encoder, decoder),
            decoderStartTokenId: generation.decoderStartTokenId ?? 2,
            eosTokenId: generation.eosTokenId ?? 3,
            maxLength: generation.maxLength ?? 128,
            imageSize: image.size ?? 224,
            mean: image.mean ?? 0.5,
            std: image.std ?? 0.5,
        };
    })();

    modelPromises.set(cacheKey, modelPromise);
    modelPromise.catch(() => modelPromises.delete(cacheKey));

    return modelPromise;
}

function getModelCacheKey(config) {
    const model = config.model || {};

    return JSON.stringify({
        repo: String(model.repo || "").replace(/\/+$/, ""),
        encoder: model.encoder || null,
        decoder: model.decoder || null,
        vocab: model.vocab || null,
        generation: config.generation || {},
        image: config.image || {},
    });
}

function resolveModelIo(encoder, decoder) {
    const encoderInput = encoder.inputNames.find((name) => /pixel|image|input/i.test(name)) || encoder.inputNames[0];
    const encoderOutput = encoder.outputNames.find((name) => /hidden|last/i.test(name)) || encoder.outputNames[0];

    const decoderInputIds =
        decoder.inputNames.find((name) => /input_ids|^ids$|tokens/i.test(name)) || decoder.inputNames.find((name) => !/encoder|mask/i.test(name));
    const decoderEncoderHidden = decoder.inputNames.find((name) => /encoder_hidden|hidden/i.test(name));
    const decoderEncoderMask = decoder.inputNames.find((name) => /attention_mask|encoder_attention/i.test(name));
    const decoderOutput = decoder.outputNames.find((name) => /logits|prediction/i.test(name)) || decoder.outputNames[0];

    if (!encoderInput || !encoderOutput || !decoderInputIds || !decoderEncoderHidden || !decoderOutput) {
        throw new HttpError(
            500,
            "ocr_boot_failed",
            `Could not resolve manga-ocr model I/O. encoder in:[${encoder.inputNames}] out:[${encoder.outputNames}], decoder in:[${decoder.inputNames}] out:[${decoder.outputNames}]`,
        );
    }

    return { encoderInput, encoderOutput, decoderInputIds, decoderEncoderHidden, decoderEncoderMask, decoderOutput };
}

export async function recognizeRegion(cropCanvas, model) {
    const [result] = await recognizeRegionsBatch([cropCanvas], model);
    return result;
}

/**
 * 여러 크롭을 배치 인코더/디코더 패스로 인식한다. 내보낸 모델이 동적 배치
 * 차원을 받으므로 크롭 N개가 인코더 1회 + 락스텝 디코더 1패스로 끝난다.
 * 결과 순서는 입력 크롭 순서를 그대로 따른다.
 */
export async function recognizeRegionsBatch(cropCanvases, model, batchSize = 8) {
    const results = [];
    for (let offset = 0; offset < cropCanvases.length; offset += batchSize) {
        const chunk = cropCanvases.slice(offset, offset + batchSize);
        results.push(...(await recognizeChunk(chunk, model)));
    }
    return results;
}

async function recognizeChunk(chunk, model) {
    const { io } = model;
    const pixelValues = canvasToPixelTensorBatch(chunk, model);
    const encoderOutput = await model.encoder.run({ [io.encoderInput]: pixelValues });
    const encoderHidden = encoderOutput[io.encoderOutput];
    const batch = chunk.length;
    const maskLength = encoderHidden.dims[1];

    const sequences = chunk.map(() => ({ ids: [model.decoderStartTokenId], done: false, confidenceSum: 0, confidenceCount: 0 }));

    for (let step = 0; step < model.maxLength; step += 1) {
        if (sequences.every((sequence) => sequence.done)) break;

        // 완료된 시퀀스는 ids가 짧으므로 최대 길이에 맞춰 EOS로 패딩한다
        const width = Math.max(...sequences.map((sequence) => sequence.ids.length));
        const inputIds = new BigInt64Array(batch * width);
        for (let row = 0; row < batch; row += 1) {
            const ids = sequences[row].ids;
            for (let col = 0; col < width; col += 1) {
                inputIds[row * width + col] = BigInt(col < ids.length ? ids[col] : model.eosTokenId);
            }
        }
        const feeds = {
            [io.decoderInputIds]: new ort.Tensor("int64", inputIds, [batch, width]),
            [io.decoderEncoderHidden]: encoderHidden,
        };
        if (io.decoderEncoderMask) {
            feeds[io.decoderEncoderMask] = new ort.Tensor("int64", new BigInt64Array(batch * maskLength).fill(1n), [batch, maskLength]);
        }

        const decoded = await model.decoder.run(feeds);
        const tokenIds = argmaxLastStepBatch(decoded[io.decoderOutput], batch);

        for (let row = 0; row < batch; row += 1) {
            const sequence = sequences[row];
            if (sequence.done) continue;
            const { tokenId, probability } = tokenIds[row];
            sequence.confidenceSum += probability;
            sequence.confidenceCount += 1;
            if (tokenId === model.eosTokenId) {
                sequence.done = true;
            } else {
                sequence.ids.push(tokenId);
            }
        }
    }

    return sequences.map((sequence) => ({
        text: decodeTokens(sequence.ids.slice(1), model.vocab),
        confidence: sequence.confidenceCount ? sequence.confidenceSum / sequence.confidenceCount : 0,
    }));
}

function argmaxLastStepBatch(logits, batch) {
    const { dims, data } = logits;
    const vocab = dims[dims.length - 1];
    const steps = dims[dims.length - 2];
    const results = [];
    for (let row = 0; row < batch; row += 1) {
        const base = (row * steps + (steps - 1)) * vocab;
        let bestIndex = 0;
        let bestValue = -Infinity;
        for (let i = 0; i < vocab; i += 1) {
            if (data[base + i] > bestValue) {
                bestValue = data[base + i];
                bestIndex = i;
            }
        }
        // 선택 토큰의 softmax 확률(수치 안정화 포함) — 기존 단건 경로와 동일
        let expSum = 0;
        for (let i = 0; i < vocab; i += 1) {
            expSum += Math.exp(data[base + i] - bestValue);
        }
        results.push({ tokenId: bestIndex, probability: expSum > 0 ? 1 / expSum : 0 });
    }
    return results;
}

export function cropRegion(sourceCanvas, box, size) {
    const sourceX = Math.max(0, Math.min(box.x, sourceCanvas.width - 1));
    const sourceY = Math.max(0, Math.min(box.y, sourceCanvas.height - 1));
    const sourceWidth = Math.max(1, Math.min(box.width, sourceCanvas.width - sourceX));
    const sourceHeight = Math.max(1, Math.min(box.height, sourceCanvas.height - sourceY));

    const canvas = createCanvas(size, size);
    canvas.getContext("2d").drawImage(sourceCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, size, size);
    return canvas;
}

function canvasToPixelTensorBatch(canvases, model) {
    const size = model.imageSize;
    const plane = size * size;
    const batch = canvases.length;
    const tensor = new Float32Array(batch * 3 * plane);

    // (value / 255 - mean) / std  ==  value * scale - shift
    const scale = 1 / (255 * model.std);
    const shift = model.mean / model.std;

    for (let image = 0; image < batch; image += 1) {
        const data = canvases[image].getContext("2d").getImageData(0, 0, size, size).data;
        const offset = image * 3 * plane;
        for (let i = 0; i < plane; i += 1) {
            const pixel = i * 4;
            tensor[offset + i] = data[pixel] * scale - shift;
            tensor[offset + plane + i] = data[pixel + 1] * scale - shift;
            tensor[offset + 2 * plane + i] = data[pixel + 2] * scale - shift;
        }
    }

    return new ort.Tensor("float32", tensor, [batch, 3, size, size]);
}

function decodeTokens(tokenIds, vocab) {
    let text = "";

    for (const id of tokenIds) {
        const token = vocab[id];
        if (token === undefined || SPECIAL_TOKENS.has(token)) {
            continue;
        }
        text += token.startsWith("##") ? token.slice(2) : token;
    }

    return text.replace(/\s+/g, "").trim();
}
