import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, randomInt } from 'node:crypto';

// This adapter runs in the loopback preview process. Only its operator chooses the backend and workflow.
export function localEngine(env) {
  const name = env.POSEWEAR_LOCAL_ENGINE || 'comfyui';
  if (name === 'off') return null;
  if (!['comfyui','sd-cpp'].includes(name)) throw Error('POSEWEAR_LOCAL_ENGINE must be comfyui, sd-cpp or off');
  const origin = new URL(env.POSEWEAR_LOCAL_URL || (name === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:1234'));
  if (!['127.0.0.1','localhost','[::1]'].includes(origin.hostname) || !['http:','https:'].includes(origin.protocol) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('POSEWEAR_LOCAL_URL must be a loopback origin');
  const preset = name === 'comfyui' && !env.POSEWEAR_COMFY_WORKFLOW;
  const workflow = preset ? new URL('../docs/comfyui/img2img-api.json',import.meta.url) : env.POSEWEAR_COMFY_WORKFLOW;
  return {name,origin:origin.origin,workflow,preset};
}

async function upstream(engine, path, signal, init = {}) {
  const res = await fetch(engine.origin+path,{...init,signal,redirect:'error'});
  if (!res.ok) throw Error('Local engine HTTP '+res.status+' · '+(await res.text()).slice(0,600));
  return res;
}
// 内置图生图一次只吃一张参考图。要同时用人物 / 服装 / 姿势 / 发型，就换成 IPAdapter：
// 空 latent + denoise 1，参考图只作为条件进模型，而不是被当成底图去重绘。
// 权重按角色递减——人物决定长相与体型，服装次之，姿势约束构图，发型影响最小。
const REF_WEIGHTS = {person: 0.9, costume: 0.8, pose: 0.7, hair: 0.65, expression: 0.6, extra: 0.55};
const MAX_REFS = 8;
const STITCH_REFS = 4;
const NEGATIVE_PROMPT = 'lowres, bad anatomy, bad hands, extra fingers, text, watermark, signature, blurry';
const MULTI_REF_HELP = '这个 ComfyUI 不支持多参考图：内置预设需要 IPAdapter（装 ComfyUI_IPAdapter_plus）或核心的 ImageStitch 节点。只送一张参考图可以直接用内置图生图。';

// 探一个节点类型的定义；没装这个扩展时 ComfyUI 返回 404，按「不可用」处理，不抛错。
async function nodeInfo(engine, classType, signal) {
  const res = await fetch(engine.origin + '/object_info/' + classType, {signal, redirect: 'error'});
  if (!res.ok) return null;
  const body = await res.json();
  return body?.[classType] || null;
}

// object_info 里带默认值的字段原样抄过来，用来补齐节点版本差异（字段名和取值随 IPAdapter 版本变化）。
function defaultsOf(info) {
  const spec = {...(info?.input?.required || {}), ...(info?.input?.optional || {})};
  const out = {};
  for (const [name, def] of Object.entries(spec)) {
    const opts = def?.[1];
    if (opts && 'default' in opts) out[name] = opts.default;
  }
  return out;
}

// 多参考图有两条路：装了 IPAdapter 就按角色权重逐张注入；没有就用核心的 ImageStitch 把图拼成一张网格再图生图。
// 节点与字段随版本变化，所以先问引擎要 object_info；结果缓存在 engine 上，测试连接时重探一次。
async function multiRefCaps(engine, signal) {
  if (engine.caps !== undefined) return engine.caps;
  const [loader, apply, stitch] = await Promise.all([
    nodeInfo(engine, 'IPAdapterUnifiedLoader', signal),
    nodeInfo(engine, 'IPAdapterAdvanced', signal),
    nodeInfo(engine, 'ImageStitch', signal),
  ]);
  engine.caps = loader && apply
    ? {mode: 'ipadapter', loader: defaultsOf(loader), apply: defaultsOf(apply), maxRefs: MAX_REFS}
    : stitch ? {mode: 'stitch', maxRefs: STITCH_REFS}
    : {mode: null, maxRefs: 1};
  return engine.caps;
}

function multiRefGraph(form, refs, caps) {
  const [width, height] = (form.get('size') || '1024x1024').split('x').map(Number);
  const roles = form.getAll('role[]');
  const graph = {
    1: {class_type: 'CheckpointLoaderSimple', inputs: {ckpt_name: form.get('checkpoint')}},
    2: {class_type: 'CLIPTextEncode', inputs: {text: form.get('prompt'), clip: ['1', 1]}},
    3: {class_type: 'CLIPTextEncode', inputs: {text: NEGATIVE_PROMPT, clip: ['1', 1]}},
    4: {class_type: 'EmptyLatentImage', inputs: {width, height, batch_size: 1}},
    5: {class_type: 'KSampler', inputs: {seed: randomInt(0, 2 ** 32), steps: 20, cfg: 7, sampler_name: 'euler',
      scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0]}},
    6: {class_type: 'VAEDecode', inputs: {samples: ['5', 0], vae: ['1', 2]}},
    7: {class_type: 'SaveImage', inputs: {filename_prefix: 'PoseWear', images: ['6', 0]}},
    8: {class_type: 'IPAdapterUnifiedLoader', inputs: {...caps.loader, model: ['1', 0]}},
  };
  const images = [];
  let model = ['1', 0];
  refs.forEach((_, i) => {
    const load = String(10 + i);
    const apply = String(20 + i);
    graph[load] = {class_type: 'LoadImage', inputs: {image: 'reference.jpg'}};
    const inputs = {...caps.apply, model, ipadapter: ['8', 1], image: [load, 0],
      weight: REF_WEIGHTS[roles[i]] ?? REF_WEIGHTS.extra};
    // 只覆盖这个版本确实有的可调字段，剩下的沿用节点默认值。
    for (const [key, value] of [['weight_type', 'linear'], ['combine_embeds', 'concat'], ['start_at', 0], ['end_at', 1], ['embeds_scaling', 'V only']])
      if (key in caps.apply) inputs[key] = value;
    graph[apply] = {class_type: 'IPAdapterAdvanced', inputs};
    images.push({node: graph[load], index: i + 1});
    model = [apply, 0];
  });
  graph[5].inputs.model = model;
  return {graph, output: '7', images};
}

// 没有 IPAdapter 时的兜底：每张参考图缩成同一格，两列拼成网格，整张网格再当图生图的底图。
// 只是把人物 / 服装 / 姿势 / 发型塞进同一次请求，重绘强度比单图路径高，效果不如 IPAdapter。
function stitchGraph(form, refs) {
  // 列数按张数定：1–3 张排一行，4 张起两列两行。避免最后一行只有一张图时被纵向缩放拉高画布。
  const cellW = 384, cellH = 576, cols = refs.length <= 3 ? refs.length : 2;
  const rows = Math.ceil(refs.length / cols);
  const graph = {
    1: {class_type: 'CheckpointLoaderSimple', inputs: {ckpt_name: form.get('checkpoint')}},
    2: {class_type: 'CLIPTextEncode', inputs: {text: form.get('prompt'), clip: ['1', 1]}},
    3: {class_type: 'CLIPTextEncode', inputs: {text: NEGATIVE_PROMPT, clip: ['1', 1]}},
    5: {class_type: 'KSampler', inputs: {seed: randomInt(0, 2 ** 32), steps: 20, cfg: 7, sampler_name: 'euler',
      scheduler: 'normal', denoise: 0.8, model: ['1', 0], positive: ['2', 0], negative: ['3', 0]}},
    6: {class_type: 'VAEDecode', inputs: {samples: ['5', 0], vae: ['1', 2]}},
    7: {class_type: 'SaveImage', inputs: {filename_prefix: 'PoseWear', images: ['6', 0]}},
  };
  const images = [];
  const cells = refs.map((_, i) => {
    const load = String(10 + i), scale = String(30 + i);
    graph[load] = {class_type: 'LoadImage', inputs: {image: 'reference.jpg'}};
    graph[scale] = {class_type: 'ImageScale', inputs: {image: [load, 0], upscale_method: 'lanczos',
      width: cellW, height: cellH, crop: 'center'}};
    images.push({node: graph[load], index: i + 1});
    return [scale, 0];
  });
  let next = 40;
  const stitch = (a, b, direction) => {
    const id = String(next++);
    // spacing_* 在 required 里（虽然是高级项），缺了 ComfyUI 会拒绝整张图。
    graph[id] = {class_type: 'ImageStitch', inputs: {image1: a, image2: b, direction, match_image_size: true,
      spacing_width: 0, spacing_color: 'white'}};
    return [id, 0];
  };
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const row = cells.slice(r * cols, r * cols + cols);
    lines.push(row.slice(1).reduce((left, cell) => stitch(left, cell, 'right'), row[0]));
  }
  let grid = lines[0];
  for (let r = 1; r < lines.length; r++) grid = stitch(grid, lines[r], 'down');
  graph[4] = {class_type: 'VAEEncode', inputs: {pixels: grid, vae: ['1', 2]}};
  graph[5].inputs.latent_image = ['4', 0];
  return {graph, output: '7', images};
}

function workflowSlots(graph, count) {
  const nodes = Object.entries(graph);
  const prompts = nodes.filter(([,n]) => n._meta?.title === 'PoseWear Prompt').map(([,n]) => n);
  const images = nodes.filter(([,n]) => /^PoseWear Image \d+$/.test(n._meta?.title))
    .map(([,n]) => ({node:n,index:Number(n._meta.title.split(' ').at(-1))})).sort((a,b)=>a.index-b.index);
  const outputs = nodes.filter(([,n])=>n._meta?.title==='PoseWear Output');
  if (!prompts.length || prompts.some(n=>typeof n.inputs?.text!=='string') || outputs.length!==1)
    throw Error('The workflow needs a text node named PoseWear Prompt and one image output named PoseWear Output.');
  if (images.length!==count || images.some((it,i)=>it.index!==i+1 || it.node.class_type!=='LoadImage'))
    throw Error(`Workflow expects ${images.length} numbered LoadImage reference(s); selection has ${count}.`);
  return {prompts, images, output:outputs[0][0]};
}
async function comfyImage(engine, form, signal) {
  const refs = form.getAll('image[]');
  // 预设只带一张图时仍走内置图生图；多张切到 IPAdapter，参考图不再当底图。
  const multi = engine.preset && refs.length > 1;
  let graph, output, images;
  if (multi) {
    const caps = await multiRefCaps(engine, signal);
    if (caps.mode === 'ipadapter') ({graph, output, images} = multiRefGraph(form, refs, caps));
    else if (caps.mode === 'stitch') ({graph, output, images} = stitchGraph(form, refs));
    else throw Error(MULTI_REF_HELP);
  } else {
    graph = JSON.parse(await readFile(engine.workflow,'utf8'));
    const slots = workflowSlots(graph, refs.length);
    output = slots.output;
    images = slots.images;
    if (engine.preset) graph['1'].inputs.ckpt_name = form.get('checkpoint');
    for (const node of slots.prompts) node.inputs.text=form.get('prompt');
    if (form.has('size')) {
      const [width,height]=form.get('size').split('x').map(Number);
      if (engine.preset) {
        // The bundled graph connects LoadImage (2) directly to VAEEncode (5) in Auto mode.
        graph['9'] = {class_type:'ImageScale',inputs:{image:['2',0],upscale_method:'lanczos',width,height,crop:'center'}};
        graph['5'].inputs.pixels = ['9',0];
      } else {
        const sizes=Object.values(graph).filter(n=>n._meta?.title==='PoseWear Size');
        if (!sizes.length) throw Error('Use Auto aspect ratio, or name a width/height node PoseWear Size.');
        for (const node of sizes) Object.assign(node.inputs,{width,height});
      }
    }
    for (const n of Object.values(graph)) if(n._meta?.title==='PoseWear Seed') n.inputs.seed=randomInt(0,2**32);
  }
  const id = randomUUID();
  for (const {node,index} of images) {
    const upload = new FormData();
    upload.set('image',refs[index-1],`posewear-${id}-${index}.jpg`);
    const saved = await (await upstream(engine,'/upload/image',signal,{method:'POST',body:upload})).json();
    if (!saved.name) throw Error('ComfyUI did not return an input filename.');
    node.inputs.image=[saved.subfolder,saved.name].filter(Boolean).join('/');
  }
  const job=await (await upstream(engine,'/prompt',signal,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:graph,client_id:id})})).json();
  if(!job.prompt_id) throw Error('ComfyUI did not accept the workflow.');
  const path='/history/'+encodeURIComponent(job.prompt_id);
  try {
    for (;;) {
      const record=(await (await upstream(engine,path,signal)).json())[job.prompt_id];
      if (record) {
        if(record.status?.status_str==='error') throw Error('ComfyUI workflow failed. '+(record.status.messages?.find(([kind])=>kind==='execution_error')?.[1]?.exception_message||''));
        const result=record.outputs?.[output]?.images;
        if(result?.length!==1) throw Error('PoseWear 输出节点每次只能返回一张图。');
        const {filename,subfolder='',type='output'}=result[0];
        return await upstream(engine,'/view?'+new URLSearchParams({filename,subfolder,type}),signal);
      }
      await delay(500,undefined,{signal});
    }
  } finally {
    // Delete only this pending job. An already executing job may finish on the local engine.
    if (signal.aborted) await upstream(engine,'/queue',AbortSignal.timeout(1500),{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({delete:[job.prompt_id]})}).catch(()=>{});
  }
}
export async function localRequest(engine,request) {
  if (!engine) return new Response(null,{status:404});
  const url=new URL(request.url);
  if (request.headers.get('x-posewear-local')!=='1' || (request.method==='POST' && request.headers.get('origin')!==url.origin))
    return new Response(null,{status:403});
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(300000)]);
  try {
    if(url.pathname==='/api/local/status' && request.method==='GET') {
      const path=engine.name==='comfyui'?'/system_stats':'/v1/models';
      const status=await (await upstream(engine,path,signal)).json();
      if (engine.name==='comfyui'? !status.system : !Array.isArray(status.data)) throw Error('Unexpected local engine response.');
      const result = {engine:engine.name};
      if (engine.preset) {
        const info = await (await upstream(engine,'/object_info/CheckpointLoaderSimple',signal)).json();
        const checkpoints = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
        if (!Array.isArray(checkpoints) || !checkpoints.every(name => typeof name === 'string'))
          throw Error('ComfyUI did not return its checkpoint list.');
        result.checkpoints = checkpoints;
        // 每次测试连接都重探一次多参考图能力，装完 IPAdapter 不必重启预览进程。
        engine.caps = undefined;
        const caps = await multiRefCaps(engine, signal).catch(() => ({mode: null, maxRefs: 1}));
        result.multiRef = caps.mode || false;
        result.maxRefs = caps.maxRefs;
      }
      return Response.json(result,{headers:{'cache-control':'no-store'}});
    }
    if (url.pathname!=='/api/local/generate' || request.method!=='POST') return new Response(null,{status:404});
    const form=await request.formData();
    if(!form.get('prompt') || form.getAll('image[]').some(i=>typeof i==='string')) return new Response('Invalid image request',{status:400});
    if (engine.preset) {
      const checkpoint = form.get('checkpoint');
      if (typeof checkpoint !== 'string' || !checkpoint.trim()) return new Response('请先选择 ComfyUI 模型。',{status:400});
      const count = form.getAll('image[]').length;
      if (count < 1) return new Response('ComfyUI 预设至少需要一张参考图。',{status:400});
      if (count > 1) {
        const caps = await multiRefCaps(engine, signal);
        if (!caps.mode) return new Response(MULTI_REF_HELP,{status:400});
        if (count > caps.maxRefs)
          return new Response(`这个 ComfyUI 最多同时送 ${caps.maxRefs} 张参考图，本次送了 ${count} 张。`,{status:400});
      }
      if (form.has('size') && !/^[1-9]\d*x[1-9]\d*$/.test(form.get('size'))) return new Response('画幅尺寸不合法。',{status:400});
    }
    let image;
    if(engine.name==='comfyui') image=await comfyImage(engine,form,signal);
    else {
      const imgs=form.getAll('image[]');
      const result=imgs.length ? await upstream(engine,'/v1/images/edits',signal,{method:'POST',body:form}) :
        await upstream(engine,'/v1/images/generations',signal,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(form))});
      const data=(await result.json()).data?.[0]?.b64_json;
      if(!data) throw Error('sd-server did not return image data.');
      image=new Response(Buffer.from(data,'base64'),{headers:{'content-type':'image/png'}});
    }
    const contentType=image.headers.get('content-type')||'';
    if(!contentType.startsWith('image/')) throw Error('The local engine did not return an image.');
    return new Response(image.body,{headers:{'content-type':contentType,'cache-control':'no-store'}});
  } catch(e) {
    if (['ECONNREFUSED','ECONNRESET','UND_ERR_SOCKET'].includes(e.cause?.code)) {
      const name = engine.name === 'comfyui' ? 'ComfyUI' : 'sd-server';
      return new Response(`Start ${name} at ${engine.origin}, then reconnect.`,{status:503,headers:{'cache-control':'no-store'}});
    }
    return new Response(e.message,{status:502,headers:{'cache-control':'no-store'}});
  }
}
