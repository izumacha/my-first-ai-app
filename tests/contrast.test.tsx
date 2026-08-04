/**
 * 文字色コントラストの回帰テスト（§7 アクセシビリティ）
 *
 * CLAUDE.md §7 は「コントラスト比は WCAG AA を満たす（通常文 4.5:1 / 大きな文字 3:1）」
 * を必達としているが、Tailwind のユーティリティクラスは色名を書くだけで比率が見えないため、
 * `text-gray-400` のような薄い色がレビューをすり抜けやすい（実際にすり抜けていた）。
 *
 * そこでこのテストは「クラス名を固定で書き写す」のではなく、
 *   1. 実際にコンポーネントを描画して DOM の className から前景色・背景色クラスを抜き出し、
 *   2. Tailwind が配布する theme.css の OKLCH 定義を実際に sRGB へ変換して、
 *   3. WCAG 2.x の相対輝度式でコントラスト比を計算する
 * という手順で検証する。ハードコードした期待値リストを持たないので、
 * コンポーネント側の色クラスを変えた時点でこのテストが自動的に新しい色を測り直す。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { render, screen } from "@testing-library/react";
import ChatMessage from "@/components/ChatMessage";
import ChatContainer from "@/components/ChatContainer";

/** WCAG AA が通常文（18pt 未満 / 14pt 未満の太字）に要求する最低コントラスト比 */
const WCAG_AA_NORMAL_TEXT = 4.5;

/** ライトテーマのページ背景（layout.tsx の body に付く `bg-white`） */
const PAGE_BG_LIGHT = "white";
/** ダークテーマのページ背景（layout.tsx の body に付く `dark:bg-gray-900`） */
const PAGE_BG_DARK = "gray-900";

/** OKLCH の色（明度 L は 0〜1、彩度 C、色相 h は度）を表す型 */
type Oklch = { l: number; c: number; h: number };

/**
 * Tailwind が配布する theme.css から既定パレット（`--color-*: oklch(...)`）を読み込む。
 * パレットの値を自前で書き写すと Tailwind の更新で実物とズレるため、必ず実ファイルから読む。
 * @returns 色名（例 "gray-600"）から OKLCH 値への対応表
 */
function loadTailwindPalette(): Map<string, Oklch> {
  // テストファイルからの相対パスに依存せず tailwindcss パッケージの実体を解決する
  const requireFromHere = createRequire(import.meta.url);
  // theme.css（既定のデザイントークン定義）のフルパスを求める
  const themePath = requireFromHere.resolve("tailwindcss/theme.css");
  // CSS の中身を文字列として読み込む
  const css = readFileSync(themePath, "utf-8");
  // 色名 → OKLCH 値の対応表を用意する
  const palette = new Map<string, Oklch>();
  // `--color-<名前>: oklch(<L>% <C> <h>)` の形をすべて拾う
  for (const m of css.matchAll(
    /--color-([a-z0-9-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g
  )) {
    // パーセント表記の明度を 0〜1 に直して登録する
    palette.set(m[1], {
      l: Number(m[2]) / 100,
      c: Number(m[3]),
      h: Number(m[4]),
    });
  }
  // 純白 `--color-white: #fff` と純黒 `--color-black: #000` は oklch 表記ではないので明示的に補う
  palette.set("white", { l: 1, c: 0, h: 0 });
  palette.set("black", { l: 0, c: 0, h: 0 });
  // 完成した対応表を返す
  return palette;
}

/** テスト全体で使い回す Tailwind の既定パレット */
const PALETTE = loadTailwindPalette();

/**
 * OKLCH の色を「線形 sRGB」の 3 成分へ変換する（WCAG の相対輝度計算に必要な形）。
 * OKLCH → OKLab → LMS → 線形 sRGB の順に、Björn Ottosson の定義どおり変換する。
 * @param color - OKLCH の色
 * @returns 線形 sRGB の [赤, 緑, 青]（0〜1 にクランプ済み）
 */
function oklchToLinearRgb({ l: lightness, c: chroma, h: hue }: Oklch): number[] {
  // 色相（度）をラジアンに直す（三角関数が受け取る単位に合わせる）
  const hueRad = (hue * Math.PI) / 180;
  // 極座標（彩度・色相）を直交座標の a（緑〜赤）成分に直す
  const a = chroma * Math.cos(hueRad);
  // 同じく b（青〜黄）成分に直す
  const b = chroma * Math.sin(hueRad);
  // OKLab から LMS 錐体応答の立方根空間へ戻す（長波長）
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  // 同（中波長）
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  // 同（短波長）
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  // 立方根空間から実際の LMS 値へ戻す（3 乗する）
  const [lms0, lms1, lms2] = [lRoot ** 3, mRoot ** 3, sRoot ** 3];
  // LMS から線形 sRGB への行列変換を適用する
  const rgb = [
    4.0767416621 * lms0 - 3.3077115913 * lms1 + 0.2309699292 * lms2,
    -1.2684380046 * lms0 + 2.6097574011 * lms1 - 0.3413193965 * lms2,
    -0.0041960863 * lms0 - 0.7034186147 * lms1 + 1.707614701 * lms2,
  ];
  // 色域外に出た値は 0〜1 に丸める（画面表示と同じ扱いにする）
  return rgb.map((v) => Math.min(1, Math.max(0, v)));
}

/**
 * Tailwind の色名から WCAG の相対輝度を求める。
 * @param colorName - Tailwind の色名（例 "blue-600"）
 * @returns 相対輝度（0〜1）
 */
function relativeLuminance(colorName: string): number {
  // パレットから OKLCH 値を引く
  const color = PALETTE.get(colorName);
  // パレットに無い色名はテスト側の書き間違いなので、原因が分かる形で落とす
  if (!color) {
    throw new Error(`Tailwind パレットに色 "${colorName}" が見つかりません。`);
  }
  // 線形 sRGB へ変換する
  const [r, g, b] = oklchToLinearRgb(color);
  // WCAG 2.x の係数で相対輝度を合成して返す
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 2 色のコントラスト比を WCAG の定義（(明+0.05)/(暗+0.05)）で求める。
 * @param foreground - 前景（文字）の Tailwind 色名
 * @param background - 背景の Tailwind 色名
 * @returns コントラスト比（1〜21）
 */
function contrastRatio(foreground: string, background: string): number {
  // 前景・背景それぞれの相対輝度を求める
  const [lumA, lumB] = [relativeLuminance(foreground), relativeLuminance(background)];
  // 明るい方・暗い方に振り分ける（どちらが前景かに依存しない値にする）
  const [lighter, darker] = lumA >= lumB ? [lumA, lumB] : [lumB, lumA];
  // WCAG の式でコントラスト比を返す
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * className 文字列から、指定した種類の色クラスをライト／ダーク別に抜き出す。
 * 例: "text-gray-600 dark:text-gray-400" → { light: "gray-600", dark: "gray-400" }
 * @param className - 要素の class 属性の中身
 * @param prefix - 抜き出す種類（"text" か "bg"）
 * @returns ライト／ダークの色名（見つからなければ undefined）
 */
function extractColor(
  className: string,
  prefix: "text" | "bg"
): { light?: string; dark?: string } {
  // 抜き出した結果を入れる箱を用意する
  const found: { light?: string; dark?: string } = {};
  // 空白区切りの各クラスを順に見ていく
  for (const token of className.split(/\s+/)) {
    // `dark:` 付きかどうかで、どちらのテーマ向けかを判定する
    const isDark = token.startsWith("dark:");
    // `dark:` を外した本体部分を取り出す
    const base = isDark ? token.slice("dark:".length) : token;
    // 目的の接頭辞（text- / bg-）で始まらないクラスは読み飛ばす
    if (!base.startsWith(`${prefix}-`)) continue;
    // 接頭辞を外した色名部分を取り出す
    const colorName = base.slice(prefix.length + 1);
    // パレットに存在する色名だけを採用する（text-xs や text-center などを弾く）
    if (!PALETTE.has(colorName)) continue;
    // ライト／ダークの該当欄に記録する
    if (isDark) found.dark = colorName;
    else found.light = colorName;
  }
  // 抜き出した結果を返す
  return found;
}

/**
 * ある要素の文字色が、ライト／ダーク双方の背景に対して AA を満たすことを検証する。
 * @param element - 検査対象の要素（文字色クラスを持つ）
 * @param backgrounds - ライト／ダークそれぞれの背景色名
 */
function expectReadable(
  element: HTMLElement,
  backgrounds: { light: string; dark: string }
): void {
  // 要素の class からライト／ダークの文字色を抜き出す
  const textColor = extractColor(element.className, "text");
  // ライト用の文字色が指定されていることを確かめる（未指定なら検証できない）
  expect(textColor.light, `${element.textContent} の文字色クラス`).toBeDefined();
  // ライトテーマでのコントラスト比が AA を満たすことを確かめる
  expect(
    contrastRatio(textColor.light as string, backgrounds.light),
    `light: ${textColor.light} on ${backgrounds.light}`
  ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  // ダーク用の文字色が未指定ならライト用の色がそのまま使われるので、それを検査対象にする
  const darkText = textColor.dark ?? (textColor.light as string);
  // ダークテーマでのコントラスト比が AA を満たすことを確かめる
  expect(
    contrastRatio(darkText, backgrounds.dark),
    `dark: ${darkText} on ${backgrounds.dark}`
  ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
}

describe("文字色コントラスト（WCAG AA）", () => {
  // ChatContainer は描画直後に自動スクロールするが、jsdom には scrollIntoView が
  // 実装されていないため、色の検証に入る前に無害なダミー関数を生やしておく
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  // 他のテストファイルへ影響を残さないよう、生やしたダミー関数を取り除く
  afterAll(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  // 変換ロジック自体が壊れていないことを、既知の極端な組み合わせで先に確かめる
  it("コントラスト計算が WCAG の既知値と一致すること", () => {
    // 白と黒は理論上の最大値 21:1 になる（小数第 1 位まで一致すれば十分）
    expect(contrastRatio("white", "black")).toBeCloseTo(21, 1);
    // 同じ色同士は最小値 1:1 になる
    expect(contrastRatio("gray-600", "gray-600")).toBeCloseTo(1, 5);
  });

  // ユーザー吹き出しの送信者ラベルが、青い吹き出し背景に対して読めることを確かめる
  it("ユーザー吹き出しの送信者ラベルが AA を満たすこと", () => {
    render(<ChatMessage message={{ role: "user", content: "テスト" }} />);
    // 送信者ラベルの要素を取得する
    const label = screen.getByText("あなた");
    // 吹き出し（親要素）の背景色クラスを取得する
    const bubble = extractColor(label.parentElement!.className, "bg");
    // ユーザー吹き出しはライト／ダーク共通の背景色なので、両テーマとも同じ色で検査する
    expectReadable(label, {
      light: bubble.light as string,
      dark: bubble.dark ?? (bubble.light as string),
    });
  });

  // AI 吹き出しの送信者ラベルが、灰色の吹き出し背景に対して読めることを確かめる
  it("AI 吹き出しの送信者ラベルが AA を満たすこと", () => {
    render(<ChatMessage message={{ role: "assistant", content: "テスト" }} />);
    // 送信者ラベルの要素を取得する
    const label = screen.getByText("AI アシスタント");
    // 吹き出し（親要素）の背景色クラスを取得する
    const bubble = extractColor(label.parentElement!.className, "bg");
    // AI 吹き出しはライト／ダークで背景色が異なるため、それぞれの背景で検査する
    expectReadable(label, {
      light: bubble.light as string,
      dark: bubble.dark as string,
    });
  });

  // 会話が空のときに出るウェルカム文が、ページ背景に対して読めることを確かめる
  it("ウェルカムメッセージが AA を満たすこと", () => {
    render(<ChatContainer messages={[]} streamingText="" />);
    // ウェルカム文の見出し行を取得する
    const heading = screen.getByText("AI 暮らしアシスタント");
    // 色クラスは 2 行をまとめる親要素に付いているので、そこを検査対象にする
    const wrapper = heading.parentElement as HTMLElement;
    // 吹き出しではなくページ背景の上に置かれるので、body の背景色と比べる
    expectReadable(wrapper, { light: PAGE_BG_LIGHT, dark: PAGE_BG_DARK });
  });
});
