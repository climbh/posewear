#!/usr/bin/env python3
"""PoseWear 素材添加器：本地起一个页面，拖图 + 填几项 → 自动生成原始数据与图片，再一键构建。

用法：
    python3 scripts/add-asset.py              # 打开 http://127.0.0.1:8790
    python3 scripts/add-asset.py --port 8791  # 换端口
    python3 scripts/add-asset.py --no-open    # 不自动开浏览器

它做的事和三套上游流程等价，只是省掉了手写 JSON 和手算图片规格：
- 姿势/服装/动画服装：写 assets-raw/<库>/ 的 png/图片/缩略图 + data.json 条目（姿势还要补 tr_pose.txt 译名）
- 人像：写 assets-raw/portrait/img/{full,thumb}/ + images.js 条目（style 补 tr_portrait.txt）
- 表情/历代/场景/光影/道具/家具：写 assets-raw/<库>/files/{w300,w900}/ + data.json 条目
发型（CharaDB）只能热链原站图，不在本工具范围内，见 docs/adding-assets.md 第 6 节。

写完点「构建」= python3 build.py --allow-partial；预览用 POSEWEAR_STAGING=$PWD/dist npm start。
"""
import argparse
import base64
import http.server
import importlib.util
import io
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.parse
import textwrap
import webbrowser

try:
    from PIL import Image, ImageFilter, ImageStat
except ImportError:  # 不在 import 阶段就崩，给出可执行的修复命令
    sys.exit('缺少 Pillow：python3 -m pip install --break-system-packages Pillow（或装进独立虚拟环境）')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, ROOT)  # 脚本在 scripts/ 下，直接 import build 里的映射表复用同一份定义

from build import (ADULT_CATS, ADULT_COS, ADULT_LINES, ANG, CAT, CC, LINE,  # noqa: E402
                   PORTRAIT_HAIR, PORTRAIT_SECTION, VIEW_MAP)

RAW_DIR = os.environ.get('POSEWEAR_RAW', 'assets-raw')

# 启动时刻：页面顶上显示它，用来一眼分辨「页面是旧进程吐的」还是「代码没生效」
STARTED = time.strftime('%m-%d %H:%M:%S')


def _load_module_file(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


prep = _load_module_file('posewear_prep_modules', 'scripts/prep-modules.py')

# 角度 → id 后缀（上游姿势 id 用的是 front/high/side/diag/low 这套）
ANG_SUFFIX = {'正面': 'front', '上から': 'high', '横': 'side', '斜め': 'diag', '下から': 'low'}
ANG_ORDER = ['正面', '上から', '横', '斜め', '下から']
# 服装分类 → id 前缀（上游 215 条 SPR-0001 这样的编号）
COS_PREFIX = {'春': 'SPR', '夏': 'SUM', '秋': 'AUT', '冬': 'WIN', 'ランジェリー': 'LNG',
              'パーティ': 'PTY', '水着': 'SWM', 'セクシー': 'SXY'}
ERA_ZH = {'shang': '商', 'han': '汉', 'weijin': '魏晋', 'tang': '唐', 'song': '宋',
          'yuan': '元', 'ming': '明', 'qing': '清', 'rc': '民国', 'wed': '婚服'}

MODULES = {
    'expression': {'sub': 'expression', 'idbase': 'ex', 'catmap': None},
    'dynasty': {'sub': 'dynasty', 'idbase': 'dy', 'catmap': None},
    'scene': {'sub': 'scene', 'idbase': 'sc', 'catmap': prep.SCENE_CAT},
    'light': {'sub': 'light', 'idbase': 'lt', 'catmap': prep.LIGHT_CAT},
    'prop': {'sub': 'prop', 'idbase': 'pr', 'catmap': prep.PROP_CAT},
    'furn': {'sub': 'furn', 'idbase': 'fu', 'catmap': prep.FURN_CAT},
}


# ---------------------------------------------------------------- 图片处理


def open_image(data_url):
    if ',' in data_url:
        data_url = data_url.split(',', 1)[1]
    im = Image.open(io.BytesIO(base64.b64decode(data_url)))
    im.load()
    if im.mode in ('RGBA', 'LA', 'P'):
        # 姿势/表情库全是白底：透明图必须合成到白底，直接 convert('RGB') 会变黑块
        im = im.convert('RGBA')
        canvas = Image.new('RGB', im.size, (255, 255, 255))
        canvas.paste(im, mask=im.getchannel('A'))
        return canvas
    return im.convert('RGB')


def load_image(path):
    """从磁盘读图，走和上传图同一条解码/白底合成路径。"""
    with open(path, 'rb') as fh:
        return open_image('data:,' + base64.b64encode(fh.read()).decode())


def fit(im, max_side):
    """等比缩到长边不超过 max_side；比目标小的图不放大。"""
    if max(im.size) <= max_side:
        return im
    copy = im.copy()
    copy.thumbnail((max_side, max_side), Image.LANCZOS)
    return copy


def edge_color(im):
    """四边 3px 带的中位色，用来给补出来的画布填底（白底图填白、灰底图填灰）。"""
    w, h = im.size
    px = im.load()
    samples = []
    for x in range(0, w, max(1, w // 60)):
        for y in (0, 1, 2, h - 3, h - 2, h - 1):
            samples.append(px[x, y])
    for y in range(0, h, max(1, h // 60)):
        for x in (0, 1, 2, w - 3, w - 2, w - 1):
            samples.append(px[x, y])
    n = len(samples)
    return tuple(sorted(s[i] for s in samples)[n // 2] for i in range(3))


def pad_to_ratio(im, ratio):
    """把画布补到库的标准宽高比：内容不缩放不裁切，多出来的地方用边缘底色填。

    AI 出图常是 1:1，直接入库会跟库里的 3:4 卡片高低不齐；这里补白后一律对齐。
    """
    if not ratio:
        return im
    w, h = im.size
    if abs(w / h - ratio) < 0.005:
        return im
    bg = edge_color(im)
    if w / h > ratio:  # 比目标宽 → 上下补
        nh = round(w / ratio)
        canvas = Image.new('RGB', (w, nh), bg)
        canvas.paste(im, (0, (nh - h) // 2))
    else:  # 比目标窄 → 左右补
        nw = round(h * ratio)
        canvas = Image.new('RGB', (nw, h), bg)
        canvas.paste(im, ((nw - w) // 2, 0))
    return canvas


def save_webp(im, path, max_side=1600, quality=86):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fit(im, max_side).save(path, 'WEBP', quality=quality, method=6)
    return path


def save_png(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, 'PNG')
    return path


def save_jpg(im, path, max_side=600, quality=88):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fit(im, max_side).save(path, 'JPEG', quality=quality)
    return path


# ---------------------------------------------------------------- 规格与风格标准
# 阈值来自现有素材的实测分布（每个库抽样 60 张算中位数，见 docs/adding-assets.md「规格与风格标准」）：
# ratio 期望宽高比、tol 允许偏差、side 长边下限、bg 边缘亮度下限、bg_sd 边缘亮度标准差上限、sat 饱和度上限。
# ratio/side 不达标 = error（会糊、会跟卡片对不齐）；bg/bg_sd/sat 不达标 = warn（画风不一致，但由人判断）。
PROFILE = {
    'pose': {'name': '姿势', 'ratio': 0.75, 'tol': 0.04, 'side': 900,
             'bg': 0.90, 'bg_sd': 0.06, 'sat': 0.06, 'hint': '白底线稿、3:4 竖图'},
    'costume': {'name': '服装', 'ratio': 2 / 3, 'tol': 0.04, 'side': 1080,
                'bg': 0.70, 'bg_sd': 0.10, 'sat': 0.16, 'hint': '浅灰纯色底、2:3 竖图'},
    'anime': {'name': '动画服装', 'ratio': 2 / 3, 'tol': 0.04, 'side': 768,
              'bg': 0.65, 'bg_sd': 0.10, 'sat': 0.16, 'hint': '灰底、2:3 竖图'},
    'portrait': {'name': '人像', 'ratio': None, 'tol': 0, 'side': 1000,
                 'bg': None, 'bg_sd': None, 'sat': None, 'hint': '彩色照片/写实'},
    'expression': {'name': '表情', 'ratio': 0.8, 'tol': 0.04, 'side': 900,
                   'bg': 0.92, 'bg_sd': 0.05, 'sat': 0.06, 'hint': '白底线稿、4:5 竖图'},
    'dynasty': {'name': '历代', 'ratio': 0.75, 'tol': 0.04, 'side': 900,
                'bg': None, 'bg_sd': None, 'sat': None, 'hint': '3:4 竖图、浅底全身'},
    'scene': {'name': '场景', 'ratio': 0.75, 'tol': 0.04, 'side': 900,
              'bg': None, 'bg_sd': None, 'sat': None, 'hint': '3:4 竖图、写实摄影'},
    'light': {'name': '光影', 'ratio': 0.75, 'tol': 0.04, 'side': 900,
              'bg': None, 'bg_sd': None, 'sat': None, 'hint': '3:4 竖图、能看出光比'},
    'prop': {'name': '道具', 'ratio': 0.75, 'tol': 0.04, 'side': 900,
             'bg': None, 'bg_sd': None, 'sat': None, 'hint': '3:4 竖图、主体居中浅底'},
    'furn': {'name': '家具', 'ratio': 0.75, 'tol': 0.04, 'side': 900,
             'bg': None, 'bg_sd': None, 'sat': None, 'hint': '3:4 竖图、主体居中浅底'},
}


def measure(im):
    """缩到长边 400 再算，够准且快：边缘亮度/方差看背景，饱和度看是不是线稿。"""
    sm = im.copy()
    sm.thumbnail((400, 400), Image.LANCZOS)
    w, h = im.size
    g = sm.convert('L')
    px = g.load()
    W, H = g.size
    edge_vals = []
    step = max(1, W // 80)
    for x in range(0, W, step):
        for d in (0, 2, 4):
            if d < H:
                edge_vals += [px[x, d], px[x, H - 1 - d]]
    for y in range(0, H, step):
        for d in (0, 2, 4):
            if d < W:
                edge_vals += [px[d, y], px[W - 1 - d, y]]
    bg = sum(edge_vals) / len(edge_vals) / 255
    bg_sd = (sum((v / 255 - bg) ** 2 for v in edge_vals) / len(edge_vals)) ** 0.5
    sat = ImageStat.Stat(sm.convert('HSV').getchannel('S')).mean[0] / 255
    hist = g.histogram()
    dark = sum(hist[:64]) / (W * H)
    edges = g.filter(ImageFilter.FIND_EDGES).histogram()
    density = sum(edges[32:]) / (W * H)
    return {'w': w, 'h': h, 'ratio': round(w / h, 3), 'bg': round(bg, 3),
            'bg_sd': round(bg_sd, 3), 'sat': round(sat, 3), 'dark': round(dark, 3),
            'edge': round(density, 3)}


def inspect_image(lib, im):
    """入库校验：返回实测指标 + 问题清单。error 拒写（除非明确 force），warn 只提示。"""
    p = PROFILE[lib]
    m = measure(im)
    issues = []
    long_side = max(m['w'], m['h'])
    if long_side < p['side']:
        issues.append({'level': 'error',
                       'msg': f"长边 {long_side}px 低于 {p['side']}px，构建后会被放大发糊（{p['hint']}）"})
    if p['ratio'] and abs(m['ratio'] - p['ratio']) > p['tol']:
        issues.append({'level': 'warn',
                       'msg': f"宽高比 {m['ratio']:.2f}，库内是 {p['ratio']:.2f}（{p['hint']}）——卡片高度会不齐"})
    if p['bg'] is not None and m['bg'] < p['bg']:
        issues.append({'level': 'warn',
                       'msg': f"背景偏暗（边缘亮度 {m['bg']:.2f}，库内 ≥{p['bg']:.2f}）——{p['hint']}"})
    if p['bg_sd'] is not None and m['bg_sd'] > p['bg_sd']:
        issues.append({'level': 'warn',
                       'msg': f"背景不是纯色留白（边缘亮度波动 {m['bg_sd']:.2f} > {p['bg_sd']:.2f}）——库里都是干净底"})
    if p['sat'] is not None and m['sat'] > p['sat']:
        issues.append({'level': 'warn',
                       'msg': f"饱和度 {m['sat']:.2f} 高于库内线稿（≤{p['sat']:.2f}）——彩色图会显得格格不入"})
    if m['edge'] < 0.004:
        issues.append({'level': 'warn', 'msg': f"几乎空白（边缘密度 {m['edge']:.3f}），确认图没导错"})
    return {'metrics': m, 'hint': p['hint'], 'issues': issues}


# ---------------------------------------------------------------- 数据读写


def read_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(',', ':'))


def append_tsv(path, key, cells):
    """译名表是 `键|中|英` 的竖线分隔文本，已存在就跳过。"""
    rows = []
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            rows = [line for line in fh.read().split('\n') if line.strip()]
    for row in rows:
        if row.split('|')[0] == key:
            return False
    rows.append('|'.join([key, *cells]))
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(rows) + '\n')
    return True


def slug(text, fallback='new'):
    cleaned = re.sub(r'[^A-Za-z0-9_-]+', '', text or '')
    return cleaned or fallback


def next_seq(numbers):
    return max(numbers, default=0) + 1


# ---------------------------------------------------------------- 各库写入


def add_pose(field, image):
    group = slug(field.get('group'), 'new_P900')
    ang = field.get('ang') or '正面'
    pose_ja = (field.get('poseJa') or '').strip()
    if not pose_ja:
        raise ValueError('姿势名必填，它是 data.json 的分组键')
    raw = f'{RAW_DIR}/pose'
    data = read_json(f'{raw}/data.json', {'META': {'lines': list(LINE)}, 'D': []})
    iid = f'{group}_{ANG_SUFFIX[ang]}'
    if any(d['id'] == iid for d in data['D']):
        raise ValueError(f'{iid} 已存在；换个组名或换角度')
    save_png(image, f'{raw}/img/{iid}.png')
    save_jpg(image, f'{raw}/thumbs/{iid}.jpg')
    no = (field.get('no') or group.split('_')[-1]).upper()
    row = {
        'id': iid,
        '系統': field['line'],
        'ポーズ番号': no,
        '分類': field['cat'],
        'ポーズ名': pose_ja,
        'アングル': ang,
        'サムネ': f'thumbs/{iid}.jpg',
        '原寸': f'img/{iid}.png',
    }
    if str(field.get('adult') or 'auto') in ('0', '1'):
        row['adult'] = int(field['adult'])
    data['D'].append(row)
    write_json(f'{raw}/data.json', data)
    added = append_tsv('tr_pose.txt', pose_ja, [field.get('zh') or pose_ja, field.get('en') or ''])
    note = '' if added else 'tr_pose.txt 已有同名译名，沿用原值'
    return iid, [f'{raw}/img/{iid}.png', f'{raw}/thumbs/{iid}.jpg'], note


def add_costume(field, image, lib='costume'):
    cat = field['cat']
    kw = (field.get('kw') or '').strip()
    if not kw:
        raise ValueError('关键词必填：中文描述和英文提示词由它生成（build.py → costume_text.gen2）')
    raw = f'{RAW_DIR}/{lib}'
    data = read_json(f'{raw}/data.json', {'META': {}, 'D': [], 'JA': {}})
    prefix = COS_PREFIX[cat]
    nums = [int(m.group(1)) for d in data['D']
            if (m := re.match(rf'{prefix}-(\d+)$', d['id']))]
    iid = f'{prefix}-{next_seq(nums):04d}'
    save_png(image, f'{raw}/png/{iid}.png')
    save_webp(image, f'{raw}/img/{iid}.webp', 1620, 88)
    save_webp(image, f'{raw}/thumbs/{iid}.webp', 400, 82)
    row = {'id': iid, 'カテゴリ': cat, 'キーワード': kw,
           'サムネ': f'thumbs/{iid}.webp', '画像': f'img/{iid}.webp', '原寸': f'png/{iid}.png'}
    if str(field.get('adult') or 'auto') in ('0', '1'):
        row['adult'] = int(field['adult'])
    data['D'].append(row)
    write_json(f'{raw}/data.json', data)
    return iid, [f'{raw}/png/{iid}.png', f'{raw}/img/{iid}.webp', f'{raw}/thumbs/{iid}.webp'], ''


def add_portrait(field, image):
    section = field.get('section') or 'face'
    hair = field.get('hair') or 'ショート'
    style_ja = (field.get('styleJa') or '').strip()
    raw = f'{RAW_DIR}/portrait'
    path = f'{raw}/images.js'
    text = open(path, encoding='utf-8').read() if os.path.exists(path) else 'window.GALLERY_IMAGES = [];\n'
    items = json.loads(text[text.index('['):text.rindex(']') + 1])
    iid = secrets.token_hex(6)[:11]
    save_png(image, f'{raw}/img/full/{iid}.png')
    thumb = fit(image, 400)
    save_webp(thumb, f'{raw}/img/thumb/{iid}.webp', 400, 82)
    items.append({'id': iid, 'section': section, 'hair': hair, 'style': style_ja,
                  'w': image.width, 'h': image.height,
                  'full': f'img/full/{iid}.png', 'thumb': f'img/thumb/{iid}.webp',
                  'thumb_w': thumb.width, 'thumb_h': thumb.height})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('window.GALLERY_IMAGES = ' + json.dumps(items, ensure_ascii=False, indent=2) + ';\n')
    note = ''
    if style_ja:
        if not append_tsv('tr_portrait.txt', style_ja, [field.get('styleZh') or style_ja, field.get('styleEn') or '']):
            note = 'tr_portrait.txt 已有同名发型，沿用原值'
    return iid, [f'{raw}/img/full/{iid}.png', f'{raw}/img/thumb/{iid}.webp'], note


def add_module(lib, field, image):
    spec = MODULES[lib]
    sub = spec['sub']
    raw = f'{RAW_DIR}/{sub}'
    view = field.get('view') or 'front'
    if view not in VIEW_MAP:
        raise ValueError(f'视角只能是 {"/".join(VIEW_MAP)}')
    items = read_json(f'{raw}/data.json', [])
    base = spec['idbase']
    nums = [int(m.group(1)) for it in items if (m := re.match(rf'{base}-n(\d+)$', it['id']))]
    iid = f'{base}-n{next_seq(nums):03d}'
    name = (field.get('name') or '').strip()
    if not name:
        raise ValueError('中文名必填')
    fname = f'{iid}_{view}.webp'
    save_webp(image, f'{raw}/files/w300/{fname}', 300, 86)
    save_webp(image, f'{raw}/files/w900/{fname}', 900, 86)

    if lib == 'expression':
        emo = field.get('emo') or 'happy'
        intensity = field.get('int') or 'subtle'
        item = {
            'id': iid, 'cat': prep.EMO_ZH[emo], 'ti': name, 'zh': field.get('zh') or name,
            'en': field.get('en') or '', 'ja': field.get('ja') or name,
            'line': prep.EMO_ZH[emo], 'lineEn': emo,
            'views': {view: fname},
            'extra': {'emo': prep.EMO_ZH[emo], 'emoEn': emo,
                      'int': prep.INT_ZH[intensity], 'intEn': intensity,
                      'code': iid},
        }
    elif lib == 'dynasty':
        era = field.get('era') or 'tang'
        item = {
            'id': iid, 'cat': '历代服饰', 'ti': name, 'zh': field.get('zh') or name,
            'en': field.get('en') or '', 'ja': field.get('ja') or name,
            'line': ERA_ZH[era], 'lineEn': prep.ERA_EN[era],
            'views': {view: fname},
            'extra': {'era': ERA_ZH[era], 'eraEn': prep.ERA_EN[era],
                      'gender': field.get('gender') or 'female'},
        }
    else:
        catmap = spec['catmap']
        cat = field.get('cat') or next(iter(catmap))
        cz, cen = catmap[cat]
        item = {
            'id': iid, 'cat': cz, 'ti': name, 'zh': field.get('zh') or name,
            'en': field.get('en') or '', 'ja': field.get('ja') or name,
            'line': field.get('line') or cen, 'lineEn': field.get('lineEn') or cen,
            'views': {view: fname},
            'extra': {},
        }
    if str(field.get('adult') or 'auto') in ('0', '1'):
        item['adult'] = int(field['adult'])
    items.append(item)
    write_json(f'{raw}/data.json', items)
    return iid, [f'{raw}/files/w300/{fname}', f'{raw}/files/w900/{fname}'], ''


def handle_add(payload):
    lib = payload.get('lib')
    field = payload.get('fields') or {}
    if lib not in PROFILE:
        raise ValueError(f'未知库 {lib}')
    raw_image = open_image(payload['image'])
    image = pad_to_ratio(raw_image, PROFILE[lib].get('ratio'))
    padded = ''
    if image.size != raw_image.size:
        padded = (f"已补白 {raw_image.size[0]}×{raw_image.size[1]} → "
                  f"{image.size[0]}×{image.size[1]}（{PROFILE[lib]['ratio']:.2f} 标准画布）")
    check = inspect_image(lib, image)
    errors = [i for i in check['issues'] if i['level'] == 'error']
    if errors and not payload.get('force'):
        return {'ok': False, 'error': errors[0]['msg'], 'issues': check['issues'],
                'metrics': check['metrics'], 'hint': check['hint']}
    if lib == 'pose':
        iid, files, note = add_pose(field, image)
    elif lib in ('costume', 'anime'):
        iid, files, note = add_costume(field, image, lib)
    elif lib == 'portrait':
        iid, files, note = add_portrait(field, image)
    else:
        iid, files, note = add_module(lib, field, image)
    return {'ok': True, 'id': iid, 'files': files,
            'note': ' · '.join(x for x in (note, padded) if x),
            'metrics': check['metrics'],
            'issues': [i for i in check['issues'] if i['level'] == 'warn']}


# ---------------------------------------------------------------- 表单元数据


def options(values):
    return [{'value': v, 'label': v} for v in values]


def labeled(mapping):
    """下拉选项：value 保留原键（要原样写进 data.json），label 显示中文。"""
    return [{'value': k, 'label': v if isinstance(v, str) else v[0]} for k, v in mapping.items()]


ADULT_FIELD = {
    'key': 'adult', 'label': '18+', 'type': 'select', 'value': 'auto',
    'options': [{'value': 'auto', 'label': '自动（看系列/分类）'},
                {'value': '1', 'label': '是，打 18+ 标记'},
                {'value': '0', 'label': '否，始终显示'}],
    'help': '18+ 条目默认隐藏，访客点顶栏 18+ 才看得见；事后可在「管理素材」里改',
}


def lib_meta():
    meta = {}
    meta['pose'] = [
        {'key': 'group', 'label': '组名', 'type': 'text', 'value': 'new_P900', 'req': True,
         'help': '同一组的多角度共用一个组名；id 会自动拼上角度后缀（front/high/side/diag/low）'},
        {'key': 'line', 'label': '系列', 'type': 'select', 'options': labeled(LINE)},
        {'key': 'cat', 'label': '分类', 'type': 'select', 'options': labeled(CAT)},
        {'key': 'ang', 'label': '角度', 'type': 'select',
         'options': [{'value': a, 'label': ANG[a][0]} for a in ANG_ORDER]},
        {'key': 'poseJa', 'label': '姿势名', 'type': 'text', 'req': True,
         'help': '上游用日文名；写中文也行，它会作为分组名进 data.json 和 tr_pose.txt'},
        {'key': 'zh', 'label': '中文名', 'type': 'text', 'help': '写进 tr_pose.txt；留空则用姿势名'},
        {'key': 'en', 'label': '英文提示词', 'type': 'text'},
        {'key': 'no', 'label': '编号', 'type': 'text', 'value': 'P900', 'help': '留空取组名末尾'},
    ]
    for lib in ('costume', 'anime'):
        meta[lib] = [
            {'key': 'cat', 'label': '季节/分类', 'type': 'select', 'options': labeled(CC)},
            {'key': 'kw', 'label': '关键词（英文）', 'type': 'text', 'req': True,
             'help': '例：ivory frill knit denim mini skirt coat socks white sneakers——中文与提示词由它生成，词表见 costume_text.py'},
        ]
    meta['portrait'] = [
        # 人像没有必须手填的字段，类型/发长都有默认值；图片本身是必需的

        {'key': 'section', 'label': '类型', 'type': 'select',
         'options': [{'value': k, 'label': v[0]} for k, v in PORTRAIT_SECTION.items()]},
        {'key': 'hair', 'label': '发长', 'type': 'select',
         'options': [{'value': k, 'label': v[0]} for k, v in PORTRAIT_HAIR.items()]},
        {'key': 'styleJa', 'label': '发型名（可选）', 'type': 'text', 'help': '上游用日文名；中文也可以'},
        {'key': 'styleZh', 'label': '发型中文', 'type': 'text'},
        {'key': 'styleEn', 'label': '发型英文', 'type': 'text'},
    ]
    view_opts = [{'value': k, 'label': f'{v[0]} {k}'} for k, v in VIEW_MAP.items()]
    for lib, spec in MODULES.items():
        rows = [
            {'key': 'name', 'label': '中文名', 'type': 'text', 'req': True,
             'help': '卡片标题，其余语言留空时都沿用它'},
            {'key': 'zh', 'label': '中文描述', 'type': 'text'},
            {'key': 'en', 'label': '英文提示词', 'type': 'text'},
            {'key': 'ja', 'label': '日文名（可选）', 'type': 'text', 'help': '站内日文界面用；没有就留空'},
            {'key': 'view', 'label': '视角', 'type': 'select', 'options': view_opts},
        ]
        if lib == 'expression':
            rows += [
                {'key': 'emo', 'label': '情绪', 'type': 'select', 'options': labeled(prep.EMO_ZH)},
                {'key': 'int', 'label': '强度', 'type': 'select', 'options': labeled(prep.INT_ZH)},
            ]
        elif lib == 'dynasty':
            rows += [{'key': 'era', 'label': '朝代', 'type': 'select', 'options': labeled(ERA_ZH)},
                     {'key': 'gender', 'label': '性别', 'type': 'select',
                      'options': options(['female', 'male'])}]
        else:
            rows += [
                {'key': 'cat', 'label': '分类', 'type': 'select', 'options': labeled(spec['catmap'])},
                {'key': 'line', 'label': '系列（中文）', 'type': 'text', 'help': '留空用分类名'},
                {'key': 'lineEn', 'label': '系列（英文）', 'type': 'text'},
            ]
        meta[lib] = rows
    for lib, rows in meta.items():
        if lib == 'portrait':
            continue
        rows.append(ADULT_FIELD)
    return meta


# ---------------------------------------------------------------- HTTP


def run_build():
    """跑一次 build.py --allow-partial，返回 (成功?, 输出尾部)。"""
    proc = subprocess.run([sys.executable, 'build.py', '--allow-partial'],
                          cwd=ROOT, capture_output=True, text=True)
    return proc.returncode == 0, ((proc.stdout or '') + (proc.stderr or ''))[-6000:]


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'PoseWearAddAsset/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype='application/json; charset=utf-8'):
        data = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def do_GET(self):
        # 管理页要预览缩略图：直接吐 dist / dist-assets 里的产物
        if re.match(r'^/(?:[pcareysltf]|o)/[\w./-]+\.(?:webp|png|jpg)$', self.path):
            rel = os.path.normpath(self.path.lstrip('/'))
            if not rel.startswith('..'):
                for root in (DIST_ASSETS_DIR, DIST_DIR):
                    path = os.path.join(root, rel)
                    if os.path.exists(path):
                        with open(path, 'rb') as fh:
                            return self._send(200, fh.read(), 'image/webp' if rel.endswith('.webp')
                                              else 'image/png' if rel.endswith('.png') else 'image/jpeg')
            return self._send(404, b'not found', 'text/plain; charset=utf-8')
        if self.path in ('/', '/index.html'):
            page = os.path.join(ROOT, 'scripts', 'add-asset.html')
            with open(page, 'rb') as fh:
                return self._send(200, fh.read(), 'text/html; charset=utf-8')
        if self.path.startswith('/api/items'):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            lib = (query.get('lib') or [''])[0]
            if lib not in PROFILE:
                return self._json(400, {'ok': False, 'error': f'未知库 {lib}'})
            return self._json(200, {'ok': True, 'lib': lib,
                                    'items': manage_rows(lib, (query.get('q') or [''])[0])})
        if self.path == '/api/meta':
            profile = {k: {'ratio': v['ratio'], 'side': v['side'], 'hint': v['hint'],
                           'name': v['name']} for k, v in PROFILE.items()}
            return self._json(200, {'libs': lib_meta(), 'raw': RAW_DIR, 'profile': profile,
                                    'prompts': LIB_PROMPT, 'started': STARTED})
        return self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError:
            return self._json(400, {'ok': False, 'error': '请求体不是合法 JSON'})
        if self.path == '/api/add':
            try:
                out = handle_add(payload)
            except (KeyError, ValueError) as err:
                msg = str(err)
                if isinstance(err, KeyError):
                    msg = f'缺少字段或数据：{msg}'
                return self._json(400, {'ok': False, 'error': msg})
            return self._json(200 if out['ok'] else 400, out)
        if self.path.split('?')[0] == '/api/delete':
            try:
                out = delete_item(payload.get('lib'), payload.get('id'))
            except (KeyError, ValueError) as err:
                return self._json(400, {'ok': False, 'error': str(err)})
            # 必须跟着重建：只删 data.json 的话 dist/assets/<库>.json 里还留着这张卡，
            # 图库照样搜得到、图却 404（就是「删了还能搜到」的原因）。
            if payload.get('build', True):
                built, log = run_build()
                out['built'] = built
                out['output'] = log[-1200:]
            return self._json(200, {'ok': True, **out})
        if self.path.split('?')[0] == '/api/update':
            try:
                n = set_adult(payload.get('lib'), payload.get('id'), payload.get('adult'))
            except (KeyError, ValueError) as err:
                return self._json(400, {'ok': False, 'error': str(err)})
            return self._json(200, {'ok': True, 'rows': n})
        if self.path == '/api/build':
            ok, out = run_build()
            return self._json(200 if ok else 500, {'ok': ok, 'output': out})
        return self._json(404, {'ok': False, 'error': 'not found'})


# ---------------------------------------------------------------- 交给 AI 的改图/生图提示词
# 每个库两版：edit 把用户手上的图改成该库标准，gen 从零生成一张同风格的新素材。
# 提示词里写死的画布尺寸、背景色、画法，和 PROFILE 的阈值一一对应，改阈值时一并改这里。


def _p(text):
    return textwrap.dedent(text).strip()


LIB_PROMPT = {
    'pose': {
        'edit': _p("""
            Convert this image into one frame of a pose-reference library. Keep the human pose, camera angle, limb positions and body proportions of the input exactly as they are — only the rendering style and the canvas change.

            Canvas: 900x1200 px, portrait 3:4, exactly.
            Background: pure white #FFFFFF, completely empty. No floor, no shadow, no texture, no vignette.
            Line: a single dark-gray (#2A2A2A) pencil/ink contour line of uniform 2-3 px weight. No hatching, no cross-hatching, no gray fill, no shading, no gradient. Fully desaturated — zero color.
            Content: full body from the top of the head to the soles of the feet, centered, head margin 3% of the canvas, feet 3% above the bottom edge.
            Head: a plain blank oval with only the crossing guide lines (one vertical midline, one horizontal eye-level line). No eyes, no nose, no mouth, no ears, no eyebrows, no facial features of any kind. No hairstyle, no hair strands, no bangs, no bun, no headwear, no earrings. Never invent a face or a character — the head is an empty placeholder.
            Body: anatomy mannequin only. Simple joint circles at shoulders, elbows, hips and knees are allowed; no clothing, no fabric, no folds, no shoes, no jewellery, no tattoos, no body paint.
            Purpose: the image must communicate the pose and nothing else — pose, camera angle and limb positions are the whole content.
            Never add: text, caption, watermark, signature, border, frame, props, furniture, background objects, extra people, color accents, anime features, facial expression, makeup, hairstyle.
            Output: flat white background, grayscale line art only.
        """),
        'gen': _p("""
            Draw one pose-reference sheet: a single full-body human figure in a clear, readable pose.

            Canvas: 900x1200 px, portrait 3:4, exactly.
            Background: pure white #FFFFFF, empty.
            Style: consistent dark-gray (#2A2A2A) pencil contour line, uniform 2-3 px weight, no shading, no hatching, no color at all, anatomy clean and readable.
            Framing: figure centered, head margin 3%, feet 3% above the bottom edge, silhouette fully inside the frame.
            Head: a plain blank oval with only the crossing guide lines (vertical midline, horizontal eye-level line) — no eyes, nose, mouth, ears, eyebrows, hair, bangs, headwear or earrings. Never invent a face or a character.
            Body: anatomy mannequin only, simple joint circles allowed, no clothing, no fabric folds, no shoes, no jewellery.
            Never add: text, watermark, background props, furniture, extra figures, color, gradient, anime features, facial expression, makeup, hairstyle.
        """),
    },
    'costume': {
        'edit': _p("""
            Turn this into one catalog card of an outfit library. Keep the garment design, cut, color and details exactly as in the input; only the presentation changes.

            Canvas: 1366x2048 px, portrait 2:3, exactly.
            Background: flat light gray around #D2D2D2 (luminance ~0.82), perfectly uniform — no gradient, no vignette, no floor line, no shadow on the background.
            Content: the complete outfit shown front-on, either laid flat or on an invisible mannequin, fully inside the frame with 4% margin on every side. If a model is needed, crop at the chin — no face.
            Style: clean color illustration/photograph of clothing, even soft light, crisp edges, no wrinkles exaggeration.
            Never add: text, price tag, hanger, brand logo, props, decorative background, collage, multiple angles in one frame.
        """),
        'gen': _p("""
            Design one outfit catalog card.

            Canvas: 1366x2048 px, portrait 2:3, exactly.
            Background: flat light gray ~#D2D2D2, uniform, no shadow.
            Content: a single complete outfit (top, bottom, shoes if relevant) front view on an invisible mannequin, centered, 4% margin, no model face.
            Style: clean editorial color illustration, even soft lighting, readable fabric details.
            Never add: text, logos, props, backgrounds scenes, multiple outfits, collage.
        """),
    },
    'anime': {
        'edit': _p("""
            Convert this into one card of a stylized outfit library. Keep the outfit design and colors; change only presentation and rendering.

            Canvas: at least 768 px on the long edge, portrait 2:3 (e.g. 512x768 or 768x1152).
            Background: flat mid-gray ~#BFBFBF (luminance ~0.75), uniform, no gradient, no props.
            Content: the full outfit front view on an invisible mannequin or flat-lay, centered, 4% margin, no face.
            Style: cel-shaded anime illustration, clean 2-3 px outlines, flat color fills with one shadow tone, no painterly rendering.
            Never add: text, logos, accessories not present in the input, background scenery, multiple angles.
        """),
        'gen': _p("""
            Draw one stylized outfit card.

            Canvas: 512x768 px (or 768x1152), portrait 2:3.
            Background: flat mid-gray ~#BFBFBF.
            Content: a single complete outfit, front view on an invisible mannequin, centered, no face.
            Style: cel-shaded anime illustration, crisp outlines, flat fills plus one shadow tone.
            Never add: text, logos, scenery, extra items, collage.
        """),
    },
    'portrait': {
        'edit': _p("""
            Turn this into a photorealistic portrait reference. Keep the person's identity, pose and framing.

            Canvas: portrait orientation, long edge at least 1000 px (e.g. 1122x1402).
            Look: natural color photograph, realistic skin texture and fabric, soft daylight, mild contrast. No beauty-filter plastic skin, no heavy retouching, no teal-orange grading.
            Framing: half-body or full-body, subject centered, 5-8% head margin, both sides balanced.
            Background: plain and uncluttered (wall, window light, quiet street), may be softly blurred. No text, no signage, no logos.
            Never add: extra people, collage, frames, borders, illustration or 3D-render look, watermarks.
        """),
        'gen': _p("""
            Create one photorealistic portrait reference.

            Canvas: portrait orientation, long edge at least 1000 px.
            Content: one person, half-body or full-body, natural standing pose, centered, 5-8% head margin.
            Look: natural color photograph, soft daylight, realistic skin and fabric texture, neutral color grading.
            Background: plain and uncluttered, softly blurred is fine.
            Never add: text, logos, extra people, frames, illustration style, heavy retouching.
        """),
    },
    'expression': {
        'edit': _p("""
            Convert this into one card of an expression library. Keep the person's face structure and the expression; change only style and canvas.

            Canvas: 960x1200 px, portrait 4:5, exactly.
            Background: pure white #FFFFFF, empty.
            Content: front-facing head and shoulders only, face centered, expression clearly readable (eyes, brows, mouth all legible).
            Style: single dark-gray (#2A2A2A) pencil line, uniform 2-3 px weight, no shading, no hatching, zero color, fully desaturated.
            Never add: text, watermark, background props, hands covering the face, extra heads, accessories not in the input.
        """),
        'gen': _p("""
            Draw one expression card: a front-facing head-and-shoulders portrait with one clearly readable emotion.

            Canvas: 960x1200 px, portrait 4:5.
            Background: pure white.
            Style: dark-gray pencil contour line only, uniform weight, no shading, no color.
            Content: face centered, eyes, brows and mouth all legible, neck and shoulders included.
            Never add: text, props, background, extra faces.
        """),
    },
    'dynasty': {
        'edit': _p("""
            Turn this into one card of a historical-costume library. Keep the outfit's period, silhouette and colors; change only presentation.

            Canvas: at least 900 px on the long edge, portrait 3:4 (e.g. 900x1200).
            Background: flat pale neutral (#E8E4DC to #F2EFEA), uniform, no scenery.
            Content: one figure in full-length period dress, front or three-quarter view, centered, whole body inside the frame with 4% margin, neutral standing pose.
            Style: clean semi-realistic illustration with historically plausible construction and fabric, soft even lighting.
            Never add: text, modern items, accessories of another era, background architecture, extra people.
        """),
        'gen': _p("""
            Draw one historical-costume card.

            Canvas: 900x1200 px, portrait 3:4.
            Background: flat pale neutral, no scenery.
            Content: one figure in a full-length period outfit, front or three-quarter view, centered, entire body inside the frame.
            Style: clean semi-realistic illustration, historically plausible cut and fabric, soft even light.
            Never add: text, modern accessories, background architecture, extra people.
        """),
    },
    'scene': {
        'edit': _p("""
            Turn this into one card of a background-scene library. Keep the location and its character; remove anything that distracts.

            Canvas: at least 900 px on the long edge, portrait 3:4 (e.g. 900x1200).
            Content: an empty environment with clear depth (foreground, middle ground, background). No people, no animals in focus.
            Look: photorealistic, natural color, believable light and perspective, no heavy stylization, no HDR glow.
            Never add: text, signage with readable words, logos, watermarks, people, borders, collage.
        """),
        'gen': _p("""
            Create one background-scene card: an empty, photorealistic environment with clear depth.

            Canvas: 900x1200 px, portrait 3:4.
            Content: one coherent location, foreground/middle ground/background readable, no people.
            Look: natural color photography, believable perspective and light, no heavy grading.
            Never add: text, readable signage, people, borders, collage.
        """),
    },
    'light': {
        'edit': _p("""
            Turn this into one card of a lighting-reference library. Keep the subject and the light direction; make the light readable.

            Canvas: at least 900 px on the long edge, portrait 3:4 (e.g. 900x1200).
            Content: a single subject or simple still life under one clearly identifiable light setup (direction, hardness, color temperature). Light-to-shadow ratio around 1:4, readable shadow shape.
            Look: photorealistic, neutral color, no bloom, no heavy vignette, no filters.
            Never add: text, props that hide the shadow, multiple conflicting light sources, people in focus if the input had none.
        """),
        'gen': _p("""
            Create one lighting-reference card: a simple subject lit by one clearly readable light setup.

            Canvas: 900x1200 px, portrait 3:4.
            Content: single subject, light direction and shadow shape obvious, ratio about 1:4.
            Look: photorealistic, neutral color, no bloom or vignette.
            Never add: text, extra lights, cluttered background.
        """),
    },
    'prop': {
        'edit': _p("""
            Turn this into one card of a prop library. Keep the object's design and material; clean up the surroundings.

            Canvas: at least 900 px on the long edge, portrait 3:4 (e.g. 900x1200).
            Background: flat light gray ~#D9D9D9, uniform, no shadow cast on the background, no floor line.
            Content: one single object, centered, fully inside the frame with 8% margin, front or slight three-quarter view, readable material and scale.
            Look: photorealistic product-style render/photograph, even soft light.
            Never add: text, hands, people, multiple objects, decorative background, collage.
        """),
        'gen': _p("""
            Draw one prop card: a single object centered on a flat light-gray background.

            Canvas: 900x1200 px, portrait 3:4.
            Content: one object, centered, 8% margin, clear material and silhouette.
            Look: photorealistic product lighting, soft shadows kept off the background.
            Never add: text, hands, extra objects, scene background.
        """),
    },
    'furn': {
        'edit': _p("""
            Turn this into one card of a furniture library. Keep the piece's design, proportions and material; clean up the surroundings.

            Canvas: at least 900 px on the long edge, portrait 3:4 (e.g. 900x1200).
            Background: flat light gray ~#D9D9D9, uniform, no floor line, no cast shadow on the background.
            Content: one single furniture piece, centered, fully inside the frame with 8% margin, front view or slight three-quarter, correct real-world proportions.
            Look: photorealistic product lighting, even and soft, material readable (wood grain, fabric weave, metal).
            Never add: text, people, room setting, other furniture, collage, invented ornamentation.
        """),
        'gen': _p("""
            Draw one furniture card: a single piece centered on a flat light-gray background.

            Canvas: 900x1200 px, portrait 3:4.
            Content: one piece, centered, 8% margin, correct proportions, readable material.
            Look: photorealistic product lighting, soft even light.
            Never add: text, room scene, other furniture, collage.
        """),
    },
}


# ---------------------------------------------------------------- 素材管理（列表 / 改 18+ / 删除）

DIST_DIR = os.path.join(ROOT, 'dist')
DIST_ASSETS_DIR = os.path.join(ROOT, 'dist-assets')
# 六库在 dist/src 里的路径前缀（build.py 的 _load_view_module 传的就是这几个字母）
MOD_PREFIX = {'expression': 'e', 'dynasty': 'y', 'scene': 's', 'light': 'l', 'prop': 't', 'furn': 'f'}


def _rm(*paths):
    """删文件，缺了不算错。返回真正删掉的相对路径。"""
    gone = []
    for path in paths:
        if path and os.path.exists(path):
            os.remove(path)
            gone.append(os.path.relpath(path, ROOT))
    return gone


def _adult(line, cat, explicit):
    """18+ 标记：data.json 里的显式 adult 优先，否则按 build.py 的系列/分类规则推导。"""
    if explicit is not None:
        return 1 if explicit else 0
    return 1 if (line in ADULT_LINES or cat in ADULT_CATS) else 0


def _drop_tsv(path, key):
    """译名表里删掉一行（键是第一列）。"""
    if not os.path.exists(path):
        return False
    with open(path, encoding='utf-8') as fh:
        rows = [line for line in fh.read().split('\n') if line.strip()]
    kept = [row for row in rows if row.split('|')[0] != key]
    if len(kept) == len(rows):
        return False
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(kept) + '\n')
    return True


def manage_rows(lib, query=''):
    """该库现有条目（姿势按组聚合，一条 = 一张卡）。"""
    q = (query or '').strip().lower()
    rows = []
    if lib == 'pose':
        data = read_json(os.path.join(RAW_DIR, 'pose', 'data.json'), {'D': []})
        groups = {}
        for d in data['D']:
            key = d['id'].rsplit('_', 1)[0]
            g = groups.setdefault(key, {'id': key, 'name': d['ポーズ名'], 'cat': CAT[d['分類']],
                                        'line': LINE[d['系統']][0], 'angles': 0,
                                        'adult': None, 'first': d['id'], 'no': d['ポーズ番号']})
            g['angles'] += 1
            if d.get('adult') is not None:
                g['adult'] = d['adult']
        for g in groups.values():
            rows.append({'id': g['id'], 'name': g['name'], 'cat': g['cat'],
                         'line': g['line'], 'note': f"{g['angles']} 个角度",
                         'adult': _adult(g['line'], g['cat'], g['adult']),
                         'thumb': f"/p/t/{g['first']}.webp"})
    elif lib in ('costume', 'anime'):
        pre = 'c' if lib == 'costume' else 'a'
        for d in read_json(os.path.join(RAW_DIR, lib, 'data.json'), {'D': []}).get('D', []):
            cat = CC[d['カテゴリ']][0]
            explicit = d.get('adult')
            rows.append({'id': d['id'], 'name': d['キーワード'], 'cat': cat, 'line': '',
                         'note': os.path.basename(d['サムネ']),
                         'adult': 1 if (explicit or (explicit is None and cat in ADULT_COS)) else 0,
                         'thumb': f'/{pre}/t/' + os.path.basename(d['サムネ'])})
    elif lib == 'portrait':
        path = os.path.join(RAW_DIR, 'portrait', 'images.js')
        if os.path.exists(path):
            with open(path, encoding='utf-8') as fh:
                text = fh.read()
            for d in json.loads(text[text.index('['):text.rindex(']') + 1]):
                rows.append({'id': d['id'], 'name': d.get('style') or d['id'],
                             'cat': PORTRAIT_SECTION.get(d['section'], (d['section'],))[0],
                             'line': '', 'note': '', 'adult': 0,
                             'thumb': '/r/t/' + d['id'] + '.webp'})
    else:
        pre = MOD_PREFIX[lib]
        for it in read_json(os.path.join(RAW_DIR, MODULES[lib]['sub'], 'data.json'), []):
            view = next(iter(it['views']))
            rows.append({'id': it['id'], 'name': it.get('ti') or it.get('zh') or it['id'],
                         'cat': it.get('cat') or '', 'line': it.get('line') or '',
                         'note': f"{len(it['views'])} 个视角",
                         'adult': 1 if it.get('adult') else 0,
                         'thumb': f'/{pre}/t/' + it['views'][view]})
    if q:
        rows = [r for r in rows if q in (r['id'] + ' ' + r['name'] + ' ' + r['cat']).lower()]
    return rows


def _purge_outputs(lib, iid, files=()):
    """删构建产物：dist 与 dist-assets 两边都试（没设 POSEWEAR_ASSET_HOST 时 t/o 留在 dist 里）。"""
    roots = (DIST_DIR, DIST_ASSETS_DIR)
    targets = []
    if lib == 'pose':
        for r in roots:
            targets += [f'{r}/p/t/{iid}.webp', f'{r}/p/i/{iid}.webp', f'{r}/o/p/{iid}.png']
    elif lib in ('costume', 'anime'):
        pre = 'c' if lib == 'costume' else 'a'
        for r in roots:
            targets += [f'{r}/{pre}/{sub}/{iid}.webp' for sub in ('t', 'm', 'i')]
            targets.append(f'{r}/o/{pre}/{iid}.png')
    elif lib == 'portrait':
        for r in roots:
            targets += [f'{r}/r/t/{iid}.webp', f'{r}/r/m/{iid}.webp', f'{r}/o/r/{iid}.png']
    else:
        pre = MOD_PREFIX[lib]
        for r in roots:
            targets += [f'{r}/{pre}/{sub}/{f}' for sub in ('t', 'i') for f in files]
            targets += [f'{r}/o/{pre}/{f}' for f in files]
    return _rm(*targets)


def delete_item(lib, iid):
    if lib == 'pose':
        path = os.path.join(RAW_DIR, 'pose', 'data.json')
        data = read_json(path, {'D': []})
        victims = [d for d in data['D'] if d['id'].rsplit('_', 1)[0] == iid]
        if not victims:
            raise ValueError(f'姿势库里没有 {iid}')
        data['D'] = [d for d in data['D'] if d['id'].rsplit('_', 1)[0] != iid]
        write_json(path, data)
        raw_files = [os.path.join(RAW_DIR, 'pose', d[k]) for d in victims for k in ('原寸', 'サムネ')]
        gone = []
        for d in victims:
            gone += _purge_outputs('pose', d['id'])
        gone += _rm(*raw_files)
        # 译名表：这个姿势名没有别的角度在用了才删
        still = {d['ポーズ名'] for d in data['D']}
        for name in {d['ポーズ名'] for d in victims} - still:
            _drop_tsv('tr_pose.txt', name)
        return {'removed': len(victims), 'files': gone}
    if lib in ('costume', 'anime'):
        path = os.path.join(RAW_DIR, lib, 'data.json')
        data = read_json(path, {'D': []})
        victims = [d for d in data['D'] if d['id'] == iid]
        if not victims:
            raise ValueError(f'{lib} 库里没有 {iid}')
        data['D'] = [d for d in data['D'] if d['id'] != iid]
        write_json(path, data)
        raw_files = [os.path.join(RAW_DIR, lib, d[k]) for d in victims for k in ('サムネ', '画像', '原寸')]
        return {'removed': len(victims), 'files': _rm(*raw_files) + _purge_outputs(lib, iid)}
    if lib == 'portrait':
        path = os.path.join(RAW_DIR, 'portrait', 'images.js')
        if not os.path.exists(path):
            raise ValueError('人像库还没有数据')
        with open(path, encoding='utf-8') as fh:
            text = fh.read()
        items = json.loads(text[text.index('['):text.rindex(']') + 1])
        victims = [d for d in items if d['id'] == iid]
        if not victims:
            raise ValueError(f'人像库里没有 {iid}')
        items = [d for d in items if d['id'] != iid]
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write('window.GALLERY_IMAGES = ' + json.dumps(items, ensure_ascii=False, indent=2) + ';\n')
        raw_files = [os.path.join(RAW_DIR, 'portrait', d[k]) for d in victims for k in ('full', 'thumb')]
        return {'removed': 1, 'files': _rm(*raw_files) + _purge_outputs('portrait', iid)}
    path = os.path.join(RAW_DIR, MODULES[lib]['sub'], 'data.json')
    items = read_json(path, [])
    victims = [it for it in items if it['id'] == iid]
    if not victims:
        raise ValueError(f'{lib} 库里没有 {iid}')
    names = [f"{iid}_{view}.webp" for it in victims for view in it['views']]
    items = [it for it in items if it['id'] != iid]
    write_json(path, items)
    raw_files = [os.path.join(RAW_DIR, MODULES[lib]['sub'], tier, name)
                 for name in names for tier in ('w300', 'w900')]
    return {'removed': len(victims), 'files': _rm(*raw_files) + _purge_outputs(lib, iid, names)}


def set_adult(lib, iid, flag):
    """把一个条目（姿势是整组）的 18+ 显式设为 flag（0/1）。"""
    flag = 1 if flag else 0
    if lib == 'portrait':
        raise ValueError('人像库没有 18+ 标记')
    if lib == 'pose':
        path = os.path.join(RAW_DIR, 'pose', 'data.json')
        data = read_json(path, {'D': []})
        hit = [d for d in data['D'] if d['id'].rsplit('_', 1)[0] == iid]
        for d in hit:
            d['adult'] = flag
        if not hit:
            raise ValueError(f'姿势库里没有 {iid}')
        write_json(path, data)
        return len(hit)
    if lib in ('costume', 'anime'):
        path = os.path.join(RAW_DIR, lib, 'data.json')
        data = read_json(path, {'D': []})
    else:
        path = os.path.join(RAW_DIR, MODULES[lib]['sub'], 'data.json')
        data = read_json(path, [])
    rows = data['D'] if isinstance(data, dict) else data
    hit = [d for d in rows if d['id'] == iid]
    if not hit:
        raise ValueError(f'{lib} 库里没有 {iid}')
    for d in hit:
        d['adult'] = flag
    write_json(path, data)
    return len(hit)


# ---------------------------------------------------------------- 整库体检


LIB_DIRS = {
    'pose': ('pose/img', '*.png'),
    'costume': ('costume/img', '*.webp'),
    'anime': ('anime/img', '*.webp'),
    'portrait': ('portrait/img/full', '*'),
    'expression': ('expression/files/w900', '*.webp'),
    'dynasty': ('dynasty/files/w900', '*.webp'),
    'scene': ('scene/files/w900', '*.webp'),
    'light': ('light/files/w900', '*.webp'),
    'prop': ('prop/files/w900', '*.webp'),
    'furn': ('furn/files/w900', '*.webp'),
}


def lint_missing(sample=5):
    """数据里有、磁盘上没有的图。构建遇到已存在的产物会整段跳过，缺图只在清空 dist 后才炸。"""
    path = os.path.join(RAW_DIR, 'pose', 'data.json')
    if not os.path.exists(path):
        return
    rows = read_json(path, {}).get('D', [])
    miss = []
    for row in rows:
        for key in ('原寸', 'サムネ'):
            rel = row.get(key)
            if rel and not os.path.exists(os.path.join(RAW_DIR, 'pose', rel)):
                miss.append((row['id'], rel))
    print(f"pose        条目 {len(rows)}，缺图 {len(miss)}")
    for iid, rel in miss[:sample]:
        print(f'    {iid}: {rel}')


def lint(only=None, sample=40, show=5):
    """按标准体检现有素材：每库抽样算实测中位数 + 统计不合规条目，用来验证标准本身。"""
    import glob
    import random
    import statistics as st
    random.seed(7)
    for lib, (rel, pattern) in LIB_DIRS.items():
        if only and lib not in only:
            continue
        paths = glob.glob(os.path.join(RAW_DIR, rel, pattern))
        if not paths:
            print(f'{lib:11s} 无素材，跳过')
            continue
        picked = random.sample(paths, min(sample, len(paths)))
        rows, bad = [], []
        for p in picked:
            try:
                im = load_image(p)
            except Exception as err:
                bad.append((p, [{'level': 'error', 'msg': f'打不开：{err}'}]))
                continue
            chk = inspect_image(lib, im)
            rows.append(chk['metrics'])
            issues = [i for i in chk['issues'] if i['level'] == 'error']
            if issues:
                bad.append((p, issues))
        med = lambda k: st.median([r[k] for r in rows])  # noqa: E731
        print(f"{lib:11s} n={len(rows):3d} 比例 {med('ratio'):.3f} 背景 {med('bg'):.2f}"
              f"/{med('bg_sd'):.3f} 饱和 {med('sat'):.3f} 长边 {int(max(med('w'), med('h')))}"
              f"  不合规 {len(bad)}/{len(picked)}")
        for p, issues in bad[:show]:
            print(f'    {os.path.basename(p)}: {issues[0]["msg"]}')
    if not only or 'pose' in only:
        lint_missing()


def main():
    ap = argparse.ArgumentParser(description='PoseWear 素材添加器')
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--lint', nargs='*', metavar='库',
                    help='不启服务，只按标准体检 assets-raw 里的现有素材（可指定库名）')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--no-open', action='store_true')
    args = ap.parse_args()
    if args.lint is not None:
        return lint(args.lint or None)
    url = f'http://{args.host}:{args.port}'
    print(f'素材添加器: {url}  （raw = {RAW_DIR}）')
    if not args.no_open:
        webbrowser.open(url)
    http.server.ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
