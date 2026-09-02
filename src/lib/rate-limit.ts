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

// 注: 追跡表が満杯のときに新規送信元をまとめて数える「共有バケット」は、
// 追跡表そのものとは別の変数で持つ。表の中にキーとして混ぜると、
// (1) 表の件数が上限を 1 つ超える（上限の意味がずれる）、
// (2) maxTrackedClients が小さいとき共有バケットだけで表が埋まり、
//     実クライアントが 1 件も自分のバケットを持てなくなる、
// という 2 つの副作用が出る。

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
  /** この制限器が実際に使っているウィンドウ幅（ミリ秒）。
   * 429 応答の Retry-After は必ずここから導く。既定値を直接読むと、
   * 上限を差し替えたときにヘッダだけが古い値のまま残ってしまう */
  readonly windowMs: number;
}

/**
 * 上限値が正の整数であることを確かめ、そうでなければ即座に失敗させる。
 *
 * <p>`??` は null / undefined しか拾わないため、0 や負数はそのまま通ってしまう。
 * とくに `windowMs` が 0 だと「now - t < 0」が決して成立せず記録が常に空になり、
 * **レート制限が丸ごと無効になる**（実測: 0 を渡すと 10 連続で素通りする）。
 * このアプリの DoS・課金対策はこのレート制限しか無いので、設定ミスで静かに
 * 無効化されるより、その場で落ちるほうが安全（§9 fail-closed）。
 *
 * @param value - 検証する上限値
 * @param name - エラーメッセージに出す設定名
 * @returns 検証を通った値
 * @throws {RangeError} 正の整数でない場合
 */
function requirePositiveInteger(value: number, name: string): number {
  // 整数かつ 1 以上でなければ、その場で失敗させる
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `レート制限の ${name} は 1 以上の整数で指定してください。現在値: ${value}`
    );
  }
  // 検証を通った値をそのまま返す
  return value;
}

/**
 * 送信元ごとのレート制限器を作る。
 *
 * <p>状態（送信元ごとのリクエスト時刻）はこの関数のクロージャに閉じ込め、
 * 呼び出し側からは判定と件数だけが見えるようにする。
 *
 * @param options - 上限値の差し替え（省略時は本番用の既定値）
 * @returns レート制限器
 * @throws {RangeError} 上限値が正の整数でない場合
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  // ウィンドウ幅を決める（指定が無ければ既定値）
  const windowMs = requirePositiveInteger(
    options.windowMs ?? RATE_LIMIT_WINDOW_MS,
    "windowMs"
  );
  // 1 ウィンドウ内の許可件数を決める（指定が無ければ既定値）
  const maxRequests = requirePositiveInteger(
    options.maxRequests ?? RATE_LIMIT_MAX_REQUESTS,
    "maxRequests"
  );
  // 追跡する送信元キーの上限を決める（指定が無ければ既定値）
  const maxTrackedClients = requirePositiveInteger(
    options.maxTrackedClients ?? MAX_TRACKED_CLIENTS,
    "maxTrackedClients"
  );

  // 送信元キーごとに、ウィンドウ内のリクエスト時刻を保持する表
  const buckets = new Map<string, number[]>();
  // 表が満杯のときに新規送信元をまとめて数える共有バケット（表とは別に持つ。理由は上の注記）
  let overflowTimestamps: number[] = [];
  // 最後に掃除を実行したウィンドウ番号（まだ一度も掃除していないことを表す -1 で初期化）
  let lastSweptWindow = -1;

  /**
   * ウィンドウ外になったエントリを表から取り除く。
   * @param now - 判定に使う現在時刻（ミリ秒）
   */
  function sweepExpired(now: number): void {
    // すべてのエントリを確認して、ウィンドウ外のものだけを削除する
    for (const [key, timestamps] of buckets) {
      // 記録がすべてウィンドウ外なら、この送信元の記録はもう不要なので削除する。
      //
      // 「昇順に積まれるので最後の 1 件だけ見れば足りる」と考えたくなるが、
      // それは Date.now() が単調増加であることに依存する。NTP のステップ調整や
      // VM のクロック同期で時刻が巻き戻ると並びが崩れ、まだ有効な記録を持つ
      // バケットごと削除してしまう（消された送信元はその場で枠を取り戻すので
      // fail-open）。全件を見る分のコストは、掃除自体を 1 ウィンドウに 1 回へ
      // 絞ったことで問題にならない（1 バケットの記録は maxRequests 件で有界）
      if (timestamps.every((t) => now - t >= windowMs)) {
        buckets.delete(key);
      }
    }
    // 共有バケットも同じ規則で空にする（表の外に持っているので個別に見る）
    if (overflowTimestamps.every((t) => now - t >= windowMs)) {
      overflowTimestamps = [];
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
      // 掃除はウィンドウの境目ごとに走るので、あるエントリが期限切れになってから
      // 回収されるまでの遅れは 1 ウィンドウ未満に収まる（エントリが表に残る時間で
      // 数えると、最後のリクエストから最長 2 ウィンドウ弱）。回収漏れは起きず、
      // 遅れている間の新規送信元も共有バケットで数えるので素通りにはならない
      if (buckets.size >= maxTrackedClients && lastSweptWindow !== currentWindow) {
        // このウィンドウでは掃除済みであることを記録する
        lastSweptWindow = currentWindow;
        // 期限切れのエントリを取り除く
        sweepExpired(now);
      }

      // 掃除後も満杯で、かつ未追跡の新規送信元なら共有バケットに振り替える。
      // 素通しにすると偽装キーの使い捨てで制限を無効化できてしまうため、
      // 満杯時の新規送信元はまとめて数えて全体流量を必ず頭打ちにする（fail-safe）
      const useOverflow =
        buckets.size >= maxTrackedClients && !buckets.has(clientKey);

      // この送信元（または共有バケット）の過去のリクエスト時刻一覧を取得する
      const timestamps = useOverflow ? overflowTimestamps : buckets.get(clientKey) ?? [];

      // ウィンドウ内のリクエストだけを残すようフィルタリングする
      const recentTimestamps = timestamps.filter((t) => now - t < windowMs);

      // リクエスト数が上限に達していたら制限超過と判定する（この回は数えない）
      if (recentTimestamps.length >= maxRequests) {
        return true;
      }

      // 今回のリクエスト時刻を記録する
      recentTimestamps.push(now);

      // 記録を書き戻す（共有バケットは表の外にあるので別の変数へ）
      if (useOverflow) {
        overflowTimestamps = recentTimestamps;
      } else {
        buckets.set(clientKey, recentTimestamps);
      }

      // 制限内なので false を返す
      return false;
    },

    get trackedClientCount(): number {
      // 追跡中の送信元キー数を返す（共有バケットは表の外なので数に含まれない）
      return buckets.size;
    },

    get windowMs(): number {
      // この制限器が実際に使っているウィンドウ幅を返す
      return windowMs;
    },
  };
}
