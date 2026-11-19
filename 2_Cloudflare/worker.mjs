// worker.mjs
import trio3Payload from '../1_GitHub/TRIO3.lua';
import safePayload from '../1_GitHub/SAFE.lua';

const MAX_FORM_BYTES = 1024;
const COMMON_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
});

// ဖိုင်နှစ်ခုအတွက် payload map
const PAYLOADS = Object.freeze({
  "TRIO3.lua": trio3Payload,
  "SAFE.lua": safePayload,
});

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function response(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders },
  });
}

async function readForm(request) {
  const type = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new RequestError(400, 'Expected form data');
  const length = request.headers.get('Content-Length');
  if (length !== null && !/^\d+$/.test(length)) throw new RequestError(400, 'Invalid request length');
  if (length !== null && Number(length) > MAX_FORM_BYTES) throw new RequestError(413, 'Request too large');
  let text = '';
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_FORM_BYTES) {
          await reader.cancel().catch(() => {});
          throw new RequestError(413, 'Request too large');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(400, 'Invalid request body');
    } finally {
      reader.releaseLock();
    }
  }
  const form = new URLSearchParams(text);
  if (form.getAll('key_path').length !== 1 || [...form.keys()].some(key => key !== 'key_path')) {
    throw new RequestError(400, 'Expected one key_path');
  }
  return form.get('key_path');
}

function createHandler({ payloads, basePath = '/' }) {
  if (!payloads || typeof payloads !== 'object') throw new TypeError('Payloads must be an object');
  if (typeof basePath !== 'string' || !basePath.startsWith('/') || !basePath.endsWith('/')) {
    throw new TypeError('basePath must start and end with /');
  }
  const health = JSON.stringify({ ok: true, files: Object.keys(payloads) });

  return async function fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      const isRoot = path === basePath;
      const isHealth = path === basePath + 'health';

      // ဖိုင်တစ်ခုချင်းစီအတွက် path စစ်ပါ
      let requestedFile = null;
      for (const filename of Object.keys(payloads)) {
        if (path === basePath + filename) {
          requestedFile = filename;
          break;
        }
      }

      if (!isRoot && !isHealth && !requestedFile) return response('Not found', 404);

      const method = request.method.toUpperCase();
      if (method === 'OPTIONS') return response(null, 204);

      if (method === 'GET' || method === 'HEAD') {
        if (isHealth) {
          return response(method === 'HEAD' ? null : health, 200, {
            'Content-Type': 'application/json; charset=utf-8',
          });
        }
        if (requestedFile) {
          return response(method === 'HEAD' ? null : payloads[requestedFile]);
        }
        return response('Not found', 404);
      }

      if (method === 'POST' && isRoot) {
        const keyPath = await readForm(request);
        if (!payloads[keyPath]) return response('Not found', 404);
        return response(payloads[keyPath]);
      }

      return response('Method not allowed', 405, {
        Allow: isRoot ? 'POST, OPTIONS' : 'GET, HEAD, OPTIONS',
      });
    } catch (error) {
      return error instanceof RequestError
        ? response(error.message, error.status)
        : response('Internal error', 500);
    }
  };
}

export default {
  fetch: createHandler({ payloads: PAYLOADS, basePath: "/" }),
};