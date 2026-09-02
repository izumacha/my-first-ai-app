/**
 * 会話履歴の切り詰め（trimHistoryForRequest）のユニットテスト
 *
 * 画面（送信側）とサーバー（検証側）が同じ上限を共有できているか、
 * とくに「履歴が上限を超えても送信し続けられる」ことを境界値で確認する。
 */
import { describe, it, expect } from "vitest";
import {
  MAX_CONTENT_LENGTH,
  MAX_MESSAGE_COUNT,
  trimHistoryForRequest,
} from "@/lib/chat-limits";
import type { Message } from "@/lib/types";

/**
 * user / assistant が交互に並ぶ会話履歴を作るヘルパー
 * @param count - 作るメッセージ数（先頭は必ず user 発言）
 * @returns 交互に並んだ会話履歴
 */
function makeAlternatingHistory(count: number): Message[] {
  // 指定件数の配列を作り、偶数番目を user・奇数番目を assistant にする
  return Array.from({ length: count }, (_, index) => ({
    // 偶数番目（0 始まり）は user、奇数番目は assistant にする
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    // どの位置の発言かが分かる本文を入れる
    content: `メッセージ${index}`,
  }));
}

describe("trimHistoryForRequest", () => {
  it("上限以下の履歴はそのまま返す", () => {
    // 上限ちょうどの件数の履歴を用意する
    const history = makeAlternatingHistory(MAX_MESSAGE_COUNT);
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 1 件も捨てられていないことを確認する
    expect(trimmed).toEqual(history);
  });

  it("上限を超えた履歴は上限件数以内に収まる", () => {
    // 上限を大きく超える件数の履歴を用意する
    const history = makeAlternatingHistory(MAX_MESSAGE_COUNT * 3);
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // サーバーが弾かない件数まで減っていることを確認する
    expect(trimmed.length).toBeLessThanOrEqual(MAX_MESSAGE_COUNT);
  });

  it("切り詰めても最新の発言は必ず残る", () => {
    // 上限を超える件数の履歴を用意する
    const history = makeAlternatingHistory(MAX_MESSAGE_COUNT + 7);
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 捨てられるのは古い側だけなので、末尾（＝今回の入力）が残ることを確認する
    expect(trimmed[trimmed.length - 1]).toEqual(history[history.length - 1]);
  });

  it("切り詰めた結果は必ず user 発言で始まる（上流 API の要求）", () => {
    // 窓の先頭が assistant になる件数（上限＋1）で試す。
    // 単純な slice(-上限) だと先頭が assistant になり上流が 400 を返す
    const history = makeAlternatingHistory(MAX_MESSAGE_COUNT + 1);
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 先頭が user 発言であることを確認する
    expect(trimmed[0].role).toBe("user");
  });

  it("どの長さの履歴でも user 発言で始まり上限以内に収まる", () => {
    // 上限の前後を含む幅広い長さで不変条件を確認する
    for (let length = 1; length <= MAX_MESSAGE_COUNT + 5; length += 1) {
      // その長さの履歴を作る
      const history = makeAlternatingHistory(length);
      // 切り詰めを適用する
      const trimmed = trimHistoryForRequest(history);
      // 件数が上限以内であることを確認する
      expect(trimmed.length).toBeLessThanOrEqual(MAX_MESSAGE_COUNT);
      // 先頭が user 発言であることを確認する
      expect(trimmed[0].role).toBe("user");
    }
  });

  it("元の配列を書き換えない（純粋関数）", () => {
    // 上限を超える履歴と、その複製を用意する
    const history = makeAlternatingHistory(MAX_MESSAGE_COUNT + 3);
    // 比較用に元の内容を控えておく
    const snapshot = [...history];
    // 切り詰めを適用する
    trimHistoryForRequest(history);
    // 呼び出し元の配列が変わっていないことを確認する
    expect(history).toEqual(snapshot);
  });

  it("空の履歴は空のまま返す", () => {
    // 履歴が空の場合は切り詰める対象が無い
    expect(trimHistoryForRequest([])).toEqual([]);
  });
});

describe("共有する入力上限", () => {
  it("本文の最大文字数は正の整数である", () => {
    // 画面の maxLength とサーバーの検証で共有するため、妥当な値であることを確認する
    expect(Number.isInteger(MAX_CONTENT_LENGTH)).toBe(true);
    expect(MAX_CONTENT_LENGTH).toBeGreaterThan(0);
  });

  it("履歴の最大件数は user/assistant の往復を保てる 2 件以上である", () => {
    // 1 件だと直前の assistant 発言すら送れず文脈が失われるため 2 件以上を要求する
    expect(Number.isInteger(MAX_MESSAGE_COUNT)).toBe(true);
    expect(MAX_MESSAGE_COUNT).toBeGreaterThanOrEqual(2);
  });
});
