'use strict';

// Browser transports shared by the full studio and the floating workbench.
window.PoseWearImageProviders = (() => {
  const providers = {
    openai: {
      name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-image-1',
      models: ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-2', 'dall-e-2']
    },
    gemini: {
      name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash-image',
      models: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image']
    },
    seedream: {
      name: '豆包 Seedream', base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-5-261028',
      models: ['doubao-seedream-5-5-261028', 'doubao-seedream-5-0-flash-260915', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828']
    },
    uncensored: {
      name: 'OpenUncensored', base: 'https://api.openuncensored.com/v1', model: 'lustify-v8',
      models: [
        'lustify-v8', 'qwen-image-3-edit', 'qwen-edit-uncensored', 'seedream-v5-5-edit',
        'z-image-turbo', 'chroma', 'qwen-image-3-uncensored', 'hidream-o1-dev',
        'juggernaut-xl', 'cyberrealistic-xl', 'pony-realism', 'wai-illustrious'
      ]
    },
    custom: {
      name: '自定义中转', base: '', model: 'gpt-image-1',
      models: ['gpt-image-1', 'gpt-image-2', 'grok-imagine-image-2.0', 'gemini-2.5-flash-image', 'flux-kontext-pro', 'qwen-image-edit', 'doubao-seedream-4-0-250828']
    }
  };

  const officialHost = /^(api\.openai\.com|generativelanguage\.googleapis\.com|ark\.[a-z0-9-]+\.(volces|bytepluses)\.com)$/;
  const imageSizes = { '2:3': '1024x1536', '3:4': '1024x1536', '9:16': '1024x1536', '1:1': '1024x1024', '4:3': '1536x1024', '16:9': '1536x1024' };
  const seedreamSizes = { auto: '1728x2304', '2:3': '1664x2496', '3:4': '1728x2304', '9:16': '1440x2560', '1:1': '2048x2048', '4:3': '2304x1728', '16:9': '2560x1440' };
  // OpenUncensored 只认这几档画幅（其余传 auto 由服务端决定）；模型对照表见 GET /v1/images/models
  const ouSizes = { '2:3': '1024x1536', '3:4': '1024x1536', '9:16': '1024x1792', '1:1': '1024x1024', '4:3': '1536x1024', '16:9': '1792x1024' };
  const ouEditRefs = { 'qwen-edit-uncensored': 3, 'qwen-image-3-edit': 3, 'seedream-v5-5-edit': 10 };
  const ouEditOnly = /^(qwen-edit-uncensored|qwen-image-3-edit|seedream-v5-5-edit)$/;
  // Civitai 的 SDXL checkpoint 才有图生图 strength；Qwen / Seedream 编辑模型不认这个字段
  const ouSdxl = /^(lustify|juggernaut|cyberrealistic|pornmaster|pony|wai|hassaku|noobai)/;
  const textOnlyWarning = '当前模型未接收参考图，本次仅按提示词生成。';

  function protocol(settings) {
    if (settings.prov === 'openai') return 'edits';
    if (settings.prov === 'custom') return settings.proto;
    return settings.prov;
  }

  function hostOf(base) {
    try { return new URL(base).hostname } catch (error) { return '' }
  }

  function apiBase(settings) {
    const base = (settings.base || providers[settings.prov].base).trim().replace(/\/+$/, '');
    if (protocol(settings) === 'gemini' && /\/v1(beta|alpha)?$/.test(base)) return base;
    if (settings.prov === 'gemini') return base + '/v1beta';
    if (settings.prov === 'seedream') return base;
    return /\/v\d+$/.test(base) ? base : base + '/v1';
  }

  function proxied(url, settings, options, headers) {
    const forward = new Headers(headers);
    forward.set('x-target-url', url);
    if (settings.prov === 'custom' || !officialHost.test(new URL(url).hostname)) forward.set('x-proxy-custom', '1');
    return fetch('/api/proxy', { ...options, headers: forward });
  }

  function bodyBytes(body) {
    if (typeof body === 'string') return body.length;
    if (body instanceof FormData) {
      let total = 0;
      for (const value of body.values()) total += typeof value === 'string' ? value.length : (value.size || 0);
      return total;
    }
    return 0;
  }

  function netError(error, meta, viaProxy) {
    const wrapped = new TypeError((error && error.message) || 'Failed to fetch');
    Object.assign(wrapped, meta, { elapsed: Date.now() - meta.started, viaProxy });
    return wrapped;
  }

  function request(settings, path, options) {
    const url = apiBase(settings) + path;
    const headers = new Headers(options.headers);
    if (protocol(settings) === 'gemini') headers.set('x-goog-api-key', settings.key);
    else headers.set('Authorization', 'Bearer ' + settings.key);
    const meta = { url, method: options.method || 'GET', bytes: bodyBytes(options.body), started: Date.now() };
    if (settings.proxy) {
      return proxied(url, settings, options, headers).catch(error => {
        if (error?.name === 'AbortError') throw error;
        throw netError(error, meta, true);
      });
    }
    // 直连被 CORS 或网络层拒绝时立刻改走本站同源转发重试一次：服务端不受 CORS 约束，
    // 也能把「限流 / 风控 / 额度 / 该路径不存在」的真实 HTTP 状态回传，而不是一律显示成「网络不通」。
    return fetch(url, { ...options, headers }).catch(error => {
      if (error?.name === 'AbortError') throw error;
      return proxied(url, settings, options, headers).catch(retryError => {
        if (retryError?.name === 'AbortError') throw retryError;
        throw netError(retryError || error, meta, true);
      });
    });
  }

  function redact(text, key) {
    const value = String(text);
    return key ? value.split(key).join('***') : value;
  }

  const safetyReason = /safety system|safety_violations|moderation_blocked|content_policy_violation|content policy|SensitiveContent|sensitive content|PROHIBITED_CONTENT|IMAGE_SAFETY|\bSAFETY\b|BLOCKLIST|SPII|blocked by|内容安全|敏感/i;
  const categories = [
    [/minor|child|CSAM/i, '涉及未成年人'], [/sexual|SEXUALLY_EXPLICIT|nudity|porn|色情/i, '性感/暴露内容'],
    [/violen|gore|血腥|暴力/i, '暴力或血腥'], [/self-?harm/i, '自残'], [/hate|HATE_SPEECH/i, '仇恨'],
    [/harass/i, '骚扰'], [/illicit|DANGEROUS/i, '危险或违法内容'], [/SPII|personal/i, '个人隐私信息'],
    [/copyright|RECITATION|trademark/i, '版权内容']
  ];

  function safetyError(message, data, requestId, key) {
    const text = message + ' ' + JSON.stringify(data || '');
    if (!safetyReason.test(text)) return null;
    const error = Error(redact(message || 'safety', key));
    error.safe = {
      cats: categories.filter(([match]) => match.test(text)).map(([, label]) => label),
      where: /InputImage|input image/i.test(text) ? 'in' : /OutputImage|output/i.test(text) ? 'out' : '',
      rid: redact(requestId || text.match(/req_[A-Za-z0-9]+/)?.[0] || '', key)
    };
    error.raw = redact(message.trim(), key) || redact(text, key).slice(0, 600);
    error.zh = '被服务商的安全审核拦下了';
    return error;
  }

  const statusMessages = {
    400: '请求参数有误：模型、画幅或图片格式可能不受支持',
    401: '密钥无效或已过期，请检查 API Key',
    403: '没有权限：密钥无此模型权限、账户未验证，或所在地区不受支持',
    404: '地址或模型不存在：请检查 Base URL 和模型名',
    413: '图片太大，请换一张更小的照片',
    429: '请求过于频繁或额度已用完，请稍后再试或检查账户余额',
    500: '服务商内部错误，请稍后重试', 502: '网关错误（中转服务不可用）',
    503: '服务暂时不可用，请稍后重试', 504: '服务商响应超时，请重试'
  };

  function htmlTitle(text) {
    const match = String(text || '').match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim() : '';
  }

  function apiError(reply, data, settings, text) {
    const type = (reply.headers.get('content-type') || '').toLowerCase();
    const raw = typeof text === 'string' ? text.trim() : '';
    const isHtml = /html/i.test(type) || /^\s*</.test(raw);
    let detail = data?.error?.message || data?.message || '';
    if (!detail && raw && !isHtml) detail = raw.slice(0, 400);
    if (!detail) detail = reply.statusText;
    const message = redact(typeof detail === 'string' ? detail : JSON.stringify(detail), settings.key);
    const requestId = data?.error?.request_id || reply.headers.get('x-request-id');
    const blocked = safetyError(message, data, requestId, settings.key);
    if (blocked) {
      blocked.status = reply.status;
      return blocked;
    }
    let reason = statusMessages[reply.status] || '请求失败（HTTP ' + reply.status + '）';
    if (isHtml) {
      const title = htmlTitle(raw);
      reason = '服务商返回的是网页而不是接口数据（HTTP ' + reply.status + (title ? '，' + title.slice(0, 60) : '') +
        '）：多半是该地址下没有对外开放这个接口，或被中转站/网关拦截。';
    }
    if (/AccountOverdue|overdue balance|insufficient.?balance|余额不足|欠费/i.test(message + ' ' + JSON.stringify(data))) {
      reason = '服务商账户欠费或余额不足，充值后即可恢复（本次请求没有消耗额度）';
    }
    const unsupported = message.match(/Argument not supported:\s*(\w+)/i);
    if (/API_KEY_INVALID|API key not valid|invalid api key|Incorrect API key|AuthenticationError|InvalidApiKey/i.test(message + ' ' + JSON.stringify(data))) {
      reason = statusMessages[401];
    } else if (unsupported) {
      reason = '该服务商不支持 ' + unsupported[1] + ' 参数，请检查「接口协议」设置';
    }
    const error = Error(message);
    error.status = reply.status;
    error.contentType = type;
    error.bodyPreview = raw.slice(0, 300);
    error.zh = reason + (message && !isHtml ? '\n服务商返回：' + message.slice(0, 300) : '');
    return error;
  }

  function nice(error) {
    if (error.name === 'AbortError') return '已取消';
    if (error instanceof TypeError) {
      const detail = String(error.message || '').trim();
      const lines = [
        '无法连接到服务商（' + (error.viaProxy ? '已自动改走本站代理，仍失败' : '直连失败') + '）。',
        (error.method || '') + ' ' + (error.url || '') + (error.elapsed ? '，耗时 ' + error.elapsed + 'ms' : '') +
          (error.bytes ? '，请求体 ' + Math.round(error.bytes / 1024) + 'KB' : ''),
        '若「测试连接」正常而生成失败，通常是该地址没有开放 /images 端点（或只支持 /images/generations），也可能是网关拦了这次 POST。'
      ];
      if (detail && detail !== 'Failed to fetch') lines.push('底层报错：' + detail);
      return lines.filter(Boolean).join('\n');
    }
    return error.zh || error.message || String(error);
  }

  async function testConnection(settings, model, signal) {
    const gemini = protocol(settings) === 'gemini';
    // OpenUncensored 的图片模型在 /images/models，/models 只有文本模型
    const uncensored = settings.prov === 'uncensored';
    const path = gemini ? '/models/' + encodeURIComponent(model) : uncensored ? '/images/models' : '/models';
    const reply = await request(settings, path, { method: 'GET', signal });
    const text = await reply.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!reply.ok) {
      if (settings.prov === 'seedream' && reply.status === 404) {
        if (reply.headers.get('content-type')?.includes('text/html')) {
          throw Error('本站代理未生效（/api/proxy 返回了网页内容），请稍后再试或联系站长');
        }
        return '地址可达，方舟未提供模型列表。请通过生成验证密钥与模型。';
      }
      throw apiError(reply, data, settings, text);
    }
    if (gemini && (data?.name || data?.displayName)) return '连接成功：模型 ' + (data.displayName || model) + ' 可用';
    if (gemini || !Array.isArray(data?.data) || data.data.some(entry => typeof entry?.id !== 'string')) {
      throw Error('接口未返回模型信息，请检查 Base URL 与接口协议。');
    }
    const ids = data.data.map(entry => entry.id);
    let message = '连接成功：共 ' + ids.length + (uncensored ? ' 个图片模型' : ' 个模型');
    if (ids.length) message += ids.includes(model) ? '，包含 ' + model : '，但未找到 ' + model + '（中转可能不列出，可直接尝试）';
    return message;
  }

  async function readResponse(job, path, body) {
    const options = { method: 'POST', body, signal: job.signal };
    if (!(body instanceof FormData)) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const reply = await request(job.settings, path, options);
    const text = await reply.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    job.signal.throwIfAborted();
    if (!reply.ok) throw apiError(reply, data, job.settings, text);
    if (!data) throw apiError(reply, null, job.settings, text);
    return data;
  }

  function base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  const MAX_EDGE = 1536, MAX_BYTES = 900 * 1024;

  // 参考图在发送前统一压到长边 1536 / ≤900KB：连续创作时参考图越加越多，
  // data URL 会让请求体线性膨胀到几十 MB，网关/CORS 层会直接掐断连接。
  async function shrink(blob) {
    if (!blob || !/^image\/(jpeg|png|webp)$/.test(blob.type || '')) return blob;
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && blob.size <= MAX_BYTES) {
        bitmap.close?.();
        return blob;
      }
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale))
      );
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      return out.size < blob.size ? out : blob;
    } catch (error) {
      return blob;
    }
  }

  async function dataURL(blob) {
    const small = await shrink(blob);
    return 'data:' + (small.type || 'image/jpeg') + ';base64,' + await base64(small);
  }

  async function resultBlob(data, job) {
    const image = data?.data?.[0];
    if (image?.b64_json) return (await fetch('data:image/png;base64,' + image.b64_json)).blob();
    if (!image?.url) throw Error('服务商没有返回图片数据' + (data?.error?.message ? '：' + redact(data.error.message, job.settings.key) : ''));
    const { url } = image;
    let reply = await fetch(url, { signal: job.signal }).catch(() => null);
    if (!reply?.ok) reply = await fetch('/api/proxy', {
      signal: job.signal,
      headers: {
        'x-target-url': url,
        'x-proxy-kind': 'image',
        ...(job.settings.prov === 'custom' ? { 'x-proxy-custom': '1' } : {})
      }
    }).catch(() => null);
    if (!reply?.ok) throw Error('结果图片下载失败，请直接打开：' + redact(url, job.settings.key));
    return reply.blob();
  }

  async function generateLocal(job) {
    const { images, prompt, ratio, checkpoint, signal, roles = [] } = job;
    const form = new FormData();
    form.set('prompt', prompt);
    if (checkpoint) form.set('checkpoint', checkpoint);
    if (ratio !== 'auto') {
      const [width, height] = ratio.split(':').map(Number);
      const unit = 1024 / Math.max(width, height);
      const pixels = n => Math.round(n * unit / 8) * 8;
      form.set('size', pixels(width) + 'x' + pixels(height));
    }
    // role[] 与 image[] 同序：ComfyUI 多参考图按角色分配 IPAdapter 权重。
    images.forEach((image, i) => {
      form.append('image[]', image, 'reference-' + (i + 1) + '.jpg');
      form.append('role[]', roles[i] || 'extra');
    });
    const reply = await fetch('/api/local/generate', { method: 'POST', headers: { 'x-posewear-local': '1' }, body: form, signal });
    if (!reply.ok) throw Error(await reply.text());
    return { blob: await reply.blob() };
  }

  async function generateGemini(job) {
    const parts = [{ text: job.prompt }];
    for (const image of job.images) {
      parts.push({ inline_data: { mime_type: image.type || 'image/jpeg', data: await base64(image) } });
    }
    const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    if (job.ratio !== 'auto') generationConfig.imageConfig = { aspectRatio: job.ratio };
    const data = await readResponse(job, '/models/' + encodeURIComponent(job.model) + ':generateContent', {
      contents: [{ role: 'user', parts }], generationConfig
    });
    const candidates = data?.candidates || [];
    const output = candidates.flatMap(candidate => candidate.content?.parts || []);
    const image = output.map(part => part.inlineData || part.inline_data).find(part => part?.data);
    if (image) return { blob: await (await fetch('data:' + (image.mimeType || image.mime_type || 'image/png') + ';base64,' + image.data)).blob() };

    const candidate = candidates[0];
    const reason = data?.promptFeedback?.blockReason || candidate?.finishReason;
    if (reason && /SAFETY|PROHIBITED|BLOCKLIST|SPII|OTHER/i.test(reason)) {
      const ratings = (candidate?.safetyRatings || []).filter(rating => rating.blocked || /HIGH|MEDIUM/.test(rating.probability));
      const detail = [reason, ...ratings.map(rating => rating.category), candidate?.finishMessage].filter(Boolean).join(' ');
      const blocked = safetyError(detail, null, data?.responseId, job.settings.key);
      if (blocked) throw blocked;
    }
    const text = redact(output.map(part => part.text).filter(Boolean).join(' '), job.settings.key);
    throw Error('模型没有返回图片' + (reason ? '（' + reason + '，可能触发了安全策略）' : '') + (text ? '\n模型回复：' + text.slice(0, 300) : ''));
  }

  async function generations(job, params, images = job.images) {
    const body = { model: job.model, prompt: job.prompt, n: 1, ...params };
    if (images.length) body.image = await Promise.all(images.map(dataURL));
    return resultBlob(await readResponse(job, '/images/generations', body), job);
  }

  async function generateSeedream(job) {
    const params = { size: seedreamSizes[job.ratio] || seedreamSizes.auto, response_format: 'b64_json', watermark: false };
    if (/seedream-4/.test(job.model)) params.sequential_image_generation = 'disabled';
    try {
      return { blob: await generations(job, params) };
    } catch (error) {
      if (!job.images.length || error.safe || error.status !== 400 || !/image|参考/i.test(error.message)) throw error;
      return { blob: await generations(job, params, []), warn: textOnlyWarning };
    }
  }

  async function generateXai(job) {
    const body = { model: job.model, prompt: job.prompt, n: 1, response_format: 'b64_json' };
    if (job.ratio !== 'auto') body.aspect_ratio = job.ratio;
    const urls = await Promise.all(job.images.slice(0, 5).map(dataURL));
    if (urls.length === 1) body.image = { url: urls[0] };
    if (urls.length > 1) body.images = urls.map(url => ({ url }));
    const path = urls.length ? '/images/edits' : '/images/generations';
    return {
      blob: await resultBlob(await readResponse(job, path, body), job),
      warn: job.images.length > 5 ? 'xAI 参考图最多 5 张，已只发送前 5 张。' : ''
    };
  }

  async function edits(job, size, field) {
    const form = new FormData();
    const single = job.model === 'dall-e-2';
    form.set('model', job.model);
    form.set('prompt', job.prompt);
    const images = single ? job.images.slice(0, 1) : job.images;
    for (let i = 0; i < images.length; i++) form.append(field, await shrink(images[i]), 'ref-' + (i + 1) + '.jpg');
    form.set('n', '1');
    form.set('size', single && size === 'auto' ? '1024x1024' : size);
    return resultBlob(await readResponse(job, '/images/edits', form), job);
  }

  async function generateOpenAI(job) {
    const size = imageSizes[job.ratio] || (/^gpt-image/.test(job.model) ? 'auto' : '1024x1024');
    if (protocol(job.settings) === 'json' || !job.images.length) return { blob: await generations(job, { size }) };
    // 火山方舟只有 /images/generations（/images/edits 是 404 且不带 CORS 头），直接按 generations 发，省一次失败请求
    if (/(^|\.)volces\.com$|(^|\.)bytepluses\.com$/i.test(hostOf(job.settings.base))) {
      return { blob: await generations(job, { size }) };
    }
    const field = job.settings.prov === 'custom' ? job.settings.field : 'image[]';
    try {
      return { blob: await edits(job, size, field) };
    } catch (error) {
      // 该服务商根本没有 /images/edits（典型：火山方舟只有 /images/generations）。
      // 这类 404 往往不带 CORS 头，浏览器只报「网络不通」，所以这里直接换到 generations 重试。
      if (error.name === 'AbortError' || error.safe) throw error;
      if (error.status === 404) {
        return {
          blob: await generations(job, { size }),
          warn: '该服务商没有 /images/edits 接口，已自动改用 /images/generations 发送参考图。'
        };
      }
      // 只对「图片字段名不对」这一种已知情况换字段重试一次；其余错误直接报出，不静默换协议或丢参考图
      if (error.status !== 400 || !/image/i.test(error.message) || /safety|moderation|reject/i.test(error.message)) throw error;
      const alternate = field === 'image[]' ? 'image' : 'image[]';
      return { blob: await edits(job, size, alternate), warn: '已自动改用另一种图片字段名重试成功。' };
    }
  }

  // OpenUncensored：无审查模型聚合网关（OpenAI 兼容）。文生图走 /images/generations，
  // 带参考图走 /images/edits 的 multipart，SDXL 系 checkpoint 用 strength 控制保留程度。
  async function generateUncensored(job) {
    const size = ouSizes[job.ratio] || 'auto';
    const images = job.images.slice(0, ouEditRefs[job.model] || 1);
    const warn = images.length < job.images.length
      ? '该模型最多接收 ' + images.length + ' 张参考图，已只发送前 ' + images.length + ' 张。'
      : '';
    if (!images.length) {
      if (ouEditOnly.test(job.model)) {
        throw Error('「' + job.model + '」只支持改图，请先在工作台里选一张参考素材，或换成 lustify-v8 这类可文生图的模型。');
      }
      return { blob: await generations(job, { size, response_format: 'b64_json' }) };
    }
    const form = new FormData();
    form.set('model', job.model);
    form.set('prompt', job.prompt);
    form.set('n', '1');
    form.set('size', size);
    form.set('response_format', 'b64_json');
    if (ouSdxl.test(job.model)) form.set('strength', '0.6');
    for (let i = 0; i < images.length; i++) form.append('image[]', await shrink(images[i]), 'ref-' + (i + 1) + '.jpg');
    return { blob: await resultBlob(await readResponse(job, '/images/edits', form), job), warn };
  }

  function generateImage(job) {
    switch (protocol(job.settings)) {
      case 'local': return generateLocal(job);
      case 'gemini': return generateGemini(job);
      case 'seedream': return generateSeedream(job);
      case 'xai': return generateXai(job);
      case 'uncensored': return generateUncensored(job);
      default: return generateOpenAI(job);
    }
  }

  return { providers, generateImage, testConnection, nice };
})();
