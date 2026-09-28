const threadCap = Number(process.env.MANGOTL_ORT_THREADS);

/**
 * ONNX Runtime 세션 공통 옵션. MANGOTL_ORT_THREADS로 스레드 상한을 줄 수 있다.
 * 기본값(미설정)은 런타임 기본값(전 코어 사용)을 따른다.
 */
export function ortSessionOptions(defaultThreads) {
    const threads = threadCap > 0 ? threadCap : defaultThreads;
    const options = { executionProviders: ["cpu"] };
    if (threads > 0) {
        options.intraOpNumThreads = threads;
        options.interOpNumThreads = 1;
    }
    return options;
}
