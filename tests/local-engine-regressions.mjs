import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { localEngine, localRequest } from '../scripts/local-engine.mjs';

const bytes=await readFile(new URL('./fixtures/mk1.png',import.meta.url));
const events=[];
const models = ['base.safetensors','服饰/portrait v2.safetensors'];
let listed = models, submittedGraph, ipadapter = false, stitch = false;
// ComfyUI 的 object_info 形状：[枚举或类型, {default}]；链接输入没有 default。
const ipadapterInfo = type => type === 'IPAdapterUnifiedLoader'
  ? {input:{required:{model:{},preset:[['PLUS (high strength)','PLUS FACE (portraits)'],{default:'PLUS (high strength)'}]}}}
  : {input:{required:{model:{},ipadapter:{},image:{},weight:['FLOAT',{default:1}],
      weight_type:[['linear','ease in'],{default:'linear'}],combine_embeds:[['concat'],{default:'concat'}],
      start_at:['FLOAT',{default:0}],end_at:['FLOAT',{default:1}],embeds_scaling:[['V only'],{default:'V only'}]}}};
const server=http.createServer(async(req,res)=>{
  events.push(req.url);
  const json=value=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));
  if(req.url==='/v1/models')return json({data:[{id:'local'}]});
  if(req.url==='/system_stats')return json({system:{os:'fixture'}});
  if(req.url==='/object_info/CheckpointLoaderSimple')
    return json({CheckpointLoaderSimple:{input:{required:{ckpt_name:[listed,{tooltip:'checkpoint'}]}}}});
  if(req.url.startsWith('/object_info/IPAdapter')){
    if(!ipadapter)return res.writeHead(404).end();
    const type=req.url.split('/').pop();
    return json({[type]:ipadapterInfo(type)});
  }
  if(req.url==='/object_info/ImageStitch'){
    if(!stitch)return res.writeHead(404).end();
    return json({ImageStitch:{input:{required:{image1:{},direction:[['right','down','left','up'],{default:'right'}],
      match_image_size:['BOOLEAN',{default:true}],spacing_width:['INT',{default:0}],spacing_color:[['white'],{default:'white'}]},
      optional:{image2:{}}}}});
  }
  if(req.url==='/upload/image'||req.url==='/v1/images/edits'){
    const form=await new Response(Readable.toWeb(req),{headers:req.headers}).formData();
    if(req.url==='/upload/image'){
      assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()),bytes);
      return json({name:'loaded.jpg',subfolder:'input-folder'});
    }
    assert.equal(form.get('prompt'),'reference test');
    for (const file of form.getAll('image[]'))assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
    assert.equal(form.getAll('image[]').length,2);
    return json({data:[{b64_json:bytes.toString('base64')}]});
  }
  if(req.url==='/v1/images/generations'){
    const data=await new Response(Readable.toWeb(req)).json(); assert.equal(data.prompt,'reference test');
    return json({data:[{b64_json:bytes.toString('base64')}]});
  }
  if(req.url==='/prompt'){
    const {prompt}=await new Response(Readable.toWeb(req)).json();
    submittedGraph = prompt;
    if (prompt['5']?.inputs?.denoise === 0.8) {
      // 拼图兜底：每张缩成 448x672 的格子，两列拼完再竖拼，整张网格进 VAEEncode。
      const refs = Object.keys(prompt).filter(k => prompt[k].class_type === 'LoadImage');
      assert.deepEqual(refs, ['10','11','12']);
      assert.equal(prompt['30'].inputs.width,384);
      assert.equal(prompt['30'].inputs.height,576);
      assert.equal(prompt['40'].inputs.direction,'right');
      assert.deepEqual(prompt['40'].inputs.image1,['30',0]);
      assert.deepEqual(prompt['40'].inputs.image2,['31',0]);
      assert.equal(prompt['41'].inputs.direction,'right','three references stay on one row');
      assert.deepEqual(prompt['41'].inputs.image1,['40',0]);
      assert.deepEqual(prompt['41'].inputs.image2,['32',0]);
      assert.deepEqual(prompt['4'].inputs.pixels,['41',0]);
      assert.deepEqual(prompt['5'].inputs.latent_image,['4',0]);
      return json({prompt_id:'job-1'});
    }
    if (prompt['8']?.class_type === 'IPAdapterUnifiedLoader') {
      // 多参考图：空 latent + 全量采样，每条参考图挂一个 IPAdapterAdvanced 串成链。
      const refs = Object.keys(prompt).filter(k => prompt[k].class_type === 'LoadImage');
      assert.deepEqual(refs, ['10','11','12']);
      for (const key of refs) assert.equal(prompt[key].inputs.image,'input-folder/loaded.jpg');
      assert.equal(prompt['5'].inputs.denoise,1);
      assert.equal(prompt['4'].class_type,'EmptyLatentImage');
      assert.deepEqual(prompt['5'].inputs.model,['22',0]);
      assert.deepEqual(prompt['21'].inputs.model,['20',0]);
      assert.deepEqual(prompt['20'].inputs.model,['1',0]);
      assert.deepEqual(prompt['22'].inputs.model,['21',0]);
      assert.equal(prompt['20'].inputs.weight,0.9);
      assert.equal(prompt['21'].inputs.weight,0.8);
      assert.equal(prompt['22'].inputs.weight,0.7);
      assert.deepEqual(prompt['20'].inputs.ipadapter,['8',1]);
      assert.equal(prompt['2'].inputs.text,'reference test');
      return json({prompt_id:'job-1'});
    }
    assert.equal(prompt['2'].inputs.image,'input-folder/loaded.jpg');
    assert.equal(prompt['3'].inputs.text,'reference test');
    return json({prompt_id:'job-1'});
  }
  if(req.url==='/history/job-1')return json({'job-1':{outputs:{
    '7':{images:[{filename:'output.png',type:'output'}]},
    '8':{images:[{filename:'output.png',type:'output'}]}}}});
  if(req.url.startsWith('/view?'))return res.writeHead(200,{'content-type':'image/png'}).end(bytes);
  res.writeHead(404).end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const preview='http://127.0.0.1:8787';
const request=(engine,method,refs=0,checkpoint,size,roles)=>{
  const form=new FormData();form.set('prompt','reference test');
  if(checkpoint!==undefined)form.set('checkpoint',checkpoint);
  if(size!==undefined)form.set('size',size);
  for(let i=0;i<refs;i++){
    form.append('image[]',new Blob([bytes],{type:'image/png'}),'reference.png');
    if(roles?.[i])form.append('role[]',roles[i]);
  }
  return localRequest(engine,new Request(preview+'/api/local/'+(method==='GET'?'status':'generate'),{
    method,headers:{origin:preview,'x-posewear-local':'1'},body:method==='POST'?form:undefined}));
};
const preset = localEngine({POSEWEAR_LOCAL_URL:origin});
try{
  const defaults=localEngine({});
  assert.equal(defaults.name,'comfyui');
  assert.equal(defaults.origin,'http://127.0.0.1:8188');
  assert.equal(defaults.preset,true);
  assert.equal(localEngine({POSEWEAR_LOCAL_ENGINE:'off'}),null);
  assert.throws(()=>localEngine({POSEWEAR_LOCAL_URL:'https://remote.example'}),/loopback/);
  assert.deepEqual(events,[],'configuring the optional preset contacted an engine');
  for(const [method,headers] of [
    ['GET',{}],['POST',{'x-posewear-local':'1',origin:'https://other.example'}]
  ]){
    const path=method==='GET'?'status':'generate';
    assert.equal((await localRequest(preset,new Request(preview+'/api/local/'+path,{method,headers}))).status,403);
  }
  assert.deepEqual(events,[]);
  assert.deepEqual(await (await request(preset,'GET')).json(),
    {engine:'comfyui',checkpoints:models,multiRef:false,maxRefs:1});
  assert.deepEqual([...events].sort(),['/object_info/CheckpointLoaderSimple','/object_info/IPAdapterAdvanced',
    '/object_info/IPAdapterUnifiedLoader','/object_info/ImageStitch','/system_stats']);
  listed=[];
  assert.deepEqual(await (await request(preset,'GET')).json(),
    {engine:'comfyui',checkpoints:[],multiRef:false,maxRefs:1});
  listed=null;
  assert.equal((await request(preset,'GET')).status,502);
  listed=models;
  const before=events.length;
  assert.equal((await request(preset,'POST',1)).status,400);
  assert.equal((await request(preset,'POST',0,models[1])).status,400);
  assert.equal((await request(preset,'POST',2,models[1])).status,400);
  assert.equal((await request(preset,'POST',1,models[1],'portrait')).status,400);
  assert.ok(!events.slice(before).includes('/upload/image'),'invalid preset input uploaded files');
  for(const [name,size] of [[models[1],'576x1024'],[models[0],undefined]]) {
    const image=await request(preset,'POST',1,name,size);
    assert.equal(image.status,200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);
    assert.equal(submittedGraph['1'].inputs.ckpt_name,name);
    if (size) {
      assert.deepEqual(submittedGraph['5'].inputs.pixels,['9',0]);
      assert.deepEqual(submittedGraph['9'],{class_type:'ImageScale',inputs:{image:['2',0],upscale_method:'lanczos',width:576,height:1024,crop:'center'}});
    } else {
      assert.deepEqual(submittedGraph['5'].inputs.pixels,['2',0]);
      assert.ok(!submittedGraph['9']);
    }
  }
  console.log('PASS preview preset model discovery, explicit selection and reference validation');
  // 只有 ImageStitch 时走拼图兜底：四类素材拼成一张网格，一次请求送进去。
  stitch = true;
  assert.equal((await (await request(preset,'GET')).json()).multiRef,'stitch');
  assert.equal((await request(preset,'POST',5,models[1])).status,400,'stitch mode caps at four references');
  const grid = await request(preset,'POST',3,models[1],undefined,['person','costume','pose']);
  assert.equal(grid.status,200);
  assert.deepEqual(Buffer.from(await grid.arrayBuffer()),bytes);
  assert.equal((await request(preset,'POST',1,models[1])).status,200,'single reference still uses img2img');
  console.log('PASS preset ImageStitch grid fallback');
  stitch = false;
  // 装上 IPAdapter 之后预设能吃多张参考图：人物 / 服装 / 姿势 / 发型按角色权重链式注入。
  ipadapter = true;
  assert.equal((await (await request(preset,'GET')).json()).multiRef,'ipadapter');
  const multi = await request(preset,'POST',3,models[1],'576x1024',['person','costume','pose']);
  assert.equal(multi.status,200);
  assert.deepEqual(Buffer.from(await multi.arrayBuffer()),bytes);
  assert.equal(submittedGraph['4'].inputs.width,576);
  assert.equal(submittedGraph['4'].inputs.height,1024);
  assert.equal((await request(preset,'POST',9,models[1])).status,400,'over maxRefs is rejected');
  // 拔掉插件后能力探测失效，多图退回 400，单图仍走内置图生图。
  ipadapter = false;
  preset.caps = undefined;
  assert.equal((await request(preset,'POST',3,models[1])).status,400);
  assert.equal((await request(preset,'POST',1,models[1])).status,200);
  console.log('PASS preset multi-reference IPAdapter chain and single-image fallback');
  for(const name of ['sd-cpp','comfyui']){
    const engine=localEngine({POSEWEAR_LOCAL_ENGINE:name,POSEWEAR_LOCAL_URL:origin,
      POSEWEAR_COMFY_WORKFLOW:new URL('../docs/comfyui/img2img-api.json',import.meta.url)});
    assert.equal(engine.preset,false);
    assert.deepEqual(await (await request(engine,'GET')).json(),{engine:name});
    const image=await request(engine,'POST',name==='comfyui'?1:2,name==='comfyui'?models[1]:undefined);
    assert.equal(image.status,200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);
    if(name==='comfyui'){
      assert.equal(submittedGraph['1'].inputs.ckpt_name,'YOUR_CHECKPOINT.safetensors','custom workflow model changed');
      assert.equal((await request(engine,'POST',1,models[1],'576x1024')).status,502,'custom workflow still needs a size node');
      const previous=events.length;assert.equal((await request(engine,'POST',2)).status,502);assert.equal(events.length,previous);
    }else assert.equal((await request(engine,'POST')).status,200);
    console.log('PASS local '+name+' connection, submission and result');
  }
  assert.equal((await request(null,'GET')).status,404);
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const unavailable=await request(preset,'GET');
assert.equal(unavailable.status,503);
assert.ok((await unavailable.text()).includes('Start ComfyUI at '+origin));
console.log('PASS unavailable engine and disabled bridge have distinct HTTP responses');
