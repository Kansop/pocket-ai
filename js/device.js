// Storage + memory info. Browsers only expose some of this, so anything not exact is labeled as an estimate.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MB = 1048576;

export async function getStorage() {
  const out = { supported: false, usageMB: null, quotaMB: null, freeMB: null, details: null, persisted: null };
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      out.supported = true;
      out.usageMB = (e.usage || 0) / MB;
      out.quotaMB = e.quota ? e.quota / MB : null;
      out.freeMB = out.quotaMB != null ? Math.max(0, out.quotaMB - out.usageMB) : null;
      if (e.usageDetails) out.details = Object.fromEntries(Object.entries(e.usageDetails).map(([k, v]) => [k, v / MB]));
    }
    if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
  } catch {}
  return out;
}

/** Size of each downloaded model, from the WebLLM cache (no data is read, only headers). */
export async function modelSizes(models, idFor) {
  const sizes = {};
  try {
    if (!window.caches || !(await caches.has('webllm/model'))) return sizes;
    const cache = await caches.open('webllm/model');
    const keys = await cache.keys();
    for (const m of models) {
      const ids = [m.f16, m.f32];
      let bytes = 0, files = 0, unknown = 0;
      for (const req of keys) {
        if (!ids.some(id => req.url.includes('/' + id + '/'))) continue;
        files++;
        const res = await cache.match(req);
        const len = res && +res.headers.get('content-length');
        if (len) bytes += len; else unknown++;
      }
      if (files) sizes[m.key] = { mb: bytes / MB + (unknown ? (m.downloadMB || 0) * unknown / files : 0), files, estimated: unknown > 0 };
    }
  } catch {}
  return sizes;
}

export function chatsSizeMB(chats) {
  try { return new Blob([JSON.stringify(chats)]).size / MB; } catch { return 0; }
}

export function ramInfo(gpu) {
  const r = { deviceGB: null, heapLimitMB: null, heapUsedMB: null, gpuMaxBufferMB: null, tabBudgetMB: null, exact: false, notes: [] };
  if (navigator.deviceMemory) { r.deviceGB = navigator.deviceMemory; r.notes.push('Device RAM is rounded by the browser (Chrome reports at most 8 GB).'); }
  if (performance && performance.memory) { r.heapLimitMB = performance.memory.jsHeapSizeLimit / MB; r.heapUsedMB = performance.memory.usedJSHeapSize / MB; }
  if (gpu && gpu.ok && gpu.maxBufferMB) r.gpuMaxBufferMB = gpu.maxBufferMB;
  if (isIOS) {
    // Safari exposes no memory APIs. iPhone 17e: 8 GB RAM; a single Safari tab usually gets roughly 1.5-3 GB before iOS reloads it.
    r.deviceGB = r.deviceGB || 8;
    r.tabBudgetMB = 2200;
    r.notes.push('Safari doesn\'t share memory info, so these are estimates (iPhone 17e: 8 GB; one Safari tab typically gets about 1.5–3 GB).');
  } else if (r.deviceGB) {
    // rough: a browser tab + GPU process can use about half of system RAM comfortably
    r.tabBudgetMB = r.deviceGB * 1024 * 0.5;
  }
  return r;
}

/** Warnings for loading model m on this device, given storage stats + ram info. */
export function fitCheck(m, storage, ram, alreadyDownloaded) {
  const warns = [];
  const need = (m.downloadMB || 0) * 1.1;
  if (!alreadyDownloaded && storage && storage.freeMB != null && storage.freeMB < need) {
    warns.push(`Not enough storage: needs about ${fmt(need)}, but only ~${fmt(storage.freeMB)} is free for this site.`);
  }
  if (ram && ram.tabBudgetMB && m.memMB > ram.tabBudgetMB) {
    warns.push(`May not fit in memory: needs ~${fmt(m.memMB)} but this ${isIOS ? 'iPhone tab' : 'device'} likely has ~${fmt(ram.tabBudgetMB)} to spare${ram.exact ? '' : ' (estimate)'}.`);
  } else if (ram && ram.tabBudgetMB && m.memMB > ram.tabBudgetMB * 0.75) {
    warns.push(`Tight on memory: needs ~${fmt(m.memMB)}${isIOS ? ' (Safari may reload the tab)' : ''}. Close other tabs/apps first.`);
  }
  if (ram && ram.gpuMaxBufferMB && ram.gpuMaxBufferMB < 256) warns.push('Your GPU only allows small buffers; bigger models may fail to load.');
  return warns;
}

export function fmt(mb) {
  if (mb == null || isNaN(mb)) return '?';
  return mb >= 1024 ? (mb / 1024).toFixed(mb >= 10240 ? 0 : 1) + ' GB' : mb >= 10 ? Math.round(mb) + ' MB' : mb.toFixed(1) + ' MB';
}
export { isIOS };
