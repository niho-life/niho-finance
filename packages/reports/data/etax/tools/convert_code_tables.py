"""Converts the NTA's HOT010 code tables (Excel) into the JSON under ../hot010-3.0/<edition>/.

Standard library only (zipfile + ElementTree), so it runs anywhere Python 3 does:

    python3 -I convert_code_tables.py <dir with the downloaded .xlsx> <output dir>

Inputs (the file names on the e-Tax site, 17-financial-statements §6):
  BScode10_2019.xlsx  PLcode10_2019.xlsx  SScode_2019.xlsx  NTcode_2019.xlsx  HOT010_3.0_NT.xlsx
The NT standard form gives each note's 行区分 (金額 1 / 文字 2 / タイトル T), which the code table lacks.
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def col_index(ref):
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def shared_strings(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall("m:si", NS):
        parts = []
        for child in si:  # <t> or rich-text <r><t>; <rPh> (furigana) is skipped
            tag = child.tag.split("}")[1]
            if tag == "t":
                parts.append(child.text or "")
            elif tag == "r":
                for t in child.findall("m:t", NS):
                    parts.append(t.text or "")
        out.append("".join(parts))
    return out


def sheet_rows(path, name_contains):
    """Rows of the first sheet whose name contains `name_contains`, as lists of cell strings."""
    z = zipfile.ZipFile(path)
    strings = shared_strings(z)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    targets = {r.get("Id"): r.get("Target") for r in rels}
    for sheet in wb.find("m:sheets", NS):
        if name_contains not in sheet.get("name"):
            continue
        target = targets[sheet.get("{%s}id" % NS["r"])].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        root = ET.fromstring(z.read(target))
        rows = []
        for row in root.iter("{%s}row" % NS["m"]):
            cells = {}
            for c in row.findall("m:c", NS):
                kind, v = c.get("t"), c.find("m:v", NS)
                if kind == "s" and v is not None:
                    value = strings[int(v.text)]
                elif kind == "inlineStr":
                    value = "".join(t.text or "" for t in c.iter("{%s}t" % NS["m"]))
                else:
                    value = v.text if v is not None else ""
                cells[col_index(c.get("r"))] = (value or "").strip()
            if cells:
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
        return rows
    raise SystemExit(f"{path}: no sheet named like {name_contains!r}")


def cell(row, i):
    return row[i] if i < len(row) else ""


def bs_pl_rows(path):
    # Columns: 0 業種 1 科目分類 2 標準ラベル … 15 depth 16 タイトル項目 17 合計 18 勘定科目区分
    # 19 勘定科目コード 20 e-Tax対応勘定科目 21 (英語) 22 e-Tax対応勘定科目区分
    out = []
    for row in sheet_rows(path, "2019"):
        code = cell(row, 19)
        if not re.fullmatch(r"10[A-F]\d{6}", code):
            continue
        label = cell(row, 20)
        if label in ("", "タイトル項目", "-"):
            label = cell(row, 2)
        item = {"code": code, "depth": int(cell(row, 15)), "label": label}
        if cell(row, 16) == "○":
            item["title"] = True
        if cell(row, 17) == "○":
            item["total"] = True
        out.append(item)
    return out


def nt_row_kinds(path):
    kinds = {}
    for row in sheet_rows(path, "HOT010_3.0_NT"):
        code, kind = cell(row, 8), cell(row, 6)
        if re.fullmatch(r"NT\d{4}", code) and kind in ("1", "2", "T"):
            kinds[code] = kind
    return kinds


def ss_nt_rows(path, sheet, prefix, row_kinds=None):
    # Columns: 0 日本語名称 1 英語名称 2 階層番号 3 タイトル項目 4 勘定科目区分 5 繰り返し設定可能 6 勘定科目コード
    out = []
    for row in sheet_rows(path, sheet):
        code = cell(row, 6)
        if not re.fullmatch(prefix + r"\d{4}", code):
            continue
        item = {"code": code, "depth": int(cell(row, 2)), "label": cell(row, 0)}
        title = cell(row, 3) == "○"
        if title:
            item["title"] = True
        if row_kinds is not None:
            item["rowKind"] = "T" if title else row_kinds.get(code, "2")
        else:
            item["rowKind"] = "T" if title else "1"
        repeat = cell(row, 5)
        if repeat == "◎":
            item["repeat"] = "group"
        elif repeat == "○":
            item["repeat"] = "item"
        out.append(item)
    return out


def main(src, dst):
    src, dst = Path(src), Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    tables = {
        "bs-10.json": {"statement": "BS", "rows": bs_pl_rows(src / "BScode10_2019.xlsx")},
        "pl-10.json": {"statement": "PL", "rows": bs_pl_rows(src / "PLcode10_2019.xlsx")},
        "ss.json": {
            "statement": "SS",
            "rows": ss_nt_rows(src / "SScode_2019.xlsx", "株主資本等変動計算書", "SS"),
        },
        "nt.json": {
            "statement": "NT",
            "rows": ss_nt_rows(
                src / "NTcode_2019.xlsx",
                "個別注記表",
                "NT",
                nt_row_kinds(src / "HOT010_3.0_NT.xlsx"),
            ),
        },
    }
    for name, table in tables.items():
        codes = [row["code"] for row in table["rows"]]
        if len(codes) != len(set(codes)):
            raise SystemExit(f"{name}: duplicate codes")
        # One row per line: reviewable diffs when a new edition is imported.
        lines = [json.dumps(row, ensure_ascii=False) for row in table["rows"]]
        with open(dst / name, "w", encoding="utf-8") as f:
            f.write('{"statement": "%s", "rows": [\n' % table["statement"])
            f.write(",\n".join(lines))
            f.write("\n]}\n")
        print(f"{name}: {len(table['rows'])} rows")


if __name__ == "__main__":
    main(*sys.argv[1:3])
