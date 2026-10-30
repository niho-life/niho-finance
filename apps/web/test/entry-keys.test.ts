import { describe, expect, it } from "vitest";
import {
  entryKeyIntent,
  isEnterField,
  type EntryKey,
} from "../app/(app)/entries/_components/entry-keys";

/* 続けて登録とキーボード (11 §4.5): what Enter does in a new-entry form. */

function key(overrides: Partial<EntryKey> = {}): EntryKey {
  return {
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    ...overrides,
  };
}

const text = { tagName: "INPUT", type: "text" };

describe("entryKeyIntent", () => {
  it("goes to the next field on Enter in a one-line field or a select", () => {
    expect(entryKeyIntent(key(), text)).toBe("next");
    expect(entryKeyIntent(key(), { tagName: "INPUT", type: "date" })).toBe("next");
    expect(entryKeyIntent(key(), { tagName: "INPUT", type: "checkbox" })).toBe("next");
    expect(entryKeyIntent(key(), { tagName: "SELECT" })).toBe("next");
    expect(entryKeyIntent(key(), { tagName: "INPUT" })).toBe("next");
  });

  it("leaves Enter to buttons and textareas", () => {
    expect(entryKeyIntent(key(), { tagName: "BUTTON", type: "submit" })).toBeNull();
    expect(entryKeyIntent(key(), { tagName: "TEXTAREA" })).toBeNull();
    expect(entryKeyIntent(key(), { tagName: "A" })).toBeNull();
  });

  it("presses 「続けて登録」 on Cmd+Enter or Ctrl+Enter from anywhere", () => {
    expect(entryKeyIntent(key({ metaKey: true }), text)).toBe("continue");
    expect(entryKeyIntent(key({ ctrlKey: true }), { tagName: "SELECT" })).toBe("continue");
    expect(entryKeyIntent(key({ metaKey: true }), { tagName: "TEXTAREA" })).toBe("continue");
    expect(entryKeyIntent(key({ ctrlKey: true }), { tagName: "BUTTON", type: "button" })).toBe(
      "continue",
    );
  });

  it("does not send on Shift+Enter or Alt+Enter in a field", () => {
    expect(entryKeyIntent(key({ shiftKey: true }), text)).toBe("stay");
    expect(entryKeyIntent(key({ altKey: true }), text)).toBe("stay");
    expect(entryKeyIntent(key({ metaKey: true, shiftKey: true }), text)).toBe("stay");
    expect(entryKeyIntent(key({ shiftKey: true }), { tagName: "TEXTAREA" })).toBeNull();
  });

  it("leaves Enter to the IME while it converts", () => {
    expect(entryKeyIntent(key({ isComposing: true }), text)).toBeNull();
    expect(entryKeyIntent(key({ keyCode: 229 }), text)).toBeNull();
    expect(entryKeyIntent(key({ isComposing: true, metaKey: true }), text)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(entryKeyIntent(key({ key: "Tab", keyCode: 9 }), text)).toBeNull();
    expect(entryKeyIntent(key({ key: "a", keyCode: 65, metaKey: true }), text)).toBeNull();
  });
});

describe("isEnterField", () => {
  it("is not a button-like input", () => {
    for (const type of ["button", "submit", "reset", "image", "file", "hidden"]) {
      expect(isEnterField({ tagName: "INPUT", type })).toBe(false);
    }
    expect(isEnterField({ tagName: "input", type: "TEXT" })).toBe(true);
  });
});
