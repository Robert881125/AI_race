const runtimeUrl = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
const modelId = 'Xenova/segformer-b0-finetuned-cityscapes-512-1024';
const modelRevision = '18b12204d4c787afb8df24e49efc36a20d9f16d0';

let model;

self.onmessage = async ({ data: pixels }) => {
  try {
    if (!model) {
      const { env, pipeline, RawImage } = await import(runtimeUrl);
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      const segment = await pipeline('image-segmentation', modelId, {
        revision: modelRevision, device: 'wasm', dtype: 'q8',
      });
      model = { segment, RawImage };
    }
    const { segment, RawImage } = model;
    const result = await segment(new RawImage(pixels.data, pixels.width, pixels.height, 4));
    const labels = result.map(({ label, mask: { data, width, height } }) =>
      ({ label, mask: { data, width, height } }));
    self.postMessage({ labels }, [...new Set(labels.map(({ mask }) => mask.data.buffer))]);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
