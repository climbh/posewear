import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { catalogIndex, catalogNames, publishedSite, readCatalog } from './catalog-source.mjs';
import { onRequest } from '../functions/api/proxy.js';
import { localEngine, localRequest } from './local-engine.mjs';
const engine = localEngine(process.env);

const root = fileURLToPath(new URL('../src/', import.meta.url));
const stagedPages = process.env.POSEWEAR_STAGING || fileURLToPath(new URL('../dist/', import.meta.url));
const release = new URL(publishedSite).origin;
const media = 'https://pwimg.0vo.pro';
const port = Number(process.env.PORT || 8787);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml',
  '.png':'image/png','.webmanifest':'application/manifest+json','.json':'application/json'};
const catalogs = catalogNames;
// 设了 POSEWEAR_STAGING 就以构建副本为数据源：目录 JSON 与图片都读本地 dist，
// 这样才能在发布前看到刚添加的素材（默认不设，仍抓线上目录、图片走 pwimg）。
const useStaging = Boolean(process.env.POSEWEAR_STAGING);
let snapshot;
const statNames = {poses:'pose',depths:'depth',costumes:'cos',anime:'ani',portraits:'por',expressions:'exp',
  hair:'hair',dynasties:'dyn',scenes:'scene',lights:'light',props:'prop',furniture:'furn'};
async function discover() {
  const index = await catalogIndex(process.env.POSEWEAR_CATALOG_URL || publishedSite);
  const data = new Map(), counts = {};
  for (let i = 0; i < catalogs.length; i += 4) {
    await Promise.all(catalogs.slice(i,i+4).map(async name => {
      const {text,items} = await readCatalog(index,name);
      if (!items.length) throw new Error('Empty catalog: '+name);
      const publicItems = items.filter(item => !item.a);
      const key = statNames[name];
      if (key) counts[key] = [publicItems.length, items.length];
      data.set(name,text);
    }));
  }
  return {data,counts};
}
const cacheFile = fileURLToPath(new URL('../.catalog-cache.json', import.meta.url));

// 构建副本里的目录文件名带指纹（poses.<hash>.json），按前缀找最新的那份
function hasItems(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) && value.length > 0;
  } catch {
    return false;
  }
}

async function stagedCatalog(name) {
  if (!useStaging) return null;
  const dir = path.join(stagedPages, 'assets');
  const files = await fs.readdir(dir).catch(() => []);
  const hit = files
    .filter((f) => f.startsWith(name + '.') && f.endsWith('.json'))
    .sort()
    .pop();
  return hit ? fs.readFile(path.join(dir, hit), 'utf8') : null;
}

async function stagedSnapshot() {
  // 表情/发型/历代/场景/光影/道具/家具 的原始档案不在仓库，本地 --allow-partial 构建出来是空数组；
  // 这些库的数字沿用线上，否则首页统计会把它们显示成 0。
  const base = await publishedSnapshot().catch(() => ({ counts: {} }));
  const counts = { ...base.counts };
  for (const [name, key] of Object.entries(statNames)) {
    const text = await stagedCatalog(name);
    if (!text || !hasItems(text)) continue;
    try {
      const items = JSON.parse(text);
      counts[key] = [items.filter((it) => !it.a).length, items.length];
    } catch {}
  }
  return { counts };
}

function publishedSnapshot() {
  snapshot ??= discover()
    .then(async value => {
      await fs.writeFile(cacheFile, JSON.stringify({
        at: Date.now(), counts: value.counts, data: [...value.data]
      })).catch(() => {});
      return value;
    })
    .catch(async error => {
      snapshot = undefined;
      const cached = await fs.readFile(cacheFile, 'utf8').then(text => JSON.parse(text), () => null);
      if (!cached?.data?.length) throw error;
      console.log('[catalog] 线上目录不可用（' + error.message + '），改用本地缓存 ' +
        new Date(cached.at).toLocaleString());
      return { data: new Map(cached.data), counts: cached.counts };
    });
  return snapshot;
}
function streamOut(res, body) {
  const stream = Readable.fromWeb(body);
  // Drop only the aborted response when upstream resets mid-stream instead of crashing the preview process.
  stream.on('error', () => { if (!res.writableEnded) res.destroy(); });
  res.on('error', () => {});
  stream.pipe(res);
}
async function remote(res, url, method, successStatus) {
  const r = await fetch(url, { method });
  const headers = {};
  for (const key of ['content-type','cache-control']) if (r.headers.has(key)) headers[key] = r.headers.get(key);
  res.writeHead(r.ok && successStatus ? successStatus : r.status, headers);
  if (r.body) streamOut(res, r.body); else res.end();
  return r.status;
}
// 构建把缩略图/原图（t、o）写进 dist-assets（R2 布局），中图（m、i）留在 dist。
// 两处都找一遍，避免本地已有的图还要绕去线上图床。
const assetPages = path.resolve('dist-assets');
async function readStagedImage(pathname) {
  for (const dir of [stagedPages, assetPages]) {
    try {
      return await fs.readFile(path.join(dir, pathname));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const error = new Error('not found');
  error.code = 'ENOENT';
  throw error;
}
const server = http.createServer(async (req,res) => {
  try {
    const currentPort = server.address().port;
    if (!['127.0.0.1:'+currentPort,'localhost:'+currentPort].includes(req.headers.host)) return res.writeHead(400).end();
    const u = new URL(req.url, 'http://'+req.headers.host);
    if (u.pathname === '/api/diag') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let parsed = raw.slice(0, 1200);
      try { parsed = JSON.parse(raw); } catch {}
      console.log('[diag] ' + JSON.stringify(parsed));
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
      return;
    }
    if (u.pathname.startsWith('/api/local/')) {
      const controller = new AbortController();
      res.once('close',()=>{ if(!res.writableEnded) controller.abort(); });
      const request = new Request(u,{method:req.method,headers:req.headers,signal:controller.signal,
        ...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});
      const reply = await localRequest(engine,request);
      res.writeHead(reply.status,Object.fromEntries(reply.headers));
      if(reply.body) streamOut(res, reply.body); else res.end();
      return;
    }
    if (u.pathname === '/api/proxy') {
      const started = Date.now();
      const target = req.headers['x-target-url'] || '-';
      let label = target;
      try { const t = new URL(target); label = t.host + t.pathname; } catch {}
      const kind = req.headers['x-proxy-kind'] || 'api';
      try {
        const request = new Request(u,{method:req.method,headers:req.headers,
          ...(req.method === 'POST' ? {body:Readable.toWeb(req),duplex:'half'} : {})});
        let response = await onRequest({request,env:process.env});
        // 图床偶发 TLS 抖动/超时：图片通道失败重试一次，别把 502 甩给页面
        if (response.status === 502 && kind === 'image') {
          await new Promise(r => setTimeout(r, 400));
          const retry = new Request(u,{method:req.method,headers:req.headers});
          response = await onRequest({request:retry,env:process.env});
        }
        console.log(`[proxy] ${req.method} ${label} (${kind}${req.headers['x-proxy-custom'] ? ',custom' : ''}) -> ${response.status} ${Date.now() - started}ms`);
        res.writeHead(response.status,Object.fromEntries(response.headers));
        if (!response.body) return res.end();
        // 上游中途断流（BodyTimeoutError 之类）只能掐断这一条响应，绝不能把进程带走
        const body = Readable.fromWeb(response.body);
        body.on('error', error => { console.log('[proxy] 响应中断：' + error.message); res.destroy(); });
        res.on('close', () => body.destroy());
        body.pipe(res);
      } catch (error) {
        console.log(`[proxy] ${req.method} ${label} (${kind}) 失败：${error.name}: ${error.message} ${Date.now() - started}ms`);
        if (!res.headersSent) {
          res.writeHead(502,{'content-type':'application/json; charset=utf-8'})
            .end(JSON.stringify({error:{message:'转发失败：' + error.message}}));
        } else {
          res.destroy();
        }
      }
      return;
    }
    if (!['GET','HEAD'].includes(req.method)) return res.writeHead(405).end();
    const name = u.pathname.slice(1).replace(/\.json$/,'');
    if (u.pathname === '/'+name+'.json' && catalogs.includes(name)) {
      try {
        const local = await stagedCatalog(name);
        if (local && hasItems(local)) {
          return res.writeHead(200,{'content-type':mime['.json'],'cache-control':'no-cache'}).end(local);
        }
        const {data} = await publishedSnapshot();
        res.writeHead(200,{'content-type':mime['.json'],'cache-control':'no-cache'}).end(data.get(name));
      } catch (error) {
        // 目录抓不到（多为本机连不上 posewear.pages.dev）时返回空列表，
        // 让界面照常打开，由首页横幅说明原因，而不是整站 502。
        console.log('[catalog] '+name+'.json 不可用：'+error.message);
        res.writeHead(200,{'content-type':mime['.json'],'cache-control':'no-store'}).end('[]');
      }
      return;
    }
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (/^[a-zA-Z0-9.-]+$/.test(rel) && rel !== '.' && rel !== '..') {
      try {
        let content = await fs.readFile(path.join(root,rel));
        let catalogdown = false;
        if (rel === 'index.html') {
          try {
            const {counts} = useStaging ? await stagedSnapshot() : await publishedSnapshot();
            content = content.toString().replace(/<b data-stat="(\w+)"[^>]*>[^<]*<\/b>/g, (_,key) => {
              const [visible,total] = counts[key] || [0,0];
              return `<b data-stat="${key}" data-n="${visible}" data-na="${total}">${visible.toLocaleString('en-US')}</b>`;
            });
          } catch (error) {
            catalogdown = true;
            console.log('[catalog] 首页以占位数字提供：'+error.message);
          }
        }
        if (catalogdown) {
          content = content.toString().replace('</body>',
            '<style>#grid,#toolbar{display:none!important}</style>' +
            '<div style="max-width:760px;margin:96px auto;padding:28px 30px;border:1px dashed #d5d5d5;border-radius:18px;' +
            'font:14px/1.9 -apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;color:#333">' +
            '<b style="font-size:17px">图库目录暂时取不到</b><br>' +
            '本机连不上 <code>posewear.pages.dev</code>（12 个图库目录需要联网抓一次）。' +
            '刚才实测：国内站点正常，海外线路超时，FlClash 进程在跑但代理端口 7890 没有监听。<br><br>' +
            '处理：在 FlClash 里点「连接」并确认 <code>nc -z 127.0.0.1 7890</code> 通，然后刷新本页。' +
            '抓取成功后目录会写进 <code>.catalog-cache.json</code>，之后断线也能打开。' +
            '工作台（#studio）不需要图库目录，现在就能用。</div></body>');
        }
        if (rel === 'index.html') {
          // 本机开发用：?cfg=gptx 一键把「自定义中转」写成 gptx；window.__TMO 放宽给慢中转。
          // 密钥不入库：从 POSEWEAR_PREVIEW_KEY 取，没设就留空、在设置页手填。
          const seedKey = process.env.POSEWEAR_PREVIEW_KEY || '';
          content = content.toString().replace('</body>',
            '<script>window.__TMO=600000;' +
            'if(/[?&]cfg=gptx\\b/.test(location.search)){' +
            "localStorage.wbCfg=JSON.stringify({prov:'custom',base:'https://api.gptx.cc/v1'," +
            'key:' + JSON.stringify(seedKey) + ',' +
            "model:'gpt-image-2.5-sunburst',field:'image[]',proto:'edits',proxy:true});" +
            'history.replaceState(null,\'\',location.pathname+location.hash);location.reload()}' +
            '</script></body>');
        }
        if (rel === 'index.html' && engine) {
          const preset = engine.preset ? ' data-local-preset="1"' : '';
          content = content.toString().replace('<html ',`<html data-local-engine="${engine.name}"${preset} `);
        }
        if (rel === 'app.js' && !useStaging) content = content.toString().replace("const AH='';","const AH='"+media+"/';");
        res.writeHead(200,{'content-type':mime[path.extname(rel)] || 'application/octet-stream','cache-control':'no-store'}).end(content);
        return;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    // Static pages use the theme asset from the same build as their HTML.
    if (/^\/assets\/theme\.[0-9a-f]{10}\.js$/.test(u.pathname)) {
      try {
        const script = await fs.readFile(path.join(stagedPages,u.pathname));
        return res.writeHead(200,{'content-type':mime['.js']}).end(script);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await remote(res,release+u.pathname,req.method);
      return;
    }
    const seoRoute = /^\/(?:en|pose|costume|anime|portrait|tag)\/[\w/-]*$/.test(u.pathname);
    if (seoRoute) {
      try {
        const html = await fs.readFile(path.join(stagedPages,u.pathname,'index.html'));
        return res.writeHead(200,{'content-type':mime['.html'],'cache-control':'no-cache'}).end(html);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
    if (useStaging && /^\/(?:[pcareysltf]|o)\/[\w./%-]+\.(?:webp|png|jpg)$/.test(u.pathname)) {
      try {
        const file = await readStagedImage(u.pathname);
        return res.writeHead(200,{'content-type':mime[path.extname(u.pathname)] || 'application/octet-stream',
          'cache-control':'no-store'}).end(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // 本地构建副本里没有这张图（六库的原始档案不在仓库，本地构建不出 t/o），
        // 回到线上取：t/o 在 R2 图床，m/i 在发布站同源目录。
        const tier = (/\/[mi]\//.test(u.pathname) ? release : media) + '/';
        await remote(res, tier + u.pathname.replace(/^\//, ''), req.method);
        return;
      }
    }
    if (seoRoute || /^\/[pcareysltf]\/(?:m|i)\/[\w.%-]+\.webp$/.test(u.pathname)) {
      await remote(res,release+u.pathname,req.method);
      return;
    }
    if ((req.headers.accept || '').includes('text/html')) {
      try {
        const html = await fs.readFile(path.join(stagedPages,'404.html'));
        return res.writeHead(404,{'content-type':mime['.html']}).end(html);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // The published 404 document itself returns 200. Keep the unknown route a 404.
      await remote(res,release+'/404.html',req.method,404);
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(502,{'content-type':'text/plain; charset=utf-8'});
    res.end('Preview unavailable: '+error.message);
  }
});
// 兜底：任何单条请求里的异步异常都不该让本地预览服务退出（之前就是被 BodyTimeoutError 带崩的）
process.on('uncaughtException', error => console.log('[guard] uncaughtException: ' + (error && error.message)));
process.on('unhandledRejection', error => console.log('[guard] unhandledRejection: ' + (error && error.message)));
server.listen(port,'127.0.0.1',() => console.log('PoseWear: http://127.0.0.1:'+server.address().port+'/'));
