/**
 * 電子取引データの訂正及び削除の防止に関する事務処理規程 (13-documents §5, §10): the source of the text.
 * `docs/ops/electronic-records-policy.md` carries the same text after its `---` (a unit test keeps
 * them equal). Changing the text raises `POLICY_VERSION`, and the owner puts it in force again in
 * 設定 › 証憑の規程. Pure data and functions: shared by the settings page and its print view.
 */

/** Version of the text; stored with the effective date when the policy is put in force. */
export const POLICY_VERSION = "2026-10";

export const POLICY_TITLE = "電子取引データの訂正及び削除の防止に関する事務処理規程";

/** The values filled into the text. `effectiveOn` is the display string (e.g. `2026年11月10日`). */
export interface PolicyValues {
  /** 商号 */
  company: string;
  /** 管理責任者 */
  manager: string;
  /** 処理責任者 */
  operator: string;
  /** 施行日 */
  effectiveOn: string;
}

/** Shown in place of a value that is not entered yet (the template's wording). */
export const POLICY_PLACEHOLDERS: Readonly<PolicyValues> = {
  company: "（商号）",
  manager: "（管理責任者）",
  operator: "（処理責任者）",
  effectiveOn: "（施行日）",
};

export interface PolicyArticle {
  /** 条の見出し, e.g. 「（目的）」 */
  heading: string;
  /** 第n条 and its items / clauses; `{company}` `{manager}` `{operator}` `{effectiveOn}` are filled. */
  paragraphs: readonly string[];
}

export interface PolicyChapter {
  /** e.g. 「第1章 総則」 */
  title: string;
  articles: readonly PolicyArticle[];
}

export const POLICY_CHAPTERS: readonly PolicyChapter[] = [
  {
    title: "第1章 総則",
    articles: [
      {
        heading: "（目的）",
        paragraphs: [
          "第1条 この規程は、電子計算機を使用して作成する国税関係帳簿書類の保存方法等の特例に関する法律第7条に定められた電子取引の取引情報に係る電磁的記録の保存義務を履行するため、{company}（以下「当社」という。）において行った電子取引の取引情報に係る電磁的記録を適正に保存するために必要な事項を定め、これに基づき保存することを目的とする。",
        ],
      },
      {
        heading: "（適用範囲）",
        paragraphs: [
          "第2条 この規程は、当社の全ての役員及び従業員（契約社員、パートタイマー及び派遣社員を含む。以下同じ。）に対して適用する。",
        ],
      },
      {
        heading: "（管理責任者）",
        paragraphs: ["第3条 この規程の管理責任者は、{manager}とする。"],
      },
    ],
  },
  {
    title: "第2章 電子取引データの取扱い",
    articles: [
      {
        heading: "（電子取引の範囲）",
        paragraphs: [
          "第4条 当社における電子取引の範囲は、次に掲げる取引とする。",
          "一 電子メールにより請求書、領収書、見積書、納品書、契約書等（以下「請求書等」という。）を授受する取引",
          "二 ウェブサイト又はクラウドサービスから請求書等をダウンロードして受領する取引（決済代行サービスの請求書及び明細を含む。）",
          "三 インターネットバンキング及びクレジットカードの利用明細等、取引情報を電磁的記録で受領する取引",
          "四 スマートフォン決済、電子マネー等の利用により取引情報を電磁的記録で受領する取引",
          "五 当社が発行し、電磁的記録で交付する請求書等",
        ],
      },
      {
        heading: "（取引データの保存）",
        paragraphs: [
          "第5条 取引先から受領した取引関係情報及び取引先に提供した取引関係情報のうち、第6条に定めるデータについては、当社の会計システム「NIHO finance」の証憑の保管庫（以下「保存システム」という。）に、法人税法に定める保存期間（7年間。青色申告書を提出した事業年度で欠損金額が生じた事業年度にあっては10年間）保存する。",
          "２ 保存システムは、保存した電磁的記録の内容を訂正し、又は削除することができない仕組みとし、保存した電磁的記録ごとに取引年月日、取引金額及び取引先を記録して検索できるようにする。",
        ],
      },
      {
        heading: "（対象となるデータ）",
        paragraphs: [
          "第6条 保存する取引関係情報は、次のとおりとする。",
          "一 見積依頼情報及び見積回答情報",
          "二 確定注文情報及び注文請け情報",
          "三 納品情報",
          "四 請求情報及び領収情報",
          "五 支払情報（インターネットバンキングの振込データ、クレジットカードの利用明細及び決済代行サービスの明細を含む。）",
          "六 契約情報",
        ],
      },
      {
        heading: "（運用体制）",
        paragraphs: [
          "第7条 保存する取引関係情報の管理責任者及び処理責任者は、次のとおりとする。",
          "一 管理責任者 {manager}",
          "二 処理責任者 {operator}",
          "２ 管理責任者と処理責任者が同一の者であるときは、第9条第2項の承認は、同条第1項の理由を記録することをもって行う。",
        ],
      },
    ],
  },
  {
    title: "第3章 訂正及び削除",
    articles: [
      {
        heading: "（訂正削除の原則禁止）",
        paragraphs: [
          "第8条 保存する取引関係情報の内容について、訂正及び削除をすることは原則禁止とする。",
        ],
      },
      {
        heading: "（訂正削除を行う場合）",
        paragraphs: [
          "第9条 業務処理上やむを得ない理由（誤った電磁的記録の保存、同一の取引の重複した保存、取引先による再発行等）によって保存する取引関係情報を訂正し、又は削除する必要が生じた場合、処理責任者は、保存システムの「無効」又は「差し替え」の機能により、次の事項を記録した上でこれを行う。",
          "一 対象の電磁的記録（証憑 ID、ファイル名、取引年月日、取引金額及び取引先）",
          "二 訂正又は削除の日時及び処理担当者",
          "三 訂正又は削除の理由",
          "四 差し替えの場合は、新たに保存した電磁的記録の証憑 ID",
          "２ 管理責任者は、前項の記録を確認し、正当な理由があると認める場合に限り承認する。",
          "３ 訂正又は削除の対象となった電磁的記録は、保存システムから物理的に削除せず、無効である旨の表示を付して保存する。訂正及び削除の記録（監査ログ）は、対象となった電磁的記録の保存期間が満了するまで保存する。",
          "４ 前各項の記録は、「取引情報訂正・削除申請書」及び「取引情報訂正・削除完了報告書」に代えるものとする。",
        ],
      },
    ],
  },
  {
    title: "第4章 検索及び備付け",
    articles: [
      {
        heading: "（検索項目の記録）",
        paragraphs: [
          "第10条 処理責任者は、電磁的記録を保存した日の属する月の翌月末日までに、当該電磁的記録の取引年月日、取引金額及び取引先を保存システムに記録する。記録が済んでいない電磁的記録は、保存システムの受信箱で確認する。",
        ],
      },
      {
        heading: "（システム関係書類等の備付け）",
        paragraphs: [
          "第11条 管理責任者は、保存システムの概要書、仕様書、操作説明書及びこの規程を備え付け、国税に関する法律の規定による電磁的記録の提示又は提出の要求に応じることができるようにする。",
        ],
      },
    ],
  },
  {
    title: "附則",
    articles: [
      {
        heading: "（施行）",
        paragraphs: ["第12条 この規程は、{effectiveOn}から施行する。"],
      },
    ],
  },
];

export type PolicyBlockType = "title" | "version" | "chapter" | "heading" | "paragraph";

export interface PolicyBlock {
  type: PolicyBlockType;
  text: string;
}

export type PolicyInput = Partial<Record<keyof PolicyValues, string | null | undefined>>;

const SLOT = /\{(company|manager|operator|effectiveOn)\}/g;

function fill(text: string, values: PolicyInput): string {
  return text.replace(SLOT, (_slot, name: keyof PolicyValues) => {
    const value = values[name]?.trim();
    return value ? value : POLICY_PLACEHOLDERS[name];
  });
}

/** The text as blocks for the screen and print; empty values stay as the placeholders. */
export function renderPolicyBlocks(values: PolicyInput = {}): PolicyBlock[] {
  const blocks: PolicyBlock[] = [
    { type: "title", text: POLICY_TITLE },
    { type: "version", text: `（版 ${POLICY_VERSION}）` },
  ];
  for (const chapter of POLICY_CHAPTERS) {
    blocks.push({ type: "chapter", text: chapter.title });
    for (const article of chapter.articles) {
      blocks.push({ type: "heading", text: article.heading });
      for (const paragraph of article.paragraphs) {
        blocks.push({ type: "paragraph", text: fill(paragraph, values) });
      }
    }
  }
  return blocks;
}

const MARKDOWN_PREFIX: Readonly<Record<PolicyBlockType, string>> = {
  title: "# ",
  version: "",
  chapter: "## ",
  heading: "",
  paragraph: "",
};

/** The text as Markdown: `#` title, `##` chapters, every block a paragraph of its own. */
export function renderPolicyMarkdown(values: PolicyInput = {}): string {
  return `${renderPolicyBlocks(values)
    .map((block) => `${MARKDOWN_PREFIX[block.type]}${block.text}`)
    .join("\n\n")}\n`;
}
