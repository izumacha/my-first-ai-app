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

describe("本文が受付上限を超えるメッセージの扱い", () => {
  it("上限を超える assistant 発言は切り詰めて送る（送信不能にしない）", () => {
    // 上流の回答が上限を超えた場合を模した履歴を用意する。
    // assistant 発言は上流の回答なので、こちら側では長さを制御できない
    const history: Message[] = [
      { role: "user", content: "レシピを教えて" },
      { role: "assistant", content: "あ".repeat(MAX_CONTENT_LENGTH + 500) },
      { role: "user", content: "続きを教えて" },
    ];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 発言は捨てられず、ターン構成が保たれることを確認する
    expect(trimmed).toHaveLength(3);
    // どのメッセージもサーバーの検証を通る長さに収まっていることを確認する。
    // 収まっていないと 400 になり、その発言が窓から抜けるまで会話を続けられない
    for (const message of trimmed) {
      expect(message.content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    }
    // 省略した事実が本文に残ることを確認する。印が無いと AI から見て
    // 「そこで終わった回答」と区別が付かず、続きを尋ねても噛み合わない
    expect(trimmed[1].content).toMatch(/省略されました/);
  });

  it("切り詰めても末尾の印は残る（印だけが真っ先に消えない）", () => {
    // 画面側が付けた「中断されました」の印を含む、上限ちょうどを超える回答を用意する。
    // 素朴に末尾から削ると、末尾にある印が最初に失われてしまう
    const interrupted = `${"あ".repeat(MAX_CONTENT_LENGTH)}\n\n（回答はここで中断されました）`;
    const history: Message[] = [
      { role: "user", content: "質問" },
      { role: "assistant", content: interrupted },
    ];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 上限以内に収まっていることを確認する
    expect(trimmed[1].content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    // 回答が完全でないことを示す印が何らかの形で残ることを確認する
    expect(trimmed[1].content).toMatch(/省略されました|中断されました/);
  });

  it("上限を超える user 発言は切り詰めない（黙って質問を削らない）", () => {
    // ユーザーが上限を超える長文を貼り付けた場合を模す
    const longQuestion = "あ".repeat(MAX_CONTENT_LENGTH + 500);
    const history: Message[] = [{ role: "user", content: longQuestion }];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // user 発言はそのまま送る。ここで黙って削ると、ユーザーは質問が途中で
    // 切れたことに気づけないまま送信してしまう（サーバーが理由付きの 400 を
    // 返し、画面にその理由が出るほうが「何が起きたか」が伝わる）
    expect(trimmed[0].content).toBe(longQuestion);
  });

  it("上限以内のメッセージは同じオブジェクトのまま返す（不要な複製をしない）", () => {
    // 上限以内の履歴を用意する
    const history: Message[] = [{ role: "user", content: "短い質問" }];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 同じオブジェクトがそのまま返ることを確認する。
    // toEqual だと構造の一致しか見ないので、複製する実装に変えても通ってしまう
    expect(trimmed[0]).toBe(history[0]);
  });

  it("切り詰めでサロゲートペアを割らない", () => {
    // 上限の境界がちょうど絵文字（サロゲートペア）の途中に来る本文を作る。
    // 上限より 1 文字短い部分＋絵文字にすると、上限位置がペアの真ん中になる
    const emoji = "😀";
    const content = "あ".repeat(MAX_CONTENT_LENGTH - 1) + emoji + "あ";
    // その本文を持つ assistant 発言を含む履歴を用意する
    const history: Message[] = [
      { role: "user", content: "質問" },
      { role: "assistant", content },
    ];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 上限以内に収まっていることを確認する
    expect(trimmed[1].content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    // 片割れだけのサロゲートが末尾に残っていないことを確認する。
    // 残っていると文字として成立しない値を上流へ送ることになる
    const lastCode = trimmed[1].content.charCodeAt(trimmed[1].content.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });
});

describe("共有する入力上限", () => {
  it("本文の最大文字数は正の整数である", () => {
    // 履歴の切り詰めとサーバーの検証で共有するため、妥当な値であることを確認する
    expect(Number.isInteger(MAX_CONTENT_LENGTH)).toBe(true);
    expect(MAX_CONTENT_LENGTH).toBeGreaterThan(0);
  });

  it("履歴の最大件数は user/assistant の往復を保てる 2 件以上である", () => {
    // 1 件だと直前の assistant 発言すら送れず文脈が失われるため 2 件以上を要求する
    expect(Number.isInteger(MAX_MESSAGE_COUNT)).toBe(true);
    expect(MAX_MESSAGE_COUNT).toBeGreaterThanOrEqual(2);
  });
});
