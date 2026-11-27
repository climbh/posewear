# 添加新素材

本文只讲**素材与条目怎么进库**。构建、发布、测试的通用流程见 [AGENTS.md](../AGENTS.md)。

## 0. 最省事的路：本地添加器

```bash
python3 -m pip install Pillow     # 只需一次（构建本来就需要）
npm run add                       # = python3 scripts/add-asset.py，自动打开 http://127.0.0.1:8790
```

页面里选素材库 → 填几项 → 拖图进去 → 点「写入并构建」。它内部做的正是下面各节手工流程：按库把图缩放到正确规格、写进 `assets-raw/`、追加 `data.json` 条目、必要译名补进 `tr_pose.txt` / `tr_portrait.txt`，然后跑 `python3 build.py --allow-partial`。

两个按钮的分工：**「写入素材」只写第一层**（`assets-raw/`，毫秒级，写完队列清空）；**「写入并构建」写完再跑一次构建**。**构建不依赖待写入的图**——队列为空时点「写入并构建」就是纯构建，用来在改过素材后重新生成 `dist/`。命令行等价：`python3 build.py --allow-partial`。

- 编号自动生成：姿势按「组名 + 角度后缀」，服装按分类前缀顺延（`SPR-0261`…），人像随机 11 位，新模块 `sc-n001`、`ex-n001` 顺延。
- 姿势一次拖多张会按 `正面/上から/横/斜め/下から` 顺序分配角度，同组共用一张卡片。
- 发型（CharaDB）不在工具里：图片只能热链原站，加条目见第 6 节。
- 工具只负责「进库」，发布仍是 `build.py` → staging → `check_csp.py` → 回归 → `sync-r2.py` → `deploy`。

### 18+ 标记：上传时就能定

18+ 不是写死在条目里的，`build.py` 原来只按「系列 / 分类」推导（`全身·性感`、`双人互动`、`挤胸·乳沟`、`性感·大胆`）。带 `a:1` 的条目默认隐藏，访客点顶栏 18+ 才看得见。

添加器在上传表单末尾给了「18+」下拉，三档：

| 选 | 写入 data.json | 效果 |
|---|---|---|
| 自动（看系列/分类） | 不写 | 按 `build.py` 的 `ADULT_LINES` / `ADULT_CATS` / `ADULT_COS` 推导 |
| 是 | `"adult": 1` | 一定打 18+ 标记 |
| 否 | `"adult": 0` | 一定不打标记，默认可见 |

`build.py` 的优先级：`data.json` 里有 `adult` 就用它，没有才推导（兼容所有老数据，老条目行为不变）。姿势按组生效——同组任一条目写了 `adult` 就整组照它。

### 管理已有素材（改 18+ / 删除）

页面右上角切到「管理素材」：左侧选库，可按 id / 名称 / 分类搜索，可按 18+ 过滤。

- **18+**：点一下切换，直接改 `assets-raw/<库>/data.json` 里那条的 `adult`，再点「写入并构建」或回添加页构建才进 `dist/`。
- **删除**：确认后一次清三处——`data.json` 条目、`assets-raw/` 里的原始图、`dist/` 与 `dist-assets/` 的构建产物，**并自动重建一次**（约 10 秒，状态栏显示「已删除 N 条并重建」）。姿势按**整组**删（同组所有角度 + 组名对应的 `tr_pose.txt` 译名行，若没有别的角度在用）；人像改动的是 `assets-raw/portrait/images.js` 里的数组。

自动重建这步不能省：只删 `data.json` 的话，`dist/assets/poses.<hash>.json` 里还留着那张卡，图库照样搜得到、图却 404——就是「删了还能搜到」。脚本里想批量删再统一构建，给 `/api/delete` 传 `"build": false`。

预览新条目：`POSEWEAR_STAGING="$PWD/dist" npm start`，打开 `http://127.0.0.1:8787`。**这个环境变量不能省**：不设时预览只从 `posewear.pages.dev` 抓 12 份目录、图片走 `pwimg`，刚写进去的素材永远不出现，看着就像没写进去。

反过来，六库（表情/发型/历代/场景/光影/道具/家具）的原始档案在维护者本地、不在仓库，本地构建出来是空数组——这几库的目录与统计会自动回退到线上发布版，图片回退 R2/主站，所以预览里它们照常显示，但你新加到这些库的条目要等有完整档案的构建才能看到。

构建完看不到新条目，按这个顺序查：

1. `dist/assets/poses.*.json` 里有没有你的 id：`grep 你的姿势名 dist/assets/poses.*.json`。没有就是没构建成功（回到上一段重跑）。
2. 预览是不是漏了 `POSEWEAR_STAGING`（见上）。
3. 是不是被 18+ 开关挡住：`系統` 选「性感系」、或分类属「性感/挤胸」的条目带 `a:1`，默认隐藏，要点顶栏 `18+`（首次弹年龄确认）。打开后导航数字从「可见数」变成「全部数」。
4. 同一条姿势的多个角度并成一张卡片（角标写「N 个角度」），别以为只进了一张。
5. 卡片出现但图空白：`t`/`o` 档在 R2，预览读的是 `dist/p/i`、`dist/p/t`；本地刚构建的图在 `dist-assets/`，发布前要 `python3 scripts/sync-r2.py dist-assets --workers 8` 才会上线。

下面各节是它对应的手工流程，工具出错或要批量导入时按这里做。

先判断加的是哪一类，它们走三条完全不同的通路：

| 类别 | 原始素材 | 条目由谁生成 | 图片去向 |
|---|---|---|---|
| 姿势 / 服装 / 动画服装 / 人像 | `assets-raw/<lib>/`（`scripts/fetch-assets.py` 抓上游，或手工放） | `build.py` 直接读 `data.json` / `images.js` | t、o → R2；m、i → 主站 |
| 深度姿势 | `depth/packs/<包名>/` | `depthpack.py` 读 `manifest.json` + `items.json` | 热链包不存图；`local` 包复制到 `dist/d/` |
| 表情 / 历代 / 场景 / 光影 / 道具 / 家具 / 发型 | 维护者本地档案 `posewear-assets-archive/` + 快照 | `scripts/prep-modules.py` 生成本地 `assets-raw/<sub>/data.json` | t、o → R2；i → 主站 |

无论哪条，最后都是同一套动作：**数据 → `build.py` → `dist/assets/<库>.<hash>.json` → 前端按 `src/catalog.js` 的注册表渲染**。前端没有任何按条目的硬编码，加条目不需要改 JS。

### 规格与风格标准（入库校验）

库里每一类素材都有一套固定画法：姿势是 900×1200 的白底线稿，服装是 2:3 的浅灰底产品图，六库统一 3:4。新图不按这套来，卡片高度、底色、密度就会参差。所以添加器在写入前按下面的标准检查，数值来自现有素材的实测中位数（每库抽样 60 张）：

| 库 | 宽高比 | 长边下限 | 背景（边缘亮度） | 饱和度上限 | 画风 |
|---|---|---|---|---|---|
| 姿势 | 0.75（±0.04） | 900 | ≥0.90，波动 ≤0.06 | ≤0.06 | 白底灰度线稿 |
| 服装 | 0.667（±0.04） | 1080 | ≥0.70，波动 ≤0.10 | ≤0.16 | 浅灰纯色底插画 |
| 动画服装 | 0.667（±0.04） | 768 | ≥0.65，波动 ≤0.10 | ≤0.16 | 灰底插画 |
| 人像 | 不限 | 1000 | — | — | 彩色写实/照片 |
| 表情 | 0.80（±0.04） | 900 | ≥0.92，波动 ≤0.05 | ≤0.06 | 白底线稿 |
| 历代 / 场景 / 光影 / 道具 / 家具 | 0.75（±0.04） | 900 | — | — | 3:4 竖图 |

实测基线（同一批抽样），改阈值前先照这个对齐：姿势 `0.750 / 背景 1.00 / 饱和 0.001`；服装 `0.667 / 0.82 / 0.048`；动画服装 `0.667 / 0.75 / 0.052`；人像 `0.800 / 0.75 / 0.268`；表情 `0.800 / 1.00 / 0.008`。

- **自动补白**：比例跟标准不一致的图（AI 出图常是 1024×1024）在写入时自动补到标准画布——内容不缩放不裁切，多出来的地方用边缘底色填（白底填白、灰底填灰）。1024×1024 会变成 1024×1365，构建后照常是 900×1200。缩略图上标「自动补白」，不是问题。
- **error（拒写）**：长边不足（放大必糊）。勾「忽略规格检查」可强制写入。
- **warn（照写但提示）**：背景不干净、饱和度过高（彩色图混进线稿库）、几乎空白。
- 前端入队就把尺寸和比例标在缩略图上（红边 = 尺寸不足，灰虚线 = 自动补白），不用等提交。
- 整库体检：`python3 scripts/add-asset.py --lint`（或 `--lint pose costume`），打印各库实测中位数与不合规条目，另有一行「缺图」统计（数据里有、`assets-raw` 里没有的图——构建遇到已存在的产物会整段跳过，缺图只有在清空 `dist/` 后才炸）。
- 写入失败的图不会连带构建：有多条没写进去时状态栏显示「N 条没写进去，未构建」，不会出现「红色错误 + 构建完成」同时出现。构建真失败时状态栏会摘出最后一行异常（如 `KeyError: '某某'`）。
- 阈值定义在 `scripts/add-asset.py` 的 `PROFILE`，指标算法在同文件的 `measure()`：边缘 3 像素环带算背景亮度与波动，HSV 的 S 通道算饱和度，边缘密度兜底查空白图。

想彻底统一画风（不只是尺寸），还是得从源头控制：同一批图用同一个模型、同一套提示词尾缀、同一个抠图/去背流程，出图后再过一遍这条校验。

### 交给 AI 改图（每个库两版提示词）

页面上每个库都带一段现成的提示词，点「复制提示词」直接粘给图像模型（GPT-4o / Nano Banana / 即梦 / 通义万相都行）。两版：

- **改成标准**：把你手上随便找的图，按该库的画布、底色、画法改造成能入库的素材，同时保留原图主体（姿势、服装、人脸不变）。
- **从零生成**：没有现成图时，按同一套规格凭空生成一张新素材。

提示词里写死的四项和 `PROFILE` 一一对应，改阈值时两边一起改：**画布**（像素与比例）、**背景**（纯白或指定灰阶）、**画法**（线宽、上色方式、写实程度）、**禁止项**（文字、水印、边框、背景道具、多余人物）。

| 库 | 提示词关键约束 |
|---|---|
| 姿势 | 900×1200、纯白 #FFFFFF、"单一深灰线 2-3px"、全身、头脚各留 3%；**头是空白椭圆（只有十字辅助线），不画五官、不画发型**，身体只到人体结构线稿 |
| 服装 | 1366×2048、灰底 #D2D2D2、隐形人台正面、无脸部、4% 边距 |
| 动画服装 | 512×768 起、灰底 #BFBFBF、赛璐璐平涂 |
| 人像 | 长边 ≥1000、彩色写实、半身/全身、5-8% 头部留白 |
| 表情 | 960×1200（4:5）、纯白、只画头肩、线稿 |
| 历代 | 900×1200、浅米底、全身朝代服饰、考据合理 |
| 场景 | 900×1200、写实空景、有前景中景背景、无人物 |
| 光影 | 900×1200、单一光向、光比约 1:4、无 bloom |
| 道具 | 900×1200、灰底 #D9D9D9、单件居中、8% 边距 |
| 家具 | 900×1200、灰底 #D9D9D9、单件、比例真实 |

用的时候注意：

- **一次一张**。多张拼一次会得到拼图，比例必然不对。
- **改完直接拖回页面**，前端会立刻标出尺寸不足或比例不符；模型的画布常给 1024×1024 或 1000×1500，比例不对的重新要求它按像素出图。
- 模型最常犯的错：加阴影/渐变背景、加文字水印、把线稿画成彩色、改了人物姿势、加边框。这些都会被校验打到，看到 warn 就重跑提示词里的 "Never add" 段。
- 国产模型对英文提示词同样有效；要中文版就按「画布 / 背景 / 画法 / 禁止项」四段自己复述一遍，效果一样。

---

## 1. 姿势（`poses.json`）

原始数据 `assets-raw/pose/data.json`，每条对应**一个角度**：

```json
{"id":"full_single_P007_front","系統":"全身1人・標準系","ポーズ番号":"P007",
 "分類":"立ち","ポーズ名":"S字立ち・腰を横に突き出す","アングル":"正面",
 "サムネ":"thumbs/full_single_P007_front.jpg","原寸":"img/full_single_P007_front.png"}
```

- `id` 必须是 `<组>_<角度>`，`build.py` 用 `id.rsplit('_', 1)[0]` 归组：同组的多个角度合成一张卡片，分组的第一个 `id` 就是卡片 id。
- `アングル` 只能是 `正面 / 上から / 下から / 横 / 斜め`，映射表是 `build.py` 的 `ANG`。
- `系統` → `LINE`，`分類` → `CAT`；**映射表里没有的值会直接 KeyError**，加新系列/分类先补 `build.py` 这两张表（`depthpack.py` 有一份同样的副本，深度库共用，一起改）。
- `ポーズ名` 是键，中文/英文译名在 `tr_pose.txt`，一行 `日文|中文|英文`，缺了会 KeyError。
- 成人口味标记由 `ADULT_LINES` / `ADULT_CATS` 决定（默认隐藏，需开 18+），排序也据此把安全内容排前。

图片三档由 `_convert_pose` 生成，**目标存在就跳过**：

| 档位 | 来源 | 规格 | 落点 |
|---|---|---|---|
| `t` | `サムネ` | 原样转 webp，q80 | `<asset_root>/p/t/<id>.webp` |
| `i` | `原寸` | 长边 ≤1200，webp q82 | `dist/p/i/<id>.webp` |
| `o` | `原寸` | **硬链接，扩展名写死 `.png`**（源文件必须是 png） | `<asset_root>/o/p/<id>.png` |

加一条新姿势：

1. 图片丢进 `assets-raw/pose/thumbs/`、`assets-raw/pose/img/`（或整个目录都换掉后重跑 `scripts/fetch-assets.py`）。
2. 在 `assets-raw/pose/data.json` 的 `D` 里为每个角度追加一行，`id` 用新组名。
3. `tr_pose.txt` 加一行译名。
4. `python3 build.py`。

## 2. 服装 / 动画服装（`costumes.json` / `anime.json`）

`assets-raw/costume/data.json`、`assets-raw/anime/data.json`，顶层是 `{META, D, JA}`（`D` 才是条目数组，`JA` 是日文原词表）：

```json
{"id":"SPR-0001","カテゴリ":"春","キーワード":"ivory frill knit denim mini skirt coat socks white sneakers",
 "サムネ":"thumbs/SPR-0001.webp","画像":"img/SPR-0001.webp","原寸":"png/SPR-0001.png"}
```

- 中文描述、英文提示词、标题都由 `costume_text.gen2(キーワード, カテゴリ英文, id)` 生成，**不手写**。词表在 `costume_text.py` 的 `N`（名词→中文+槽位）、`MOD`（修饰）、`COL`（颜色）、`SOLO`、`EN_SOLO`、`SKIRT_LEN`。新英文词不补词表不会报错，但会被当成 `acc` 原样塞进中文里——加完抽查一条 `zh`/`ti`。
- `カテゴリ` 必须是 `build.py` 的 `CC` 里的键（春/夏/秋/冬/ランジェリー/パーティ/水着/セクシー）。
- 四档：`t`、`i` 是 `assets-raw/<lib>/thumbs|img/` 的整目录拷贝（保留原文件名，条目里写的就是 basename）；`m` 由 `画像` 缩到 1080×1620 webp q80；`o` 是 `原寸` 的硬链接（`.png`）。
- 动画服装走同一段代码，前缀 `a`、目录 `anime`；CharaDB 的 440 条服装在构建时并入动画服装（见第 6 节）。

## 3. 人像（`portraits.json`）

数据在 `assets-raw/portrait/images.js`（`window.GALLERY_IMAGES = [...]`）和 `ranking.js`：

```json
{"id":"f71f980dde3","section":"face","hair":"ショート","style":"",
 "w":1122,"h":1402,"full":"img/full/f71f980dde3.png","thumb":"img/thumb/f71f980dde3.webp"}
```

- `section` 只有 `face` / `styling`（`PORTRAIT_SECTION`），`hair` 只有 `ショート / ミディアム / セミロング / ロング`（`PORTRAIT_HAIR`）——加新档位要同时改这两张表和 `tr_portrait.txt`。
- `style` 是可选细分发型，译名在 `tr_portrait.txt`（`日文|中文|英文`）；编号 `F001` / `S001` 按 section 出现顺序自动生成。
- `ranking.js` 的 `top.総合` / `top.<分类>` 决定 `rk` / `rc`（人气徽标），可以不加。
- 图片：`thumb` **直接拷贝**，所以必须是 `.webp`；`full` 生成 `m`（≤1080×1350，webp q80，且 `i` 也指向它）与 `o`（硬链接 `.png`）。
- 提示词模板固定（"一位亚洲年轻女性，<发长>，正面半身肖像/自拍风生活照…"），换风格要改 `build.py` 里那段字符串。

## 4. 深度姿势（`depths.json`）

不看 `assets-raw`，只看 `depth/packs/`。每个子目录一个包：`manifest.json` + 条目文件（默认 `items.json`）。

```json
{"id":"gia-depth","source":"hotlink","base":"https://ai-pose-depth-gallery.pages.dev/",
 "site":"https://…","siteName":"…","author":"…","authorUrl":"…","credit":"…",
 "referrerPolicy":"no-referrer","items":"items.json","gatedLines":["2人絡み"],
 "fields":{"id":"id","line":"系統","no":"ポーズ番号","cat":"分類","name":"ポーズ名","angle":"アングル","thumb":"サムネ","full":"原寸"}}
```

- `source: hotlink`：`base` 必须是 https，包里**不许放图片**（构建会报错），条目地址 = `base` + 相对路径；`source: local`：图片放在包目录内，构建复制到 `dist/d/<包名>/`，地址改走本站。
- `items.json` 可以是数组，也可以是 `{meta:{lines:[…]}, items:[…]}`；`meta.lines` 决定系列顺序。
- 校验会拦住：未知 `系統/分類/アングル`（三张表在 `depthpack.py` 顶部）、缺 `tr_pose.txt` 译名、同组名称或分类不一致、角度重复、`gatedLines` 没有对应条目、`id` 非法或跨包重复。
- 角度顺序按 `ANG_ORDER = ['正面','斜め','横','上から','下から']`。
- 与姿势库配对（同一张卡片翻面对照）只认 `pack === 'gia-depth'`，见 `src/app.js` 的 `counterpartType`；新建自己的包想配对要改这里。

## 5. 表情 / 历代 / 场景 / 光影 / 道具 / 家具

这六个库的 `data.json` 都在 `assets-raw/<sub>/`，由 `scripts/prep-modules.py` 从本地档案生成（档案不在仓库，路径默认 `~/workspace/posewear-assets-archive`、快照 `~/workspace/.tmp/pw-modules`，用 `--archive` / `--snapshots` 覆盖）。**也可以手改生成的 `data.json`**，字段一致即可。

统一结构（除表情外都同形）：

```json
{"id":"SC-0012","cat":"室内","ti":"北欧客厅","zh":"…","en":"…","ja":"…",
 "line":"客厅系列","lineEn":"Living room","views":{"front":"SC-0012_front.webp","diag":"…"},
 "extra":{"dims":"…","setting":"…","light":"…"}}
```

- `views` 的键只能是 `front / diag / side / back / above / below / eye / tq`（`build.py` 的 `VIEW_MAP`，未知键直接 KeyError），值是对应文件名，构建后变成 `angles[]`（中文角度名取自 `VIEW_MAP`）；`filters` 里的 `ang` 就是这些角度。
- 图片：`views` 里的文件名必须**同时**存在于 `assets-raw/<sub>/files/w300/` 与 `files/w900/`（同名，后缀 `.webp`）。`_copy_new_module` 把 w300 拷成 `t`、w900 拷成 `i`（主站）和 `o`（R2），产物名统一重命名为 `<id>_<view>.webp`，所以源文件名随便叫，只要两边一致。
- 各库的分类映射在 `prep-modules.py`：`SCENE_CAT` / `LIGHT_CAT` / `PROP_CAT` / `FURN_CAT` / `ERA_EN`；加新分类要补对应字典，否则 KeyError。
- 表情（`expression`）的 `extra` 多五个字段：`emo / emoEn`（情绪）、`int / intEn`（强度）、`code`。来源是快照 `expression/catalog.json` + 档案里的 `<id>_front.webp`、`<id>_three-quarter.webp`（`views` 只有 `front` 与 `tq`）；中文名与描述写在脚本的 `NAME_ZH` / `DESC_ZH`，上游 `desc` 为空的那几条要补 `DESC_EN_FILL`——新条目漏补会 KeyError。表情的两个尺寸目录里的文件是**同一张图**，都来自 `~/…/expression/`。
- 历代服饰来自 `charadb-shisei/shisei/costumes.json`，只取 `cat === 'HC'` 且不在 `retired` 里的条目，`line` 用朝代。

## 6. 发型 / CharaDB 服装（热链，只能热链）

`assets-raw/charadb/hair.json`、`outfits.json` 由 `prep-modules.py` 从 `items_public.json` + `char-db-cn_data.js` + `costume-anime-zh_anhao.json` 快照生成。

- **图片禁止下载、禁止进 R2/dist**，条目写原站 URL：`https://charadb-2fi.pages.dev/thumb/<id>.webp`（t）与 `/img/<id>.jpg`（m、i），并带 `ext: 1`。前端对 `ext` 条目不出原图下载、不做 canvas 取色。
- 发型：`set === 'hair'` 的 `style` 条目 + 其 `style_color` 子项合成一个多角度条目（一个发色一个角度）；`bangs / color / acc / eye` 是单品，分类取中文层 `catZh`，顺序固定为 `['刘海','发色','发饰','瞳色','瞳型']`，加新分类要改这个 `order` 列表。
- CSP 是硬门槛：`build.py` 会把 `charadb/outfits.json`、`charadb/hair.json` 里出现的 https 源站收进 `img-src`。**新增任何热链数据源，都要把它加进这段收集循环**（`hotlink_origins`），否则浏览器整批拦图（2026-11-23 发型库全灭就是这个原因），并且 `tests/check_csp.py` 会拦发布。

## 7. 添加时的硬性限制（数据层）

这些不是画风问题，是流程本身不允许的：

- **id 不能重复**：姿势是 `组名_角度后缀`，服装 `前缀-四位序号`，人像随机 11 位，六库 `xx-nNNN`；撞了就报错，不静默覆盖。
- **必填字段（表单里带红星，缺了会在前端被拦住，光标跳到第一个没填的）**：
  - 姿势：「组名」（决定 id 前缀，不填会撞 id）、「姿势名」（`data.json` 的 `ポーズ名`，也是 `tr_pose.txt` 的分组键）；
  - 服装/动画服装：「关键词（英文）」（中文描述与英文提示词由 `costume_text.gen2` 生成，词表覆盖不到的词会原样留在提示词里）；
  - 表情/历代/场景/光影/道具/家具：「中文名」（卡片标题，其余语言的空字段都沿用它）；
  - 人像：没有必填文本字段，类型和发长有默认值，但**图片本身是必需的**；
  - 所有库都要有图，视角/分类/角度这类下拉有默认值，不算必填。
- **下拉值来自代码常量**：系列/分类/朝代/情绪/强度都取自 `build.py` 和 `scripts/prep-modules.py` 的映射表，表里没有的值加不了——这是有意的，否则构建时才 KeyError。
- **下拉显示中文、写入原键**：表单里看到的是「全身·标准」「俯拍」「春季」这类中文译名，但提交给 `data.json` 的仍是上游原键（`全身1人・標準系`、`上から`、`春`）。这些原键是 `build.py` 映射表的键，只翻译显示层，别把数据改成中文。
- **发型（CharaDB）不能进库**：图片只能热链原站，禁止下载进 `dist/` 或 R2，见第 6 节。
- **深度姿势不走单图**：它是整包 `manifest.json` + `items.json`，见第 4 节。
- **透明背景会被合成到白底**（线稿库都是白底）：直接转 RGB 会得到黑块，所以 `open_image()` 显式按白底合成。
- **构建不清理旧产物**：改图或删条目后，`dist/`、`dist-assets/` 里的旧文件还在（页面不受影响，但同步 R2 会留下垃圾），要手动删。

## 8. 加完之后

```bash
python3 build.py                       # 缺六库档案时只能 --allow-partial 做本地开发
export POSEWEAR_STAGING="$(mktemp -d "${TMPDIR:-/tmp}/posewear-staging.XXXXXXXX")"
cp -R dist/. "$POSEWEAR_STAGING/"
python3 tests/check_csp.py "$POSEWEAR_STAGING"   # 缺库标记、CSP 源站、footer 分类索引
python3 scripts/sync-r2.py dist-assets --workers 8   # 只传新增的 t/ 与 o/
npm run deploy                          # 需 POSEWEAR_STAGING 已导出；自带 --branch main
```

- **改了已有条目的图片**：`_convert_*` / `_copy_new_module` 见目标已存在就跳过，必须先删对应的 `dist/…` 与 `dist-assets/…` 旧文件再构建，否则线上还是旧图。
- 条数断言在 `tests/v15-modules.js`：`const EXP={expr:95,hair:122,dyn:57,scene:64,light:50,prop:32,furn:41}`、发型单品 76。加/删条目后同步改这里，否则 v15 必红。
- 首页导航的数字不用手改：`index.html` 里的 `data-n` 会被 `seo.py` 按实际条数重写；`scripts/preview.mjs` 本地预览时也会重写。
- 本地 `npm start` 默认读**线上已发布**的 12 份目录（带哈希校验，缓存见 `.catalog-cache.json`），要看新条目得用 `POSEWEAR_STAGING=/abs/path npm start` 指向构建副本。
- 新条目会自动进 SEO 落地页/站点地图的只有姿势、服装、动画服装、人像四库；其余六库目前只体现在首页统计里。

## 9. 真要新增第 13 个素材库

单个库加条目不用动前端，**加一整个库要动 10 处**：

1. `src/catalog.js` → `COLLECTIONS` 加一项（`id/prefix/label/title/file/statKey/slot/accent/filters/suggestions/keywords`）。
2. `src/app.js` → `CATALOG_FILES` 加同名条目。
3. `src/index.html` → 导航加 `<button data-tab="…">` 与 `<b data-stat="…" data-n="…">`。
4. `src/i18n.js` → 四语词条。
5. `build.py` → 加载数据、`catalogs` 字典、`dirs` 目录列表、图片档位拷贝。
6. `post.py` → `CATALOG_FILES`（指纹、`_headers` 的 immutable 路径要加新前缀）。
7. `seo.py` → `EXTRA_CATALOG_STATS`（首页统计）。
8. `tests/check_csp.py` → `names` 列表。
9. `scripts/catalog-source.mjs` → `collections`；`scripts/preview.mjs` → `statNames`。
10. `.agents/skills/posewear/`（选图 Skill）与 `mcp/` 说明里的库清单。

`sw.js` 只预缓存 `poses.json` / `depths.json`，其余按需拉取，新库不用改。
