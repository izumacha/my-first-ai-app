/**
 * 撮影スクリプト共通の「Next.js 開発サーバーを起動して待つ／確実に止める」処理。
 *
 * デモ GIF 撮影（scripts/capture-demo.mjs）とスクリーンショット撮影
 * （scripts/capture-screenshots.mjs）はどちらも「モック上流に向けた next dev を
 * 立ち上げ、Playwright で操作し、後始末で確実に殺す」という同じ流れを踏む。
 * 同じ手順を 2 か所に書き写すと、プロセスツリーの止め方やポート判定のような
 * 間違えやすい部分だけ片方が古いまま残るため、ここに一本化する（CLAUDE.md §6 DRY）。
 */

// TCP サーバー（ポートが空いているかの確認用）を読み込む
import net from "node:net";
// 子プロセス起動（next dev / taskkill 実行用）を読み込む
import { spawn, spawnSync } from "node:child_process";
// パス結合ユーティリティを読み込む
import path from "node:path";

// Windows かどうか（プロセスの止め方が POSIX と異なるため、この 1 か所で判定して分岐を閉じ込める）
export const IS_WINDOWS = process.platform === "win32";

// next dev の起動を待つ上限時間（ミリ秒）。2 つの撮影スクリプトで同じ値を使う
export const APP_STARTUP_TIMEOUT_MS = 120_000;
// SIGTERM で終わらない next dev を強制終了するまでの猶予（ミリ秒）
export const APP_SHUTDOWN_GRACE_MS = 10_000;
// 起動ヘルスチェック 1 回あたりの上限時間（ミリ秒）。
// undici の既定タイムアウト（300 秒）は起動待ちの上限より長いため、これを指定しないと
// 「ポートは開いたが応答しない」状態のときに 1 回の fetch が上限時間を超えて居座り、
// ループが期限切れに気づけなくなる（＝ startupTimeoutMs が実質的に効かない）
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
// ヘルスチェックの再試行間隔（ミリ秒）
const HEALTH_CHECK_INTERVAL_MS = 1_000;

/**
 * 指定ミリ秒待つ。
 * @param {number} ms - 待機時間（ミリ秒）
 * @returns {Promise<void>} 指定時間後に解決する Promise
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * stderr へ出力するログ関数を作る（生成物のパスなど結果は stdout と区別する）。
 * @param {string} prefix - 行頭に付ける識別子（例: "capture-demo"）
 * @returns {(msg: string) => void} ログ出力関数
 */
export function createLogger(prefix) {
  // 受け取ったメッセージへ接頭辞と改行を付けて stderr に書き出す関数を返す
  return (msg) => process.stderr.write(`[${prefix}] ${msg}\n`);
}

/**
 * fetch のレスポンス本文を破棄して接続をコネクションプールへ返す。
 * 本文を読まずに放置すると undici がソケットを掴んだままになるため（§8 リソース解放）。
 * @param {Response} res - 破棄する fetch レスポンス
 */
export async function discardBody(res) {
  // 本文が無い応答（204 等）もあるのでオプショナルチェーンで扱い、キャンセル失敗は無視してよい
  await res.body?.cancel().catch(() => {});
}

/**
 * 子プロセスを、それが起動した孫プロセスもろとも終了させる。
 * next dev はビルドワーカーを子に持つため、親だけ殺すと孫がポートを掴んだまま残る。
 * 止め方が OS で異なるので、プラットフォーム差はここだけに閉じ込める（CLAUDE.md §10）。
 * @param {import("node:child_process").ChildProcess} child - 終了させる子プロセス
 * @param {NodeJS.Signals} signal - POSIX で送るシグナル（Windows では無視される）
 */
export function killProcessTree(child, signal) {
  // Windows にはプロセスグループへのシグナル送出が無いため、taskkill でツリーごと終了させる
  if (IS_WINDOWS) {
    // /T は子孫まで、/F は強制終了を意味する
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // POSIX では負の PID でプロセスグループ全体へシグナルを送る
  process.kill(-child.pid, signal);
}

/**
 * 指定のホスト・ポートに bind できるかを試す。
 * @param {number} port - 調べる待受ポート
 * @param {string} host - 調べる待受アドレス
 * @returns {Promise<boolean>} 既に使われていれば true
 */
function probePort(port, host) {
  return new Promise((resolve) => {
    // 実際に bind を試すための使い捨てサーバーを作る
    const probe = net.createServer();
    probe.once("error", (err) => {
      // 使用中・権限不足は「使えない」ので使用中として扱う（安全側）。
      // IPv6 が無効な環境では ::1 が EAFNOSUPPORT / EADDRNOTAVAIL になるが、
      // これは「誰も使っていない」ので false を返す（誤検知で起動を止めない）
      resolve(err.code === "EADDRINUSE" || err.code === "EACCES");
    });
    // bind できたら空きなので、すぐ閉じて false を返す
    probe.once("listening", () => probe.close(() => resolve(false)));
    // 対象のアドレスへ bind を試す
    probe.listen(port, host);
  });
}

/**
 * 指定ポートが誰かに使われているかを調べる。
 * HTTP で叩いて判定すると、応答しない／HTTP ではない居座りプロセスを「空き」と誤判定し、
 * 起動待ちの上限時間まで無駄に待ったうえで的外れなエラーになる。実際に bind できるかで判定する。
 * @param {number} port - 調べる待受ポート
 * @returns {Promise<boolean>} 使用中なら true（bind できない場合も安全側に倒して true）
 */
export async function isPortInUse(port) {
  // IPv4 ループバックを調べる
  if (await probePort(port, "127.0.0.1")) return true;
  // IPv6 ループバックも調べる。アプリの URL は localhost なので、環境によっては ::1 側へ
  // 解決される。IPv4 だけ見ていると、::1 だけを掴んでいる別サーバーを「空き」と誤判定し、
  // 起動した自分のサーバーではなくそちらを撮影してしまう
  return await probePort(port, "::1");
}

/**
 * Next.js 開発サーバーを指定の環境変数付きで起動し、応答可能になるまで待つ。
 * @param {object} options - 起動オプション
 * @param {string} options.repoRoot - リポジトリのルートディレクトリ（next の実行場所）
 * @param {number} options.port - 待受ポート
 * @param {Record<string, string>} options.env - 追加で渡す環境変数（API キーや上流 URL）
 * @param {number} options.startupTimeoutMs - 起動を待つ上限時間（ミリ秒）
 * @param {(child: import("node:child_process").ChildProcess) => void} options.onSpawn -
 *   spawn 直後に呼ばれるコールバック。起動待ちの間に中断されても kill できるよう、
 *   呼び出し側はここで子プロセスを控える（戻り値の代入を待つと最大で起動待ち時間ぶん、
 *   シグナルハンドラが子プロセスを知らない空白ができ、孤児化してポートを掴み続ける）
 * @returns {Promise<import("node:child_process").ChildProcess>} 起動したプロセス
 */
export async function startAppServer({ repoRoot, port, env, startupTimeoutMs, onSpawn }) {
  // アプリの URL（Next.js dev サーバーは 127.0.0.1 だと cross-origin 扱いで
  // dev リソースをブロックするため、サーバー自身のオリジンと一致する localhost を使う）
  const appUrl = `http://localhost:${port}`;
  // ポートが既に使われている場合は起動前に中断する。
  // 「200 が返るか」だけのヘルスチェックだと、別プロセスのサーバー（実 API キー向きの
  // 可能性がある）を自分のサーバーと誤認して撮影してしまうため、fail-closed にする。
  if (await isPortInUse(port)) {
    throw new Error(
      `ポート ${port} が既に使用されています。既存の next dev 等を停止してから再実行してください。`,
    );
  }
  // next 本体を node で直接起動する。npx 経由だとラッパープロセスに SIGTERM を送っても
  // 実サーバーが孤児化して生き残るため、detached でプロセスグループを作り、
  // 終了時はグループごとシグナルを送れるようにする。
  const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
    // POSIX では自分のプロセスグループを作らせる（後始末でグループごと kill するため）。
    // Windows には同等の概念が無く、detached はコンソール分離の意味になってしまうので付けない
    detached: !IS_WINDOWS,
  });
  // spawn の失敗は例外ではなく 'error' イベントで通知される。listener が無いと
  // 未捕捉例外になり、後始末（finally）を飛ばして一時ファイルとサーバーが残る
  let spawnError = null;
  child.once("error", (err) => {
    spawnError = err;
  });
  // 起動待ちの間に Ctrl-C されても確実に kill できるよう、spawn 直後に呼び出し側へ渡す
  onSpawn(child);
  // 子プロセスが先に死んだらポーリングを打ち切るためのフラグ
  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  // ヘルスチェックで最後に観測したエラー（タイムアウト時の原因説明に使う）
  let lastHealthCheckError = null;
  // サーバーが応答するまで既定の上限時間までポーリングする
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    // spawn 自体に失敗した場合（実行ファイルが無い・プロセス数上限など）は原因を添えて失敗させる
    if (spawnError) {
      throw new Error(`next dev を起動できませんでした: ${spawnError.message}`, { cause: spawnError });
    }
    // 子プロセスが即死した場合は上限まで待たずに原因つきで失敗させる
    if (exited) {
      throw new Error(`next dev が起動前に終了しました (exit code: ${exitCode})。上のログを確認してください。`);
    }
    try {
      // トップページの応答が返れば起動完了とみなす。1 回あたりの上限を、
      // 残り時間と規定値の短い方で切る（残り時間を超えて 1 回の試行が居座らないようにする）
      const remainingMs = deadline - Date.now();
      const res = await fetch(appUrl, {
        signal: AbortSignal.timeout(Math.min(HEALTH_CHECK_TIMEOUT_MS, Math.max(remainingMs, 1))),
      });
      // 応答本文を破棄してソケットを解放する（読み捨てないと接続が滞留する）
      await discardBody(res);
      if (res.ok) return child;
    } catch (err) {
      // 起動途中の接続拒否は想定内だが、名前解決やプロキシ設定の誤りなど
      // 再試行しても直らない失敗もここに来る。原因を捨てるとタイムアウト時に
      // 「アプリが起動しなかった」としか分からなくなるので、最後のエラーを控えておく
      lastHealthCheckError = err;
    }
    // 少し待って再試行する
    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }
  // 起動しなかった場合は失敗させる（fail-closed）。最後に観測したエラーを添えて原因を追えるようにする
  await stopAppServer(child);
  const reason = lastHealthCheckError ? `（最後のエラー: ${lastHealthCheckError.message}）` : "";
  throw new Error(`アプリが ${appUrl} で起動しませんでした${reason}`, {
    cause: lastHealthCheckError ?? undefined,
  });
}

/**
 * アプリのプロセスグループ全体を終了させ、実際に終わるまで待つ。
 * 待たずに次の後始末へ進むと、next dev が掴んだままの接続でモック上流の close() が
 * 完了せず、スクリプトが終了できなくなる。
 * @param {import("node:child_process").ChildProcess} child - startAppServer が返したプロセス
 * @param {number} [graceMs=10000] - SIGTERM で終わらない場合に強制終了するまでの猶予（ミリ秒）
 */
export async function stopAppServer(child, graceMs = APP_SHUTDOWN_GRACE_MS) {
  // spawn 自体に失敗していると PID が無い。プロセスグループも存在しないので何もできない
  // （Windows の taskkill は失敗しても例外を投げないため、下の catch では取りこぼしてハングする）
  if (!child.pid) return;
  // 親が既に終了しているか（この場合 'exit' はもう来ないので待ってはいけない）。
  // ただし「親が死んだ」＝「掃除済み」ではない点が重要で、このモジュールの前提どおり
  // next dev はビルドワーカーを子に持つため、親が先に落ちた（OOM kill・クラッシュ）ときこそ
  // 孫がポートを掴んだまま残りやすい。親の生死にかかわらずグループへのシグナルは必ず送る
  const parentAlreadyExited = child.exitCode !== null || child.signalCode !== null;
  // 終了イベントを待つ Promise を、シグナル送出より先に用意する（取りこぼし防止）。
  // 親が終了済みならそもそも待たないので用意しない
  const exited = parentAlreadyExited
    ? null
    : new Promise((resolve) => child.once("exit", resolve));
  try {
    // プロセスツリー全体を終了させる（OS 差は killProcessTree 内に閉じ込めてある）
    killProcessTree(child, "SIGTERM");
  } catch {
    // グループに誰も残っていなければ ESRCH で失敗する。掃除の目的は果たされているので何もしない
    // （後始末なので失敗を無視してよい唯一の箇所）
    return;
  }
  // 親が終了済みの場合、待てる 'exit' が無いのでここで終わる。
  // 生き残ったワーカーには上で SIGTERM が届いており、次の実行前にはポートが解放される
  if (!exited) return;
  // SIGTERM を無視して居座る場合に備え、猶予後に強制終了する保険をかける
  const killTimer = setTimeout(() => {
    try {
      killProcessTree(child, "SIGKILL");
    } catch {
      // 強制終了の時点で既に消えていれば何もしなくてよい
    }
  }, graceMs);
  // 実際に終了するまで待つ
  await exited;
  // 保険のタイマーを解除する（残すとイベントループが終わらない）
  clearTimeout(killTimer);
}
