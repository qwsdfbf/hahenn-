// ============================================================
//  WebGPU device
// ============================================================
const gpuCanvas = $('gpu');
if (!navigator.gpu) {
  fatal('このブラウザでは動きません', '3D の流体計算に WebGPU を使っています。最新版の Chrome、Edge、Safari（macOS 26 / iOS 26 以降）、Firefox で開いてください。');
  return;
}
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) {
  fatal('グラフィックス機能を利用できません', 'WebGPU の初期化に失敗しました。ブラウザの設定でハードウェア アクセラレーションが有効になっているか確認してください。');
  return;
}
const device = await adapter.requestDevice({
  requiredLimits: {
    maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 512 * 1024 * 1024),
    maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 * 1024 * 1024),
    maxStorageBuffersPerShaderStage: Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 8),
    maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
  },
});
let gpuErrors = 0;
device.addEventListener('uncapturederror', (e) => {
  gpuErrors++;
  if (gpuErrors < 8) console.error('WebGPU:', e.error.message);
});
device.lost.then((info) => {
  console.error('WebGPU device lost:', info.reason, info.message);
  if (info.reason !== 'destroyed') fatal('表示が中断されました', 'グラフィックスの処理がリセットされました。ページを再読み込みしてください。');
});
// Automated tests run in a headless browser whose WebGPU canvas presentation is unreliable; they set
// __offscreenPresent so frames are read back and shown through a 2D canvas instead.
const offscreenPresent = !!window.__offscreenPresent;
const gpuCtx = offscreenPresent ? null : gpuCanvas.getContext('webgpu');
const canvasFormat = offscreenPresent ? 'rgba8unorm' : navigator.gpu.getPreferredCanvasFormat();
if (gpuCtx) gpuCtx.configure({ device, format: canvasFormat, alphaMode: 'opaque' });

const BU = GPUBufferUsage;
const TU = GPUTextureUsage;
function gbuf(size, usage, label) {
  return device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage, label });
}
const pipeCache = new Map();
function computePipe(code, label) {
  const module = device.createShaderModule({ code, label });
  return device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
}
function bindGroup(pipe, entries, label) {
  return device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: Object.entries(entries).map(([b, r]) => ({ binding: +b, resource: r instanceof GPUBuffer ? { buffer: r } : r })),
    label,
  });
}
function wgCount(n) { return Math.max(1, Math.ceil(n / 256)); }
