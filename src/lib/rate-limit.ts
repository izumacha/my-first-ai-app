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

/** 1 ウィンドウあたり何回まで掃除を許すか。
 *
 * <p>大きくすると回収が速くなり、小さくすると走査の回数が減る。表が満杯の間は
 * 新規クライアントが共有バケット（全体で 1 枠）へ回されるため、**回収の遅れは
 * そのまま新規クライアントの 429 に化ける**。10（既定なら 6 秒の遅れ）では、
 * 実クライアントが 1 万件に達している忙しいアプリで、期限切れの枠が空くのを
 * 6 秒待つ間に来た人がまとめて弾かれる。
 *
 * <p>60 なら既定のウィンドウ（1 分）で遅れは 1 秒以内に収まり、走査はどれだけ
 * リクエストが来ても 1 秒あたり 1 回で頭打ちのまま（1 万件 × 20 件の走査は
 * 1 ミリ秒程度なので、毎秒 1 回なら負荷にならない）。「攻撃者が走査を誘発できない」
 * という当初の目的を保ったまま、遅れだけを 6 分の 1 にする。 */
const SWEEP_INTERVALS_PER_WINDOW = 60;

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
  /** いま追跡している送信元キーの数。
   * **テストから内部状態を確かめるためだけに公開している**（本番の呼び出し元は読まない）。
   * 表が上限を超えて膨らまないこと・掃除で回収されることは判定結果（真偽値）に
   * 現れないので、外から観測できないと固定できない。 */
  readonly trackedClientCount: number;
  /** これまでに掃除（表の全走査）を実行した回数。
   * これも**テストから観測するためだけに公開している**。掃除の頻度はリクエスト数から
   * 切り離されている必要がある（偽装キーで全リクエストに全走査を負わせられない）が、
   * その効果は判定結果にはいっさい現れないため、ここを読む以外に確かめる方法が無い。 */
  readonly sweepCount: number;
  /** 429 応答の `Retry-After` に載せる待機秒数。
   * 既定値ではなく**この制限器が実際に使っているウィンドウ幅**から導くので、
   * 上限を差し替えてもヘッダだけが古い値のまま残ることがない。
   * RFC 9110 の delay-seconds は整数なので切り上げた値を返す
   * （小数を送るとクライアントは解釈できず、ヘッダが無いのと同じ扱いになる。
   * 切り下げないのは、早すぎる再試行を勧めないため）。 */
  readonly retryAfterSeconds: number;
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

  // 掃除を行う最短間隔（ミリ秒）。ウィンドウ幅から導く。
  // 走査の頻度をリクエスト数から切り離しつつ、回収の遅れを抑える
  // （何分の 1 にするかと、その理由は SWEEP_INTERVALS_PER_WINDOW を参照）
  const sweepIntervalMs = Math.max(
    1,
    Math.floor(windowMs / SWEEP_INTERVALS_PER_WINDOW)
  );

  // 送信元キーごとに、ウィンドウ内のリクエスト時刻を保持する表
  const buckets = new Map<string, number[]>();
  // 表が満杯のときに新規送信元をまとめて数える共有バケット（表とは別に持つ。理由は上の注記）。
  // 時刻だけでなく「どの送信元の分か」も持つ: 表に空きができた瞬間に、その送信元が
  // 共有バケットで使い切ったはずの枠がリセットされるのを防ぐため（下の注記）。
  // 件数は maxRequests で頭打ちになるので、キーを持っても大きさは有界
  let overflowRecords: { key: string; at: number }[] = [];
  // 最後に掃除を実行した時刻（まだ一度も掃除していないので、必ず 1 回目が走る値で初期化）
  let lastSweptAt = Number.NEGATIVE_INFINITY;
  // これまでに掃除を実行した回数（頻度が絞れているかを外から観測するために数える）
  let sweepCount = 0;

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
      // ウィンドウ内かどうかの規則は keepWithinWindow が唯一の参照元。
      // ここで「now - t >= windowMs」と否定形を書き写すと、判定側と掃除側で
      // 規則が 2 か所に分かれ、片方だけ直したときに「判定はまだ数えている記録を
      // 掃除側が捨てる」＝その送信元が枠を丸ごと取り戻す（fail-open）ずれが起きる
      if (!hasWithinWindow(timestamps, (t) => t, now)) {
        buckets.delete(key);
      }
    }
    // 共有バケットも同じ規則で空にする（表の外に持っているので個別に見る）
    if (!hasWithinWindow(overflowRecords, (record) => record.at, now)) {
      overflowRecords = [];
    }
  }

  /**
   * ウィンドウ内に残る記録だけを取り出す。
   *
   * <p>共有バケット（記録に送信元キーを持つ）と通常のバケット（時刻だけ）で
   * 保持する形が違うため、「ウィンドウ内かどうか」の規則だけをここに集約する。
   * 判定を各分岐へ書き写すと、規則を変えたときに片方だけ直して静かに食い違う。
   *
   * @param entries - 判定対象の記録一覧
   * @param at - 記録から時刻を取り出す関数
   * @param now - 現在時刻（ミリ秒）
   * @returns ウィンドウ内に残る記録だけを含む新しい配列
   */
  function keepWithinWindow<T>(
    entries: readonly T[],
    at: (entry: T) => number,
    now: number
  ): T[] {
    // ウィンドウ内の記録だけを残す（規則は isWithinWindow が唯一の参照元）
    return entries.filter((entry) => isWithinWindow(at(entry), now));
  }

  /**
   * ウィンドウ内の記録が 1 件でも残っているかを判定する。
   *
   * <p>掃除側は「1 件も残っていないか」しか見ないので、{@link keepWithinWindow} で
   * 配列を作ってから長さを見るのは無駄が大きい（表が満杯なら 1 回の掃除で
   * 1 万本の短命な配列を作ることになる）。`some` なら最初の 1 件で打ち切れる。
   * 判定そのものは {@link isWithinWindow} を共有するので、規則は 1 か所のまま。
   *
   * @param entries - 判定対象の記録一覧
   * @param at - 記録から時刻を取り出す関数
   * @param now - 現在時刻（ミリ秒）
   * @returns ウィンドウ内の記録が 1 件でもあれば true
   */
  function hasWithinWindow<T>(
    entries: readonly T[],
    at: (entry: T) => number,
    now: number
  ): boolean {
    // ウィンドウ内の記録が見つかった時点で打ち切る
    return entries.some((entry) => isWithinWindow(at(entry), now));
  }

  /**
   * ある時刻の記録がまだウィンドウ内かを判定する。
   *
   * <p>**ウィンドウの規則はここが唯一の参照元。** 判定側と掃除側へ書き写すと、
   * 規則を変えたときに片方だけ直して「判定はまだ数えている記録を掃除側が捨てる」
   * ＝その送信元が枠を丸ごと取り戻す（fail-open）ずれが起きる。
   *
   * @param at - 記録の時刻（ミリ秒）
   * @param now - 現在時刻（ミリ秒）
   * @returns 経過時間がウィンドウ幅未満なら true
   */
  function isWithinWindow(at: number, now: number): boolean {
    // 経過時間がウィンドウ幅未満ならまだ数える対象
    return now - at < windowMs;
  }

  return {
    isRateLimited(clientKey: string, now: number = Date.now()): boolean {
      // 追跡表が上限に達していたら、期限切れの送信元エントリをまとめて掃除する。
      //
      // ただし掃除は一定間隔に絞る。表が満杯のまま維持される（偽装キーを送り続け
      // られている）状況では、絞らないと全リクエストが毎回 1 万件の走査を負担する
      // ことになり、攻撃者が安価にサーバの CPU を消費させられてしまう
      // （§8 重い処理でリクエスト処理をブロックしない）。
      //
      // 絞り方を「1 ウィンドウに 1 回」ではなく時間間隔にしているのが要点。
      // ウィンドウ単位だと、そのウィンドウの早い時点で（まだ何も期限切れでない
      // タイミングで）掃除を使い切ってしまい、その後エントリが期限切れになっても
      // 次のウィンドウまで回収されない。その間、表は「回収できる枠しかないのに満杯」
      // という状態のままなので、新規の正規クライアントが共有バケットへ押し込まれて
      // 429 を受ける。間隔で絞れば、期限切れからの遅れは常に 1 間隔以内に収まる
      const sweepIsDue =
        // 時刻が巻き戻った場合も「間隔が空いた」とみなして掃除する（止まらないように）
        now < lastSweptAt || now - lastSweptAt >= sweepIntervalMs;
      if (buckets.size >= maxTrackedClients && sweepIsDue) {
        // 掃除した時刻と回数を記録する
        lastSweptAt = now;
        sweepCount += 1;
        // 期限切れのエントリを取り除く
        sweepExpired(now);
      }

      // 掃除後も満杯で、かつ未追跡の新規送信元なら共有バケットに振り替える。
      // 素通しにすると偽装キーの使い捨てで制限を無効化できてしまうため、
      // 満杯時の新規送信元はまとめて数えて全体流量を必ず頭打ちにする（fail-safe）
      const useOverflow =
        buckets.size >= maxTrackedClients && !buckets.has(clientKey);

      // 共有バケットで数える場合。判定は「どの送信元の分か」を問わず全体で行うが、
      // 記録には送信元キーを残す（下の引き継ぎに要る）。時刻だけの配列を扱う
      // 通常経路と形が違うため、この分岐だけ記録の形のまま扱う
      // （ウィンドウの規則そのものは keepWithinWindow に集約して共有する）
      if (useOverflow) {
        // ウィンドウ内の記録だけを残す
        const recentRecords = keepWithinWindow(
          overflowRecords,
          (record) => record.at,
          now
        );
        // 共有の枠を使い切っていれば制限超過と判定する（この回は数えない）
        if (recentRecords.length >= maxRequests) {
          return true;
        }
        // 今回のリクエストを、どの送信元の分かが分かる形で記録する
        recentRecords.push({ key: clientKey, at: now });
        // 共有バケットへ書き戻す
        overflowRecords = recentRecords;
        // 制限内なので false を返す
        return false;
      }

      // この送信元の過去のリクエスト時刻一覧を取得する。
      //
      // 表にまだ無い送信元は、**共有バケットに残っている自分の分を引き取る**
      // （引き取ったら共有バケットからは取り除く。下記）。
      // 空から始めると、表が満杯だった間に共有バケットで使い切ったはずの枠が
      // 空きができた瞬間にリセットされ、同じ送信元が 1 ウィンドウ内に上限の
      // 2 倍まで通れてしまう（送信元キーは偽装できるので、表を満杯にしてから
      // この切り替わりを狙える）。引き取る範囲を自分の分だけに絞るのが要点で、
      // 共有バケット全体を引き取ると、無関係な新規クライアントが他人の消費で
      // 弾かれる（掃除を間隔で絞ったのと同じ「理由なく 429」を作ってしまう）
      let timestamps = buckets.get(clientKey);
      // 表にまだ無い＝共有バケットからの引き取り（昇格）が要るかもしれない
      if (timestamps === undefined) {
        // 共有バケットに残っている自分の分を時刻の配列として取り出す
        timestamps = overflowRecords
          .filter((record) => record.key === clientKey)
          .map((record) => record.at);
        // 引き取った分は共有バケットから取り除く。残したままにすると同じ
        // リクエストを 2 か所で二重に数えることになり、新規クライアントのために
        // 空けておくべき共有の枠を、昇格済みの送信元が食い続けてしまう
        if (timestamps.length > 0) {
          overflowRecords = overflowRecords.filter(
            (record) => record.key !== clientKey
          );
        }
      }

      // ウィンドウ内のリクエストだけを残すようフィルタリングする
      const recentTimestamps = keepWithinWindow(
        timestamps,
        (timestamp) => timestamp,
        now
      );

      // リクエスト数が上限に達していたら制限超過と判定する（この回は数えない）
      const limited = recentTimestamps.length >= maxRequests;

      // 制限内なら今回のリクエスト時刻を記録する
      if (!limited) {
        recentTimestamps.push(now);
      }

      // この送信元のバケットへ書き戻す。**上限に達していた場合も必ず書き戻す**:
      // 共有バケットから引き取った記録は既にそちらから取り除いてあるので、
      // ここで書き戻さないとどこにも残らず、次のリクエストが空から数え直しになって
      // 同じウィンドウ内で枠が丸ごと戻ってしまう（引き取りが防ごうとしている
      // 「上限の 2 倍まで通れる」状態が、弾かれた側の経路で再発する）
      buckets.set(clientKey, recentTimestamps);

      // 判定結果を返す
      return limited;
    },

    get trackedClientCount(): number {
      // 追跡中の送信元キー数を返す（共有バケットは表の外なので数に含まれない）
      return buckets.size;
    },

    get sweepCount(): number {
      // これまでに掃除を実行した回数を返す
      return sweepCount;
    },

    get retryAfterSeconds(): number {
      // ウィンドウ幅を秒へ直し、整数になるよう切り上げて返す
      return Math.ceil(windowMs / 1000);
    },
  };
}
