/**
 * 送信元ごとのスライディングウィンドウ・レート制限
 *
 * 設計判断: 以前はこのロジックが `src/app/api/chat/route.ts` の中に直接書かれていた。
 * Next.js の Route Handler は HTTP メソッド以外の export を許さないため、
 * 内部の関数や状態をテストから触れず、上限値も差し替えられなかった。その結果
 * 「追跡表が満杯になったときの掃除」のような、実運用でしか起きない経路が
 * 一度も検証されないまま残っていた。単一責務のモジュールとして切り出し、
 * 上限と現在時刻を注入できるようにして境界値を単体テストで確認できるようにする
 * （§10 ロジックと表示層の分離／§11 純粋ロジックはユニットテスト）。
 */

/** レート制限のウィンドウ幅（ミリ秒）。既定は 1 分 */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** 1 ウィンドウ内に許可するリクエスト数の上限 */
export const RATE_LIMIT_MAX_REQUESTS = 20;

/** 追跡する送信元キーの上限数。X-Forwarded-For は送信元が偽装できるため、
 * 毎回異なる値を送って表を際限なく成長させるメモリ枯渇攻撃が成立してしまう。
 * 上限に達したら期限切れエントリを掃除し、それでも満杯なら新規送信元は
 * 共有バケットへまとめて計上して全体流量を頭打ちにする（fail-safe）。 */
export const MAX_TRACKED_CLIENTS = 10_000;

/** 追跡表が満杯のときに未追跡の新規送信元をまとめて数える共有バケットのキー。
 * IP アドレスに現れない文字で構成し、実クライアントのキーと衝突しないようにする。 */
export const OVERFLOW_KEY = "__overflow__";

/** レート制限の上限値（テストから小さい値を注入するために差し替え可能にする） */
export interface RateLimiterOptions {
  /** ウィンドウ幅（ミリ秒）。省略時は {@link RATE_LIMIT_WINDOW_MS} */
  windowMs?: number;
  /** 1 ウィンドウ内に許可するリクエスト数。省略時は {@link RATE_LIMIT_MAX_REQUESTS} */
  maxRequests?: number;
  /** 追跡する送信元キーの上限数。省略時は {@link MAX_TRACKED_CLIENTS} */
  maxTrackedClients?: number;
}

/** レート制限の判定を行うオブジェクト */
export interface RateLimiter {
  /**
   * 1 件のリクエストを数え、上限を超えているかを判定する。
   * @param clientKey - リクエスト元を識別するキー
   * @param now - 判定に使う現在時刻（ミリ秒）。省略時は実時刻
   * @returns true ならレート制限超過（このリクエストは数えない）
   */
  isRateLimited(clientKey: string, now?: number): boolean;
  /** いま追跡している送信元キーの数（掃除が効いているかを観測するために公開する） */
  readonly trackedClientCount: number;
}

/**
 * 送信元ごとのレート制限器を作る。
 *
 * <p>状態（送信元ごとのリクエスト時刻）はこの関数のクロージャに閉じ込め、
 * 呼び出し側からは判定と件数だけが見えるようにする。
 *
 * @param options - 上限値の差し替え（省略時は本番用の既定値）
 * @returns レート制限器
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  // ウィンドウ幅を決める（指定が無ければ既定値）
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  // 1 ウィンドウ内の許可件数を決める（指定が無ければ既定値）
  const maxRequests = options.maxRequests ?? RATE_LIMIT_MAX_REQUESTS;
  // 追跡する送信元キーの上限を決める（指定が無ければ既定値）
  const maxTrackedClients = options.maxTrackedClients ?? MAX_TRACKED_CLIENTS;

  // 送信元キーごとに、ウィンドウ内のリクエスト時刻（昇順）を保持する表
  const buckets = new Map<string, number[]>();
  // 最後に掃除を実行したウィンドウ番号（まだ一度も掃除していないことを表す -1 で初期化）
  let lastSweptWindow = -1;

  /**
   * ウィンドウ外になったエントリを表から取り除く。
   * @param now - 判定に使う現在時刻（ミリ秒）
   */
  function sweepExpired(now: number): void {
    // すべてのエントリを確認して、ウィンドウ外のものだけを削除する
    for (const [key, timestamps] of buckets) {
      // 時刻は昇順に追加されるので、最後の 1 件だけ見ればウィンドウ外か判定できる
      // （全件を走査すると表が大きいときに掃除そのものが重くなる）
      const newest = timestamps[timestamps.length - 1];
      // 記録が無い、または最後のリクエストがウィンドウ外ならこの送信元の記録は不要
      if (newest === undefined || now - newest >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  return {
    isRateLimited(clientKey: string, now: number = Date.now()): boolean {
      // 現在がどのウィンドウに属するかを求める（掃除の頻度を絞るのに使う）
      const currentWindow = Math.floor(now / windowMs);

      // 追跡表が上限に達していたら、期限切れの送信元エントリをまとめて掃除する。
      // ただし掃除は 1 ウィンドウにつき 1 回までに絞る。表が満杯のまま維持される
      // （偽装キーを送り続けられている）状況では、絞らないと全リクエストが
      // 毎回 1 万件の走査を負担することになり、攻撃者が安価にサーバの CPU を
      // 消費させられてしまう（§8 重い処理でリクエスト処理をブロックしない）。
      // 表のエントリは高々 1 ウィンドウで期限切れになるため、ウィンドウごとに
      // 1 回掃除すれば回収漏れは起きない（回収が最大 1 ウィンドウ遅れるだけで、
      // その間の新規送信元は共有バケットで数えられるので素通りにはならない）
      if (buckets.size >= maxTrackedClients && lastSweptWindow !== currentWindow) {
        // このウィンドウでは掃除済みであることを記録する
        lastSweptWindow = currentWindow;
        // 期限切れのエントリを取り除く
        sweepExpired(now);
      }

      // 掃除後も満杯で、かつ未追跡の新規送信元なら共有バケットに振り替える。
      // 素通しにすると偽装キーの使い捨てで制限を無効化できてしまうため、
      // 満杯時の新規送信元はまとめて数えて全体流量を必ず頭打ちにする（fail-safe）
      const effectiveKey =
        buckets.size >= maxTrackedClients && !buckets.has(clientKey)
          ? OVERFLOW_KEY
          : clientKey;

      // この送信元の過去のリクエスト時刻一覧を取得する（なければ空配列）
      const timestamps = buckets.get(effectiveKey) ?? [];

      // ウィンドウ内のリクエストだけを残すようフィルタリングする
      const recentTimestamps = timestamps.filter((t) => now - t < windowMs);

      // リクエスト数が上限に達していたら制限超過と判定する（この回は数えない）
      if (recentTimestamps.length >= maxRequests) {
        return true;
      }

      // 今回のリクエスト時刻を記録する
      recentTimestamps.push(now);

      // 表を更新する
      buckets.set(effectiveKey, recentTimestamps);

      // 制限内なので false を返す
      return false;
    },

    get trackedClientCount(): number {
      // 追跡中の送信元キー数を返す
      return buckets.size;
    },
  };
}
