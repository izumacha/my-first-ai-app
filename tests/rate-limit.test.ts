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

  it("掃除は 1 ウィンドウにつき 1 回だけ実行する", () => {
    // 2 件までしか追跡できず、1 ウィンドウに 1 回だけ許可する制限器を作る
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      maxTrackedClients: 2,
    });
    // t=500 に 2 件の送信元で表を満杯にする（記録は t=1500 に期限切れになる）
    limiter.isRateLimited("a", 500);
    limiter.isRateLimited("b", 500);

    // t=1000 はウィンドウ 1 の最初の呼び出しなので掃除が走る。
    // ただし a・b はまだ期限切れではない（1000 - 500 < 1000）ので残る。
    // a は枠を使い切っているので制限され、記録も更新されない
    expect(limiter.isRateLimited("a", 1000)).toBe(true);
    expect(limiter.trackedClientCount).toBe(2);

    // t=1500 では a・b は期限切れ（1500 - 500 >= 1000）だが、同じウィンドウ 1 では
    // もう掃除しないので回収されない。満杯のままなので新規送信元は共有バケットへ回る。
    // 掃除を毎回走らせる実装だとここで a・b が消えて追跡数は 1 になる
    expect(limiter.isRateLimited("c", 1500)).toBe(false);
    expect(limiter.trackedClientCount).toBe(3);

    // ウィンドウ 2 に入れば掃除が再び走り、期限切れの a・b が回収される
    // （回収の遅れは最大 1 ウィンドウで、取りこぼしにはならない）
    expect(limiter.isRateLimited("d", 2000)).toBe(false);
    expect(limiter.trackedClientCount).toBe(2);
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
