/**
 * 会話履歴の切り詰め（trimHistoryForRequest）のユニットテスト
 *
 * 画面（送信側）とサーバー（検証側）が同じ上限を共有できているか、
 * とくに「履歴が上限を超えても送信し続けられる」ことを境界値で確認する。
 */
import { describe, it, expect } from "vitest";
import {
  CONTENT_EMPTY_MESSAGE,
  CONTENT_TOO_LONG_MESSAGE,
  findContentProblem,
  MAX_BODY_BYTES,
  MAX_CONTENT_LENGTH,
  MAX_MESSAGE_COUNT,
  OMITTED_MESSAGE_SUFFIX,
  TRUNCATED_ANSWER_SUFFIX,
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

  it("本文が空白だけのメッセージは送らない", () => {
    // 上流が空白だけの回答を返して正常終了した場合を模す
    const history: Message[] = [
      { role: "user", content: "質問" },
      { role: "assistant", content: "   \n  " },
      { role: "user", content: "次の質問" },
    ];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 空白だけの発言が取り除かれることを確認する。残すとサーバーが
    // 「メッセージ本文を入力してください。」で 400 を返し、しかも往復が成立しないので
    // 50 件の窓が進まず、その発言が永久に抜けない（復帰できない 400）
    expect(trimmed).toHaveLength(2);
    expect(trimmed.every((message) => message.content.trim() !== "")).toBe(true);
  });

  it("窓に user 発言が残らなくても、空の配列は返さない", () => {
    // 直近 50 件がすべて assistant 発言になる履歴を作る。
    // 窓の先頭を user にそろえる処理で全部落ち、素朴な実装では空配列になる
    // 拾われる 1 件は上限を超えた長文にしておく。長さを見ないと、この予備経路
    // だけが切り詰めを通っていなくても件数とロールの確認だけで緑になってしまう
    const history: Message[] = [
      {
        role: "user",
        content: "あ".repeat(MAX_CONTENT_LENGTH + 500),
      },
      ...Array.from({ length: MAX_MESSAGE_COUNT + 1 }, (_, i) => ({
        role: "assistant" as const,
        content: `回答${i}`,
      })),
    ];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 空配列を送るとサーバーが「メッセージを 1 件以上指定してください。」で 400 を
    // 返す ——「必ず 400 になるリクエストを送らない」ためのモジュールが、自ら
    // その状態を作ってしまう。履歴のどこかに user 発言があればそれを送る
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed[0].role).toBe("user");
    // 本文も上限に収まっていることを確認する。収めそこねると、この分岐が防ごうと
    // している「必ず 400 になり、往復が成立しないので窓からも抜けない」状態を
    // 自分で作ってしまう（拾うのは窓の外にある過去の発言なので切り詰めてよい）
    expect(trimmed[0].content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
  });

  it("user 発言が 1 件も無ければ空のまま返す（送れるものが無い）", () => {
    // assistant 発言しか無い履歴では送れるものが無いので、空のまま返す
    const history: Message[] = [{ role: "assistant", content: "回答" }];
    expect(trimHistoryForRequest(history)).toEqual([]);
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

  it("中断済みの回答を切り詰めても、未完了であることを示す印は残る", () => {
    // 画面側が付けた「途切れています」の印を含む、上限を超える回答を用意する
    const interrupted = `${"あ".repeat(MAX_CONTENT_LENGTH)}${TRUNCATED_ANSWER_SUFFIX}`;
    const history: Message[] = [
      { role: "user", content: "質問" },
      { role: "assistant", content: interrupted },
    ];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 上限以内に収まっていることを確認する
    expect(trimmed[1].content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    // 末尾は必ず省略の印で終わる。
    // 「途切れています」の印は本文の末尾にあるため切り詰めで失われるが、
    // 代わりに省略の印が入るので「この回答は完全ではない」という情報は残る
    // （どちらか一方でも残っていればよい、という緩い条件にすると、
    //   印を一切付けない実装に劣化しても緑のまま通ってしまう）
    expect(trimmed[1].content.endsWith(OMITTED_MESSAGE_SUFFIX)).toBe(true);
  });

  it("いま送る質問（末尾の user 発言）は切り詰めない（黙って質問を削らない）", () => {
    // ユーザーが上限を超える長文を貼り付けた場合を模す
    const longQuestion = "あ".repeat(MAX_CONTENT_LENGTH + 500);
    const history: Message[] = [{ role: "user", content: longQuestion }];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // これから尋ねる質問はそのまま送る。ここで黙って削ると、ユーザーは質問が
    // 途中で切れたことに気づけないまま送信してしまう（findContentProblem が
    // 送信前に弾き、すり抜けてもサーバーが理由付きの 400 を返して画面に出る）
    expect(trimmed[0].content).toBe(longQuestion);
  });

  it("過去の user 発言は切り詰める（復帰できない 400 を作らない）", () => {
    // 上限を超える user 発言が履歴に残っている状態を模す
    const history: Message[] = [
      { role: "user", content: "あ".repeat(MAX_CONTENT_LENGTH + 500) },
      { role: "assistant", content: "回答" },
      { role: "user", content: "次の質問" },
    ];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 過去の発言はもう編集できないので、そのまま送るとサーバーが必ず 400 を返し、
    // 往復が成立しないので 50 件の窓からも抜けず、再読み込みまで復帰できない。
    // ロールが違うだけで、このモジュールが塞いだはずの穴がそのまま再発する
    for (const message of trimmed) {
      expect(message.content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    }
    // 省略した事実は本文に残す（印なしで削ると「そこで終わった発言」と区別が付かない）
    expect(trimmed[0].content.endsWith(OMITTED_MESSAGE_SUFFIX)).toBe(true);
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
    // 実際の切り口は「上限 − 省略の印の長さ」なので、そこへ絵文字（サロゲートペア）を
    // 置く。上限そのものを境界だと思って組み立てると切り口が絵文字から外れ、
    // ガードを外しても落ちない空振りのテストになる（実測で確認済み）
    const emoji = "😀";
    const cutIndex = MAX_CONTENT_LENGTH - OMITTED_MESSAGE_SUFFIX.length;
    const content = "あ".repeat(cutIndex - 1) + emoji + "あ".repeat(100);
    // その本文を持つ assistant 発言を含む履歴を用意する
    const history: Message[] = [
      { role: "user", content: "質問" },
      { role: "assistant", content },
    ];
    // 切り詰めを適用する
    const trimmed = trimHistoryForRequest(history);
    // 上限以内に収まっていることを確認する
    expect(trimmed[1].content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    // 省略の印を外して、実際に切った本文の末尾を取り出す。
    // 印を付けたあとの末尾を見ると常に印の最後の文字になり、切り口を検査できない
    const body = trimmed[1].content.slice(
      0,
      trimmed[1].content.length - OMITTED_MESSAGE_SUFFIX.length
    );
    // 切り口に片割れだけのサロゲートが残っていないことを確認する。
    // 残っていると文字として成立しない値を上流へ送ることになる
    const lastCode = body.charCodeAt(body.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });
});

describe("findContentProblem", () => {
  it("空白だけの本文を理由付きで弾く", () => {
    // 空白だけの発言は trimHistoryForRequest に取り除かれるため、そのまま送ると
    // 「窓に user 発言が残らない」予備経路に落ち、1 つ前の質問が送り直される。
    // ユーザーから見ると空の送信に前の質問への回答が返ることになるので、送る前に止める
    expect(findContentProblem("   \n\t ")).toBe(CONTENT_EMPTY_MESSAGE);
  });

  it("上限を超える本文を理由付きで弾く", () => {
    // 上限ちょうど＋1 文字の本文を作る
    const tooLong = "あ".repeat(MAX_CONTENT_LENGTH + 1);
    // 長さの理由が返ることを確認する
    expect(findContentProblem(tooLong)).toBe(CONTENT_TOO_LONG_MESSAGE);
  });

  it("上限ちょうどの本文は通す", () => {
    // 境界（上限ちょうど）は弾かない。弾くとサーバーが受け付ける本文を
    // 画面側だけが拒否する食い違いになる
    expect(findContentProblem("あ".repeat(MAX_CONTENT_LENGTH))).toBeNull();
  });
});

describe("共有する入力上限", () => {
  it("本文の最大文字数は正の整数である", () => {
    // 履歴の切り詰めとサーバーの検証で共有するため、妥当な値であることを確認する
    expect(Number.isInteger(MAX_CONTENT_LENGTH)).toBe(true);
    expect(MAX_CONTENT_LENGTH).toBeGreaterThan(0);
  });

  it("本文の最大文字数は省略の印より長い", () => {
    // 印のほうが長いと、切り詰めの計算（上限 − 印の長さ）が負になり、
    // 切り詰めたつもりがほぼ全文を返して上限を超える。上限は定数なので
    // 実行時ではなくここで固定しておけば、設定ミスは CI で必ず落ちる
    expect(MAX_CONTENT_LENGTH).toBeGreaterThan(OMITTED_MESSAGE_SUFFIX.length);
  });

  it("件数 × 文字数の最大ペイロードが本文サイズ上限に収まる", () => {
    // 上限内の履歴を送ったのに 413 になる設定にしてはいけない。413 になると
    // 弾かれたメッセージが履歴に残り続けて窓からも抜けず、400 について
    // 塞いだのとまったく同じ「復帰できない」状態が再発する。
    //
    // 見積もりは「日本語 1 文字 = UTF-8 で 3 バイト」ではなく、JSON 化したときの
    // 最悪ケースで行う。JSON.stringify は制御文字（U+0000〜U+001F のうち
    // 短縮エスケープを持たないもの）を 6 バイトのエスケープ表記へ展開するため、
    // 3 バイト換算だと「上限内の履歴なのに 413」になる設定を見逃す
    // （上限値を上げたときに黙って現実の問題になる）
    const WORST_CASE_BYTES_PER_UNIT = 6;
    const worstCaseBodyBytes =
      MAX_MESSAGE_COUNT * MAX_CONTENT_LENGTH * WORST_CASE_BYTES_PER_UNIT;
    // JSON の構造（キー・括弧）の分も乗るので、余裕を持って収まることを求める
    expect(worstCaseBodyBytes).toBeLessThan(MAX_BODY_BYTES);
  });

  it("最悪ケースの見積もりが実際の JSON 化の結果を下回らない", () => {
    // 見積もりの係数（1 符号単位あたり 6 バイト）が本当に最悪ケースかを、
    // 実際に JSON 化して確かめる。係数を実測から切り離すと、上の検査は
    // 「決めた数どうしの比較」になり、現実の肥大化を見張らなくなる
    const WORST_CASE_BYTES_PER_UNIT = 6;
    // 最も膨らむ文字（短縮エスケープを持たない制御文字）だけの本文を作る
    const worstContent = "\u0001".repeat(100);
    // 1 メッセージ分を JSON 化してバイト数を測る
    const encodedLength = new TextEncoder().encode(
      JSON.stringify(worstContent)
    ).length;
    // 前後の引用符 2 バイトを除いた本文の展開量が係数以内であることを確認する
    expect(encodedLength - 2).toBeLessThanOrEqual(
      worstContent.length * WORST_CASE_BYTES_PER_UNIT
    );
  });

  it("履歴の最大件数は user/assistant の往復を保てる 2 件以上である", () => {
    // 1 件だと直前の assistant 発言すら送れず文脈が失われるため 2 件以上を要求する
    expect(Number.isInteger(MAX_MESSAGE_COUNT)).toBe(true);
    expect(MAX_MESSAGE_COUNT).toBeGreaterThanOrEqual(2);
  });
});
