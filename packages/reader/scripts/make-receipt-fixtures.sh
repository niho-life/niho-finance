#!/usr/bin/env bash
# Generates the gold set (20-reader §12): ten fictional receipts and invoices under
# fixtures/receipts — seven images (r01–r07) and three raster PDFs (r08–r10).
#
# Every issuer, address and registration number is fictional (names start with 架空; numbers are
# a base of 9s with its check digit). The text is drawn with Noto Sans JP (OFL) from apps/web.
# The output is deterministic, so the SHA-256 keys of recorded.json stay valid; after changing a
# fixture, update expected.json and record the answers again.
#
# Usage: packages/reader/scripts/make-receipt-fixtures.sh   (needs ImageMagick 7: `magick`)
set -euo pipefail

MAGICK="${MAGICK:-magick}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FONT="$ROOT/apps/web/lib/pdf/fonts/NotoSansJP-Regular.ttf"
OUT="$ROOT/packages/reader/fixtures/receipts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Escapes text for -annotate (percent escapes and backslashes).
esc() {
  local s=${1//\\/\\\\}
  printf '%s' "${s//%/%%}"
}

# render OUT WIDTH POINTSIZE MARGIN LINE...
#   "=text"        centered
#   "-"            a rule
#   "left|right"   left- and right-aligned (either side may be empty)
#   "text"         left-aligned
#   ""             a blank line
render() {
  local out=$1 width=$2 size=$3 margin=$4
  shift 4
  local step=$((size * 17 / 10))
  local height=$((margin * 2 + step * $#))
  local y=$margin mid left right line
  local -a ops=()
  for line in "$@"; do
    case "$line" in
      "") ;;
      "-")
        mid=$((y + step / 2))
        ops+=(-gravity NorthWest -stroke black -strokewidth 2
          -draw "line $margin,$mid $((width - margin)),$mid" -stroke none)
        ;;
      =*) ops+=(-gravity North -annotate "+0+$y" "$(esc "${line#=}")") ;;
      *"|"*)
        left=${line%%|*}
        right=${line#*|}
        [[ -n $left ]] && ops+=(-gravity NorthWest -annotate "+$margin+$y" "$(esc "$left")")
        [[ -n $right ]] && ops+=(-gravity NorthEast -annotate "+$margin+$y" "$(esc "$right")")
        ;;
      *) ops+=(-gravity NorthWest -annotate "+$margin+$y" "$(esc "$line")") ;;
    esac
    y=$((y + step))
  done
  "$MAGICK" -size "${width}x${height}" xc:white -font "$FONT" -pointsize "$size" -fill black \
    "${ops[@]}" -colorspace Gray -depth 8 "$out"
}

png() {
  local name=$1
  shift
  render "$TMP/$name.png" 720 26 48 "$@"
  "$MAGICK" "$TMP/$name.png" -strip -define png:exclude-chunks=date,time "$OUT/$name.png"
}

jpeg() {
  local name=$1
  shift
  render "$TMP/$name.png" 720 26 48 "$@"
  "$MAGICK" "$TMP/$name.png" -strip -quality 85 "$OUT/$name.jpg"
}

# An A4 page at 100 dpi as a raster PDF. The timestamps ImageMagick writes are replaced by a
# fixed date of the same length, which keeps the cross-reference offsets valid.
pdf() {
  local name=$1
  shift
  render "$TMP/$name.png" 827 20 64 "$@"
  "$MAGICK" "$TMP/$name.png" -background white -gravity North -extent 827x1169 -strip \
    -units PixelsPerInch -density 100 -compress Zip "$OUT/$name.pdf"
  perl -pi -e 's/\(D:\d{14}([^)]*)\)/"(D:20261001000000" . ("0" x length($1)) . ")"/ge' \
    "$OUT/$name.pdf"
}

mkdir -p "$OUT"

png r01 \
  "=架空食堂" "=架空県架空市本町1-2-3" "=登録番号 T8999999999901" "" "=領収書" \
  "2026年10月02日(金) 12:34|No.0123" "-" \
  "日替わり定食 ×2|¥2,200" "ドリンク|¥300" "-" \
  "合計|¥2,500" "(10%対象|¥2,500)" "(内消費税|¥227)" "お預り|¥3,000" "お釣り|¥500" "-" \
  "=ご来店ありがとうございました"

jpeg r02 \
  "=架空マート 架空駅前店" "=架空県架空市駅前1-1" "=登録番号 T7999999999902" "" \
  "2026年10月05日(月) 08:15|レジ02" "-" \
  "※お茶|¥150" "※おにぎり ×2|¥320" "ボールペン|¥330" "乾電池|¥550" "-" \
  "合計|¥1,350" "(8%対象|¥470)" "(内消費税等|¥34)" "(10%対象|¥880)" "(内消費税等|¥80)" \
  "お預り|¥2,000" "お釣り|¥650" "" "※は軽減税率対象商品です"

png r03 \
  "=領収書" "" "=架空タクシー株式会社" "=登録番号 T6-9999-9999-9903" "" \
  "乗車日|2026年10月07日(水)" "乗車|14:02" "降車|14:31" "-" \
  "運賃|¥2,860" "(10%対象|¥2,860)" "(内消費税|¥260)" "-" \
  "合計|¥2,860" "" "但し タクシー代として" "上記正に領収いたしました"

png r04 \
  "=架空パーキング" "=駐車料金領収証" "" \
  "入庫|2026/10/09 13:05" "出庫|2026/10/09 15:20" "駐車時間|2時間15分" "-" \
  "駐車料金|¥800" "(10%対象|¥800)" "(内消費税|¥72)" "-" \
  "合計|¥800" "" "=またのご利用をお待ちしております"

jpeg r05 \
  "=架空書店 本店" "=架空県架空市本町2-3-4" "=登録番号 T5999999999904" "" \
  "2026年10月12日(月) 18:40" "-" \
  "書籍 架空の簿記入門|¥1,980" "雑誌 月刊架空|¥880" "-" \
  "合計|¥2,860" "(10%対象|¥2,860)" "(内消費税|¥260)" "お預り|¥3,000" "お釣り|¥140"

png r06 \
  "=架空文具店" "=登録番号 T4999999999905" "" \
  "2026年10月14日(水) 10:05" "-" \
  "ノート ×3|¥990" "クリアファイル ×2|¥440" "万年筆インク|¥1,100" "-" \
  "合計|¥2,530" "(10%対象|¥2,530)" "(内消費税|¥230)" "クレジット|¥2,530"

jpeg r07 \
  "=架空スーパー 架空店" "=架空県架空市中央5-6-7" "=登録番号 T3999999999906" "" \
  "2026年10月16日(金) 19:22" "-" \
  "※牛乳|¥248" "※食パン|¥324" "※弁当|¥540" "※コーヒー豆|¥1,280" \
  "キッチンペーパー|¥418" "洗剤|¥385" "-" \
  "合計|¥3,195" "(8%対象|¥2,392)" "(内消費税等|¥177)" "(10%対象|¥803)" "(内消費税等|¥73)" \
  "お預り|¥5,000" "お釣り|¥1,805" "" "※は軽減税率対象商品です"

pdf r08 \
  "=請求書" "" \
  "架空商事株式会社 御中|請求日 2026年10月20日" "|請求番号 INV-0001" "" \
  "|架空クラウドサービス株式会社" "|架空県架空市港1-2-3" "|登録番号 T2999999999907" "" \
  "下記のとおりご請求申し上げます。" "ご請求金額（税込） ¥13,200" "-" \
  "品目|金額（税抜）" "クラウド利用料（2026年10月分） 1式|¥12,000" "-" \
  "小計（税抜）|¥12,000" "10%対象|¥12,000" "消費税（10%）|¥1,200" "合計（税込）|¥13,200" "-" \
  "お支払期限 2026年11月30日" "振込先 架空銀行 架空支店"

pdf r09 \
  "=請求書" "" \
  "架空商事株式会社 御中|請求日 2026年10月23日" "|請求番号 2026-1023-01" "" \
  "|架空印刷株式会社" "|架空県架空市工業団地4-5" "|登録番号 T1999999999908" "" \
  "下記のとおりご請求申し上げます。" "ご請求金額（税込） ¥25,300" "-" \
  "品目|金額（税抜）" "名刺印刷 100枚 × 2名|¥5,000" "チラシ印刷 1,000枚|¥18,000" "-" \
  "小計（税抜）|¥23,000" "10%対象|¥23,000" "消費税（10%）|¥2,300" "合計（税込）|¥25,300" "-" \
  "お支払期限 2026年11月30日" "振込先 架空銀行 架空支店"

pdf r10 \
  "=請求書" "" \
  "架空商事株式会社 御中|請求日 2026年10月27日" "|請求番号 F-1027" "" \
  "|架空食品株式会社" "|架空県架空市市場町8-9" "|登録番号 T9999999999909" "" \
  "下記のとおりご請求申し上げます。" "ご請求金額（税込） ¥9,740" "-" \
  "品目|金額（税抜）" "※菓子詰め合わせ 10箱 × ¥800|¥8,000" "配送料|¥1,000" "-" \
  "8%対象（税抜）|¥8,000" "消費税（8%）|¥640" "10%対象（税抜）|¥1,000" "消費税（10%）|¥100" \
  "合計（税込）|¥9,740" "-" "※は軽減税率対象" "お支払期限 2026年11月30日"

for file in "$OUT"/r[0-9][0-9].*; do
  printf '%s  %s\n' "$(shasum -a 256 "$file" | cut -d' ' -f1)" "$(basename "$file")"
done
