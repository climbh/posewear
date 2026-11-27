#!/usr/bin/env bash
# 本地预览启动器（本地辅助脚本，非上游文件）
# 用途：README 的 `npm start` 需要访问 posewear.pages.dev 拉取 12 个图库目录，
# 这里在检测到系统 Clash 在线（127.0.0.1:7890）时走代理；代理没开就直接跑，
# 已成功抓到的目录会写进 .catalog-cache.json，VPN 抖动时仍能打开页面。
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8788}"
# 默认读本地构建副本（dist/）的目录与图片，这样刚用「写入并构建」加的素材能直接看到；
# 想退回读线上目录：POSEWEAR_STAGING= ./local-preview.sh
export POSEWEAR_STAGING="${POSEWEAR_STAGING-$PWD/dist}"
PROXY_PORT="${PROXY_PORT:-7890}"
export PORT

if nc -z 127.0.0.1 "$PROXY_PORT" 2>/dev/null; then
  echo "使用代理 127.0.0.1:$PROXY_PORT"
  export HTTP_PROXY="http://127.0.0.1:$PROXY_PORT"
  export HTTPS_PROXY="$HTTP_PROXY"
  # 国内中转/方舟直连更快也更稳，别绕 Clash；R2 图床(pwimg)在国内直连会超时，必须走代理
  # undici 的 env-proxy 通道连 Cloudflare 图床(rwimg) 会 fetch failed；图床改直连（VPN 在时直连可用）
  export NO_PROXY="127.0.0.1,localhost,::1,api.gptx.cc,ark.cn-beijing.volces.com,ark-acg-cn-beijing.tos-cn-beijing.volces.com,pwimg.0vo.pro,pages.dev"
  export no_proxy="$NO_PROXY"
  exec node --use-env-proxy scripts/preview.mjs
fi

echo "代理未开启，直连启动（图库目录将使用本地缓存）"
exec node scripts/preview.mjs
