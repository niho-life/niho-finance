"use server";

import { getPrismaClient, searchAll, SEARCH_KIND_LABELS, SEARCH_PER_KIND } from "@niho-finance/db";
import { z } from "zod";
import { attempt } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { authorizeAction } from "@/lib/authz";
import { searchView, type SearchView } from "./hit-view";

const SEARCH_FAILED =
  "検索できませんでした。もう一度試してください。続くときは画面を読み込み直してください";

/** The palette's input is at most 100 characters (`maxLength`). */
const querySchema = z.string().max(100);

/** 全体検索 of the palette (10 §7): per kind the first 5 hits and the count. Reads only. */
export async function searchAction(q: string): Promise<ActionResult<SearchView>> {
  // 閲覧 sees 報告 and 書き出し only (23 §3.4): searching the books is for 経理 and 管理者.
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  const result = await attempt(() => searchAll(getPrismaClient(), querySchema.parse(q)));
  if (!result.ok) return { ...result, error: SEARCH_FAILED, formError: SEARCH_FAILED };
  return { ok: true, data: searchView(result.data, SEARCH_KIND_LABELS, SEARCH_PER_KIND) };
}
