import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { FIRST_BYTE_TIMEOUT_MS, LAST_RESORT_FIRST_BYTE_MS, SLOW_WINDOW_MS, tooSlow } from '../../core/src/download-source.mjs';

// 不写死版本号：发版后 UA 不会和 package.json 对不上。
export const USER_AGENT = 'LMCL (github.com/llroxy-by/LMCL)';

// 只有网络层错误值得重试；校验失败、大小不符说明文件本身有问题，重试没意义。
const NETWORK = /fetch failed|socket|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET|EPIPE/i;

function describe(error) {
  const cause = error?.cause?.code || error?.cause?.message;
  return cause && !String(error.message).includes(cause) ? `${error.message}（${cause}）` : error.message;
}

function retryable(error) {
  return NETWORK.test(String(error?.message)) || NETWORK.test(String(error?.cause?.code ?? ''));
}

async function attempt(url, temporary, { size, maxBytes, sha1, sha512, signal, onProgress, enforceSpeed, firstByteTimeout }) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let handle, stalled = false;
  // 首字节超时：连得上但迟迟不吐数据，也算这个源不可用。
  const timer = setTimeout(() => { stalled = true; controller.abort(); }, firstByteTimeout);
  try {
    const response = await fetch(url, { signal: combined, headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('响应没有内容');
    handle = await open(temporary, 'w');
    const digest1 = createHash('sha1'), digest512 = createHash('sha512');
    let bytes = 0, lastReport = 0, first = true;
    // 滑动窗口：只看最近一个窗口的速度，避免 TCP 慢启动和瞬时抖动被算成「整体太慢」。
    let windowBytes = 0, windowStart = 0;
    for await (const chunk of response.body) {
      if (first) { first = false; clearTimeout(timer); windowStart = Date.now(); }
      bytes += chunk.length;
      windowBytes += chunk.length;
      if (size != null && bytes > size) throw new Error('下载内容超出预期大小');
      if (maxBytes != null && bytes > maxBytes) throw new Error('文件超出大小限制');
      digest1.update(chunk); digest512.update(chunk);
      await handle.write(chunk);
      const windowElapsed = Date.now() - windowStart;
      // 只有还存在备用源时才按速度弃用；最后一个源再慢也要下完。
      if (enforceSpeed && tooSlow({ bytes: windowBytes, elapsedMs: windowElapsed })) throw new Error('下载速度过慢');
      if (windowElapsed >= SLOW_WINDOW_MS) { windowBytes = 0; windowStart = Date.now(); }
      const now = Date.now();
      if (now - lastReport > 150 || (size != null && bytes === size)) {
        lastReport = now;
        onProgress?.({ done: bytes, total: size ?? null,
          bytesPerSecond: windowElapsed > 0 ? Math.round(windowBytes * 1000 / windowElapsed) : 0 });
      }
    }
    if (stalled) throw new Error('等待数据超时');
    if (size != null && bytes !== size) throw new Error('文件大小不符');
    if (sha1 && digest1.digest('hex') !== sha1) throw new Error('文件校验失败');
    if (sha512 && digest512.digest('hex') !== sha512) throw new Error('文件校验失败');
  } catch (error) {
    if (stalled) throw new Error('连接超时');
    throw error;
  } finally {
    clearTimeout(timer);
    await handle?.close().catch(() => {});
  }
}

/**
 * Downloads one file, trying each URL in order. A source is abandoned when it
 * errors, sends no first byte within the timeout, or stays below the minimum
 * rate. Hash verification happens per attempt so a bad mirror cannot win.
 */
export async function transfer({ urls, destination, size = null, maxBytes = null, sha1 = null, sha512 = null, signal, onProgress }) {
  if (!Array.isArray(urls) || !urls.length) throw new Error('缺少可用的下载地址');
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  const failures = [];
  for (const [index, url] of urls.entries()) {
    const hasFallback = index < urls.length - 1;
    let last;
    // 同一源最多试两次：家用网络偶尔抖一下，重试比重开一次源更划算。
    for (let round = 0; round < 2; round++) {
      if (signal?.aborted) throw signal.reason ?? new Error('已取消');
      try {
        await attempt(url, temporary, { size, maxBytes, sha1, sha512, signal, onProgress, enforceSpeed: hasFallback,
          firstByteTimeout: hasFallback ? FIRST_BYTE_TIMEOUT_MS : LAST_RESORT_FIRST_BYTE_MS });
        await rename(temporary, destination);
        return { url, index, failures };
      } catch (error) {
        await rm(temporary, { force: true });
        if (signal?.aborted) throw error;
        last = error;
        if (!retryable(error) || round === 1) break;
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    failures.push(describe(last));
  }
  throw new Error(`下载失败：${failures.join('；')}`);
}
