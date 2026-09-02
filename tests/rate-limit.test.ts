/**
 * 送信元ごとのレート制限（src/lib/rate-limit.ts）のユニットテスト
 *
 * 追跡表が満杯になったときの挙動は本番でしか起きないため、上限値と現在時刻を
 * 注入して小さな表で再現する。実時刻に依存しないので結果は決定的になる。
 */
import { describe, it, expect } from "vitest";
import {
  createRateLimiter,
  MAX_TRACKED_CLIENTS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "@/lib/rate-limit";

describe("createRateLimiter の基本動作", () => {
  it("ウィンドウ内の上限までは通し、超えた分だけ制限する", () => {
    // 1 秒あたり 2 回まで許可する制限器を作る
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
    // 上限までのリクエストは通る
    expect(limiter.isRateLimited("a", 0)).toBe(false);
    expect(limiter.isRateLimited("a", 10)).toBe(false);
    // 上限を超えた 3 回目は制限される
    expect(limiter.isRateLimited("a", 20)).toBe(true);
  });

  it("送信元ごとに独立して数える", () => {
    // 1 秒あたり 1 回まで許可する制限器を作る
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    // 送信元 a は 1 回目が通り 2 回目で制限される
    expect(limiter.isRateLimited("a", 0)).toBe(false);
    expect(limiter.isRateLimited("a", 10)).toBe(true);
    // 別の送信元 b は a の消費に影響されない
    expect(limiter.isRateLimited("b", 10)).toBe(false);
  });

  it("ウィンドウを過ぎた記録は数えないので、また通るようになる", () => {
    // 1 秒あたり 1 回まで許可する制限器を作る
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    // 1 回目は通る
    expect(limiter.isRateLimited("a", 0)).toBe(false);
    // ウィンドウ内の 2 回目は制限される
    expect(limiter.isRateLimited("a", 999)).toBe(true);
    // ウィンドウを過ぎれば再び通る
    expect(limiter.isRateLimited("a", 1000)).toBe(false);
  });

  it("制限された回はカウントに加えない（ブロック中の連打で枠が延びない）", () => {
    // 1 秒あたり 1 回まで許可する制限器を作る
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    // t=0 の 1 回で枠を使い切る
    expect(limiter.isRateLimited("a", 0)).toBe(false);
    // ブロックされる間に何度叩いても記録は増えない
    expect(limiter.isRateLimited("a", 500)).toBe(true);
    expect(limiter.isRateLimited("a", 900)).toBe(true);
    // 最初の 1 回（t=0）から windowMs 経てば通る。
    // ブロック中の呼び出しが記録されていたら、ここはまだ制限されているはず
    expect(limiter.isRateLimited("a", 1000)).toBe(false);
  });
});

describe("追跡表が満杯のときの挙動", () => {
  it("満杯なら新規送信元は共有バケットへまとめられ、素通りしない", () => {
    // 2 件までしか追跡できず、1 ウィンドウに 1 回だけ許可する制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      maxTrackedClients: 2,
    });
    // 2 件の送信元で表を満杯にする
    expect(limiter.isRateLimited("a", 0)).toBe(false);
    expect(limiter.isRateLimited("b", 0)).toBe(false);
    // 満杯後の新規送信元は共有バケットで数えられる（1 件目は通る）
    expect(limiter.isRateLimited("new-1", 10)).toBe(false);
    // 別の新規送信元でも同じ共有バケットを消費するため、偽装キーの使い捨てで
    // 制限を無効化できない（キーごとに枠が湧くなら、ここは false になってしまう）
    expect(limiter.isRateLimited("new-2", 20)).toBe(true);
  });

  it("ウィンドウが変われば期限切れのエントリを掃除して追跡枠を取り戻す", () => {
    // 2 件までしか追跡できない制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 5,
      maxTrackedClients: 2,
    });
    // 2 件の送信元で表を満杯にする
    limiter.isRateLimited("a", 0);
    limiter.isRateLimited("b", 0);
    // 追跡数が上限に達していることを確認する
    expect(limiter.trackedClientCount).toBe(2);
    // 次のウィンドウでは a・b がどちらも期限切れなので掃除され、
    // 新規送信元 c が共有バケットではなく自分のバケットを持てる
    expect(limiter.isRateLimited("c", 1000)).toBe(false);
    expect(limiter.trackedClientCount).toBe(1);
  });

  it("古い記録が混じっていても、最後のリクエストがウィンドウ内なら掃除しない", () => {
    // 1 ウィンドウに 2 回まで許可し、2 件までしか追跡できない制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 2,
      maxTrackedClients: 2,
    });
    // 送信元 a に「古い記録（t=0）」と「新しい記録（t=900）」の 2 件を作る
    limiter.isRateLimited("a", 0);
    limiter.isRateLimited("a", 900);
    // 別の送信元で表を満杯にする（次の呼び出しで掃除が走る条件を作る）
    limiter.isRateLimited("b", 900);

    // t=1500 の掃除で a を消してはいけない。記録の先頭（t=0）だけを見て
    // 判定する実装だと a ごと消えてしまい、直近の記録（t=900）も失われる
    expect(limiter.isRateLimited("a", 1500)).toBe(false);
    // a には t=900 と t=1500 の 2 件が残っているので、次の呼び出しは制限される。
    // 掃除で記録が失われていると、ここが false になってしまう
    expect(limiter.isRateLimited("a", 1600)).toBe(true);
  });

  it("時刻が巻き戻っても、有効な記録を持つバケットを消さない", () => {
    // 1 ウィンドウに 1 回だけ許可し、1 件までしか追跡できない制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 2,
      maxTrackedClients: 1,
    });
    // 送信元 a に、時刻が巻き戻ったことで昇順でなくなる 2 件の記録を作る。
    // NTP のステップ調整や VM のクロック同期で Date.now() は巻き戻りうる
    limiter.isRateLimited("a", 5000);
    limiter.isRateLimited("a", 100);

    // ここで掃除が走る。末尾の 1 件（100）だけを見る実装だと「ウィンドウ外」と
    // 誤判定し、まだ有効な記録（5000）ごとバケットを削除してしまう
    expect(limiter.isRateLimited("a", 5500)).toBe(false);

    // 記録が保たれていれば、ウィンドウ内は 5000 と 5500 の 2 件になり上限に達する。
    // 掃除でバケットが消えていると枠が戻ってしまい、ここが false になる（fail-open）
    expect(limiter.isRateLimited("a", 5600)).toBe(true);
  });

  it("掃除の回数はリクエスト数ではなく経過時間で決まる", () => {
    // 掃除の最短間隔はウィンドウの 1/60。60000ms のウィンドウなら 1000ms になる
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 100,
      maxTrackedClients: 2,
    });
    // 2 件の送信元で表を満杯にする
    limiter.isRateLimited("a", 5_000);
    limiter.isRateLimited("b", 5_000);
    // 満杯になってから最初の呼び出しで 1 回目の掃除が走る
    limiter.isRateLimited("a", 5_100);
    expect(limiter.sweepCount).toBe(1);

    // 同じ間隔（1000ms）の中で何度呼んでも掃除は増えない。
    // 毎リクエスト走査する実装だと、偽装キーで表を満杯にされた状態で
    // 全リクエストが 1 万件の走査を負担することになる
    for (let t = 5_200; t < 6_100; t += 100) {
      limiter.isRateLimited("a", t);
    }
    expect(limiter.sweepCount).toBe(1);

    // 間隔を越えれば次の掃除が走る
    limiter.isRateLimited("a", 6_101);
    expect(limiter.sweepCount).toBe(2);
  });

  it("期限切れになれば 1 間隔以内に回収する（次のウィンドウまで待たない）", () => {
    // 掃除の最短間隔はウィンドウの 1/60（windowMs=1000 なら 16ms）
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      maxTrackedClients: 2,
    });
    // ウィンドウの途中（t=1001）で表を満杯にする。記録は t=2001 に期限切れになる
    limiter.isRateLimited("a", 1001);
    limiter.isRateLimited("b", 1001);

    // t=2000 に掃除が走るが、まだ期限切れではない（2000 - 1001 = 999 < 1000）ので
    // 何も回収されない。新規送信元 c は共有バケットへ回る
    expect(limiter.isRateLimited("c", 2000)).toBe(false);
    expect(limiter.trackedClientCount).toBe(2);

    // t=2500 では a・b は期限切れ（2500 - 1001 = 1499 >= 1000）。
    // 間隔で絞る実装なら前回の掃除から 500ms 経っているので回収され、
    // 新規送信元 d は自分のバケットを持てる。
    //
    // 「1 ウィンドウに 1 回」で絞る実装だと、t=2000 と t=2500 は同じウィンドウなので
    // 掃除は走らない。回収できる枠しかないのに表は満杯のままで、d は共有バケットへ
    // 押し込まれて弾かれる（正規の新規クライアントが理由なく 429 を受ける）
    expect(limiter.isRateLimited("d", 2500)).toBe(false);
    expect(limiter.trackedClientCount).toBe(1);
  });

  it("共有バケットで数えた分は、表に空きができても引き継ぐ", () => {
    // 1 ウィンドウ 2 回まで、追跡できるのは 2 送信元までの制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 2,
      maxTrackedClients: 2,
    });
    // t=0 に 2 送信元で表を満杯にする（この記録は t=1000 に期限切れになる）
    limiter.isRateLimited("a", 0);
    limiter.isRateLimited("b", 0);

    // 表が満杯の間、未追跡の k は共有バケットで数えられて 2 回通る
    expect(limiter.isRateLimited("k", 900)).toBe(false);
    expect(limiter.isRateLimited("k", 905)).toBe(false);
    // 3 回目は共有の枠を使い切っているので弾かれる
    expect(limiter.isRateLimited("k", 910)).toBe(true);

    // t=1005 では a・b が期限切れになって回収され、表に空きができる。
    // ここで k が空のバケットから始まると、900・905 の 2 回がリセットされ、
    // 同じウィンドウ内（1005 - 900 = 105ms）で上限の 2 倍まで通れてしまう
    expect(limiter.isRateLimited("k", 1005)).toBe(true);
  });

  it("引き取った分は共有バケットから取り除く（二重に数えない）", () => {
    // 1 ウィンドウ 3 回まで、追跡できるのは 2 送信元までの制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 3,
      maxTrackedClients: 2,
    });
    // t=0 に 2 送信元で表を満杯にする（この記録は t=1000 に期限切れになる）
    limiter.isRateLimited("a", 0);
    limiter.isRateLimited("b", 0);
    // 満杯の間に x が共有の枠を 2 つ使う
    limiter.isRateLimited("x", 10);
    limiter.isRateLimited("x", 20);

    // t=1001 で a・b が回収され、x は自分のバケットへ昇格する
    expect(limiter.isRateLimited("x", 1001)).toBe(false);
    // もう 1 送信元で表をふたたび満杯にする（x と c で 2 件）
    limiter.isRateLimited("c", 1002);

    // ここから先の新規送信元は共有バケットで数えられる。x の分を共有バケットに
    // 残したままだと、x のリクエストが「昇格先のバケット」と「共有バケット」の
    // 2 か所で数えられ、新規クライアントのために空けておくべき枠を食い潰す
    // （3 枠あるはずが 1 枠しか使えない）
    expect(limiter.isRateLimited("y", 1005)).toBe(false);
    expect(limiter.isRateLimited("z", 1006)).toBe(false);
    expect(limiter.isRateLimited("w", 1007)).toBe(false);
  });

  it("共有バケットの引き継ぎは送信元ごとに絞る（他人の消費で弾かない）", () => {
    // 上と同じ設定の制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 2,
      maxTrackedClients: 2,
    });
    // t=0 に 2 送信元で表を満杯にする
    limiter.isRateLimited("a", 0);
    limiter.isRateLimited("b", 0);
    // 満杯の間に k が共有バケットの枠を使い切る
    limiter.isRateLimited("k", 900);
    limiter.isRateLimited("k", 905);

    // 表に空きができたあと、共有バケットを一切使っていない新規の m は
    // 自分のバケットを空から始められる。共有バケット全体を引き継ぐ実装だと、
    // 他人（k）の消費で理由なく弾かれてしまう
    expect(limiter.isRateLimited("m", 1005)).toBe(false);
  });

  it("共有バケットは追跡表の外に持つ（上限を超えて表が膨らまない）", () => {
    // 1 件までしか追跡できない制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 5,
      maxTrackedClients: 1,
    });
    // 1 件の送信元で表を満杯にする
    limiter.isRateLimited("a", 0);
    // 満杯後の新規送信元は共有バケットで数えられる
    limiter.isRateLimited("b", 10);
    limiter.isRateLimited("c", 20);
    // 共有バケットを表の中のキーとして持つと、表の件数が上限を超えてしまう。
    // 上限が小さいときは共有バケットだけで表が埋まり、実クライアントが
    // 1 件も自分のバケットを持てなくなる
    expect(limiter.trackedClientCount).toBe(1);
  });
});

describe("上限値の検証（fail-closed）", () => {
  it.each([
    ["windowMs", { windowMs: 0 }],
    ["windowMs（負数）", { windowMs: -1 }],
    ["windowMs（整数でない）", { windowMs: 1.5 }],
    ["maxRequests", { maxRequests: 0 }],
    ["maxTrackedClients", { maxTrackedClients: 0 }],
    ["NaN", { windowMs: Number.NaN }],
  ])("%s が正の整数でなければ生成時に失敗する", (_name, options) => {
    // 不正な上限値では制限器を作れないことを確認する。
    // とくに windowMs が 0 だと「now - t < 0」が成立せず記録が常に空になり、
    // レート制限が丸ごと無効になる（このアプリの DoS・課金対策はこれしか無い）
    expect(() => createRateLimiter(options)).toThrow(RangeError);
  });

  it("正しい上限値なら生成できる", () => {
    // 妥当な値では例外にならないことを確認する（検証が厳しすぎないことの確認）
    expect(() =>
      createRateLimiter({ windowMs: 1000, maxRequests: 1, maxTrackedClients: 1 })
    ).not.toThrow();
    // 既定値（引数なし）でも生成できることを確認する
    expect(() => createRateLimiter()).not.toThrow();
  });
});

describe("Retry-After の待機秒数", () => {
  it("ウィンドウ幅を秒へ直した値を返す", () => {
    // 1 分のウィンドウなら 60 秒
    expect(createRateLimiter({ windowMs: 60_000 }).retryAfterSeconds).toBe(60);
  });

  it("端数が出る設定でも整数を返す（切り上げ）", () => {
    // RFC 9110 の delay-seconds は整数。1.5 のような小数を送るとクライアントは
    // 解釈できず、ヘッダが無いのと同じ扱いになって閉じたままの窓へ叩き続ける
    expect(createRateLimiter({ windowMs: 1500 }).retryAfterSeconds).toBe(2);
    // 1 秒未満のウィンドウでも 0 ではなく 1 を返す（0 は「すぐ再試行してよい」の意味になる）
    expect(createRateLimiter({ windowMs: 200 }).retryAfterSeconds).toBe(1);
  });
});

describe("本番で使う既定値", () => {
  it("CLAUDE.md が定める『1 分あたり 20 リクエスト』と一致する", () => {
    // ウィンドウは 1 分であることを確認する
    expect(RATE_LIMIT_WINDOW_MS).toBe(60 * 1000);
    // 1 ウィンドウあたりの上限は 20 回であることを確認する
    expect(RATE_LIMIT_MAX_REQUESTS).toBe(20);
  });

  it("追跡表の上限は正の整数である", () => {
    // メモリ枯渇を防ぐ上限として妥当な値であることを確認する
    expect(Number.isInteger(MAX_TRACKED_CLIENTS)).toBe(true);
    expect(MAX_TRACKED_CLIENTS).toBeGreaterThan(0);
  });
});
