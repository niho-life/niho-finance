"""Dump the first sheet of an Excel file (.xls or .xlsx) to CSV, cell for cell.

Used once a year to snapshot the NTA withholding tables (published as Excel) before
`build-withholding-table.ts` turns the snapshot into JSON. Needs `xlrd` (for .xls) and
`openpyxl` (for .xlsx): `python3 -m venv .venv && .venv/bin/pip install xlrd openpyxl`.

    .venv/bin/python -I scripts/xls-to-csv.py <downloaded.xls> data/<year>/source/withholding-monthly.csv

Integral floats are written as integers; everything else as the cell's string value.
"""

import csv
import sys


def read_rows(path: str) -> list[list[object]]:
    if path.lower().endswith(".xls"):
        import xlrd

        book = xlrd.open_workbook(path)
        sheet = book.sheet_by_index(0)
        return [[sheet.cell_value(r, c) for c in range(sheet.ncols)] for r in range(sheet.nrows)]
    import openpyxl

    book = openpyxl.load_workbook(path, data_only=True)
    sheet = book.worksheets[0]
    return [["" if v is None else v for v in row] for row in sheet.iter_rows(values_only=True)]


def normalize(value: object) -> object:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: xls-to-csv.py <input.xls|.xlsx> <output.csv>")
    rows = read_rows(sys.argv[1])
    with open(sys.argv[2], "w", newline="", encoding="utf-8") as out:
        writer = csv.writer(out)
        for row in rows:
            writer.writerow([normalize(v) for v in row])
    print(f"{len(rows)} rows -> {sys.argv[2]}", file=sys.stderr)


if __name__ == "__main__":
    main()
