import { describe, expect, it } from "vitest";
import { isBlankRow, parseCsvTable } from "../src/csv/table";

describe("parseCsvTable (RFC 4180)", () => {
  it("splits plain cells and rows", () => {
    expect(parseCsvTable("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("reads quoted cells with commas and escaped quotes", () => {
    expect(parseCsvTable('"a,b","say ""hi""",""\n')).toEqual([["a,b", 'say "hi"', ""]]);
  });

  it("keeps line breaks inside quotes", () => {
    expect(parseCsvTable('"line 1\r\nline 2",x\n"a\nb",y')).toEqual([
      ["line 1\r\nline 2", "x"],
      ["a\nb", "y"],
    ]);
  });

  it("accepts CRLF, LF and CR record ends", () => {
    expect(parseCsvTable("a,b\r\nc,d\re,f\ng,h")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("keeps empty cells and trailing commas", () => {
    expect(parseCsvTable(",a,,\n")).toEqual([["", "a", "", ""]]);
  });

  it("drops trailing empty lines but keeps empty lines in between", () => {
    expect(parseCsvTable("a\n\nb\n\n\r\n,,\n")).toEqual([["a"], [""], ["b"]]);
  });

  it("returns no rows for empty text", () => {
    expect(parseCsvTable("")).toEqual([]);
    expect(parseCsvTable("\n\n")).toEqual([]);
  });

  it("does not treat a quote inside a cell as an opening quote", () => {
    expect(parseCsvTable('ab"c,d\n')).toEqual([['ab"c', "d"]]);
  });

  it("reads an unterminated quote to the end of the text", () => {
    expect(parseCsvTable('"abc,def\nghi')).toEqual([["abc,def\nghi"]]);
  });

  it("drops a BOM left in the text", () => {
    expect(parseCsvTable("\uFEFFa,b")).toEqual([["a", "b"]]);
  });
});

describe("isBlankRow", () => {
  it("is true when every cell is empty after trimming", () => {
    expect(isBlankRow([""])).toBe(true);
    expect(isBlankRow(["", " ", "　"])).toBe(true);
    expect(isBlankRow(["", "x"])).toBe(false);
  });
});
