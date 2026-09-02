/**
 * チャット API エンドポイント
 * POST /api/chat でユーザーのメッセージを受け取り、
 * Claude API にストリーミングで問い合わせて結果を返す。
 */
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  getAnthropicClient,
  MissingApiKeyError,
  MODEL_NAME,
  DEFAULT_MAX_TOKENS,
} from "@/lib/anthropic";
import { getSystemPrompt, getMaxTokens, isCategoryId } from "@/lib/prompts";
import { formatSseFrame, SSE_DONE_MARKER } from "@/lib/sse";
// 入力上限はクライアントと共有する（唯一の参照元は @/lib/chat-limits）
import {
  CONTENT_EMPTY_MESSAGE,
  CONTENT_TOO_LONG_MESSAGE,
  MAX_BODY_BYTES,
  MAX_CONTENT_LENGTH,
  MAX_MESSAGE_COUNT,
  TOO_MANY_MESSAGES_MESSAGE,
} from "@/lib/chat-limits";
// レート制限の判定ロジックと上限値（唯一の参照元は @/lib/rate-limit）
import { createRateLimiter } from "@/lib/rate-limit";
import type { ChatErrorResponse, Message, Role } from "@/lib/types";

/** 送信元ごとのレート制限器（判定ロジックと状態は @/lib/rate-limit に集約）。
 * モジュールスコープで 1 つだけ作り、同じインスタンス上のリクエスト間で状態を共有する。 */
const rateLimiter = createRateLimiter();

/** レート制限キーとして受け付ける最大文字数（IPv6 でも 45 文字以内。
 * 偽装ヘッダ由来の巨大文字列をそのままキーに使ってメモリを消費しないための上限）。 */
const MAX_CLIENT_KEY_LENGTH = 64;

/** 429 応答の Retry-After ヘッダに載せる待機秒数。
 * クライアントが正しくバックオフできるよう、いつ再試行してよいかを明示する。
 * 既定値ではなく**実際に使っている制限器のウィンドウ幅**から導く。既定値を読むと、
 * 上限を差し替えたときにヘッダだけが古い値のまま残り、クライアントが誤った時間だけ
 * 待つ（または閉じたままの窓へ再試行して 429 を重ねる）ずれが起きる。
 * 秒への換算（RFC 9110 の delay-seconds は整数）は制限器側が担う。 */
const RETRY_AFTER_SECONDS = String(rateLimiter.retryAfterSeconds);

/** 「回答を最後まで話し終えた」ことを表す終了理由。これ以外はすべて途中終了として扱う。
 * 列挙するのを「完了の理由」側にしているのが要点で、打ち切りの理由（max_tokens /
 * model_context_window_exceeded / refusal 等）を列挙する向きにすると、
 * 上流に新しい打ち切り理由が増えたときに黙って「完全な回答」に化ける。
 * 型を `string[]` ではなく SDK の `StopReason` にしているのは、綴り違い
 * （"end-turn" 等）を型チェックで落とすため。素の文字列だとどの理由とも
 * 一致しなくなり、**すべての回答が「途切れています」の印付きで確定する**。 */
const COMPLETE_STOP_REASONS: readonly Anthropic.StopReason[] = [
  "end_turn",
  "stop_sequence",
];

/** メッセージのロールとして受け付ける値の一覧（未知のロールを Claude へ転送しない） */
const ALLOWED_ROLES: readonly Role[] = ["user", "assistant"];

/** リクエストボディとして受け付ける MIME タイプ（パラメータ部を除いた本体）。
 * これを必須にすると、HTML フォームや simple request では送れない Content-Type に
 * なるためブラウザが CORS preflight を挟み、第三者サイトからの POST が同一オリジン
 * ポリシーで遮断される。認証は無いが上流 Claude API は従量課金なので、他サイトに
 * 課金リクエストを誘発させない多層防御になる（§9 状態変更リクエストを保護する）。 */
const REQUIRED_CONTENT_TYPE = "application/json";

/** 上流 Claude API 呼び出しのタイムアウト（ミリ秒）。
 * SDK 既定は 10 分と長く、応答しない上流に接続とメモリを占有され続けてしまう。
 * 最長カテゴリの max_tokens（2048）を生成しきる時間には十分な余裕を持たせつつ、
 * 公開エンドポイントとして必ず頭打ちにする（§9 タイムアウトを設ける）。 */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** クライアントへ返すエラー文言の一元管理（§6 定数・ラベルは一元管理／DRY）。
 * 同じ文言を複数箇所に直書きすると片方だけ直して食い違うため、ここを唯一の参照元にする。
 * いずれも内部情報（スタックトレース・上流の英語メッセージ）を含まない安全な文言（§9）。 */
const ERROR_MESSAGES = {
  /** レート制限（自前・上流いずれも）に当たったときの文言 */
  rateLimited: "リクエスト数が上限を超えました。しばらくお待ちください。",
  /** Content-Type が JSON でないときの文言 */
  unsupportedMediaType: "Content-Type は application/json を指定してください。",
  /** ボディサイズが上限を超えたときの文言 */
  bodyTooLarge: "リクエストが大きすぎます。",
  /** ボディが JSON として壊れているときの文言 */
  invalidJson: "リクエストボディが正しい JSON ではありません。",
  /** 上流が 400 を返した（リクエスト内容起因）ときの文言 */
  invalidRequest: "リクエストの内容が不正です。入力を確認してください。",
  /** API キーが無効、または未設定（サーバ側の設定漏れ）のときの文言。
   * どちらも「サーバ側の資格情報が使えない」という同じ状況なので、クライアントへは
   * 区別せず同じ安全な文言を返す。どちらだったかは環境変数名を含まない形でサーバログにだけ残す
   * （§9 機密情報・内部詳細をエラー応答に漏らさない）。 */
  invalidApiKey: "API キーが無効です。設定を確認してください。",
  /** 想定外のエラーで返す汎用文言 */
  internal: "サーバーエラーが発生しました。",
  /** messages フィールドそのものが無い・配列でないときの文言 */
  messagesRequired: "messages フィールドが必要です。",
  /** メッセージが 1 件も入っていないときの文言 */
  messagesEmpty: "メッセージを 1 件以上指定してください。",
  /** 配列の要素がメッセージの形をしていないときの文言 */
  messageShapeInvalid: "メッセージの形式が正しくありません。",
  /** ロールが許可リストに無いときの文言 */
  messageRoleInvalid: "メッセージのロールが正しくありません。",
  /** 本文が文字列でない・空のときの文言（画面側の送信前検証と共有する。
   * 書き写すと、片方だけ直したときに同じ拒否理由が 2 つの文言で現れる） */
  messageContentEmpty: CONTENT_EMPTY_MESSAGE,
  /** 会話履歴が user 発言で始まっていないときの文言 */
  messagesMustStartWithUser: "会話履歴は user の発言から始めてください。",
  /** 会話履歴が user 発言で終わっていないときの文言 */
  messagesMustEndWithUser: "会話履歴は user の発言で終えてください。",
} as const;

/** SSE のチャンクを組み立てる際に使い回すエンコーダ。
 * イベントごとに new TextEncoder() すると生成コストが無駄に積み上がるため 1 つを共有する
 * （TextEncoder は状態を持たず、使い回しても安全）。 */
const sseEncoder = new TextEncoder();

/** リクエストボディのバイト列を文字列へ戻すときに使い回すデコーダ。
 * リクエストごとに new TextDecoder() する必要は無い（1 回の decode で完結する
 * 使い方では状態を持たない）ので、上の sseEncoder と同じ理由で 1 つを共有する。 */
const bodyDecoder = new TextDecoder();

/**
 * エラー応答（JSON）を組み立てる共通ヘルパー。
 * ステータスと文言の組み合わせが各所に散らばると抜け漏れが生じるため 1 か所にまとめる。
 * @param message - クライアントへ返す安全な日本語メッセージ
 * @param status - HTTP ステータスコード
 * @param headers - 追加で付与するヘッダ（Retry-After など。省略可）
 * @returns エラー内容を表す JSON レスポンス
 */
function jsonError(
  message: string,
  status: number,
  headers?: HeadersInit
): NextResponse<ChatErrorResponse> {
  // 共通形式 { error: string } の JSON を指定ステータスで返す
  return NextResponse.json({ error: message }, { status, headers });
}

/**
 * レート制限超過を表す 429 応答を組み立てる。
 * 自前のレート制限と上流 429 の両方で同じ応答を返すため共通化する（§6 DRY）。
 * @returns Retry-After ヘッダ付きの 429 レスポンス
 */
function rateLimitedResponse(retryAfterSeconds: string = RETRY_AFTER_SECONDS): NextResponse<ChatErrorResponse> {
  // 再試行までの待機秒数を Retry-After で明示して 429 を返す
  return jsonError(ERROR_MESSAGES.rateLimited, 429, {
    "Retry-After": retryAfterSeconds,
  });
}

/**
 * 上流が返した Retry-After ヘッダから待機秒数を取り出す。
 *
 * <p>上流のレート制限を 429 として中継するとき、自前の制限器の待機時間
 * （既定 60 秒）をそのまま載せてはいけない。上流が「300 秒待て」と言っている
 * のに 60 秒と伝えると、クライアントは成功しえない再試行を繰り返して自前の
 * 枠まで食い潰す。逆に上流が「2 秒」のときは不要に 60 秒待たせることになる。
 *
 * @param error - 上流から受け取った API エラー
 * @returns 秒数の文字列。ヘッダが無い・10 進数字だけの形でない場合は null
 */
function upstreamRetryAfterSeconds(error: InstanceType<typeof Anthropic.APIError>): string | null {
  // ヘッダは実装によって形が異なるため、取得できないときは素直に諦める
  const raw = error.headers?.get?.("retry-after");
  // ヘッダが無ければ使えない
  if (!raw) {
    return null;
  }
  // 秒数（RFC 9110 の delay-seconds は 10 進数字だけ）の形かを厳密に確かめる。
  // Number() の変換規則に任せると、空白だけの値が 0 に、"0x10" が 16 に、
  // "1e3" が 1000 になってしまう。とくに空白だけの値は下の切り上げで 1 秒に化け、
  // 成功しえない再試行を 1 秒後に促して自前の枠まで食い潰す
  // （この関数が防ぎたいことそのもの）。RFC 9110 は HTTP-date も許すが、
  // その形は数字だけではないのでここで弾かれ、自前の待機時間へ倒れる
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }
  // 数字だけであることが確かめられたので秒数へ変換する
  const seconds = Number(raw.trim());
  // 桁が多すぎる値は信用せず、自前の待機時間へ倒す。
  // 「有限かどうか」だけでは足りない: 1e21 以上の数値は String() が指数表記
  // （"1e+25"）を返すため、数字だけを確かめて通したのに RFC 9110 の
  // delay-seconds ではないヘッダを送り出すことになる（この関数が防ぎたい形そのもの）
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }
  // 最低でも 1 秒は待たせる。0 をそのまま伝えると「すぐ再試行してよい」の意味になり、
  // 上流に弾かれ続けるリクエストで自前のレート制限の枠まで食い潰す
  return String(Math.max(1, seconds));
}

/**
 * Content-Type ヘッダが JSON を示しているかを判定する。
 * `application/json; charset=utf-8` のようにパラメータが付く形も正当なので、
 * セミコロンより前の MIME タイプ本体だけを比較する（大文字小文字は区別しない）。
 * @param request - 受信リクエスト
 * @returns JSON として受け付けてよい Content-Type なら true
 */
function hasJsonContentType(request: NextRequest): boolean {
  // Content-Type ヘッダを取得する（未指定なら空文字列として扱う）
  const contentType = request.headers.get("content-type") ?? "";
  // パラメータ（charset 等）を切り落とし、前後の空白を除いて小文字化する
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  // 必須の MIME タイプと一致するかを返す
  return mimeType === REQUIRED_CONTENT_TYPE;
}

/**
 * リクエストヘッダから送信元を識別するキーを解決する。
 * X-Forwarded-For の先頭要素はクライアント自身が偽装できる（nginx 等の一般的な
 * リバースプロキシは受信した値の「後ろ」に実 IP を追記する）ため、先頭ではなく
 * 信頼できるプロキシが設定する X-Real-IP を優先し、無ければ末尾（最後のプロキシが
 * 追記した実際の接続元）を採用する。それでも直接公開構成では偽装が残るため、
 * 追跡表の上限と共有バケット（@/lib/rate-limit）で資源枯渇を防いでいる。
 * @param request - 受信リクエスト
 * @returns レート制限のキーとして使う文字列
 */
function resolveClientKey(request: NextRequest): string {
  // 信頼できるプロキシ（nginx / ホスティング基盤）が設定する X-Real-IP を最優先で使う
  const realIp = request.headers.get("x-real-ip")?.trim();
  // X-Real-IP が妥当な長さで存在すればそれをキーとして返す
  if (realIp && realIp.length <= MAX_CLIENT_KEY_LENGTH) {
    return realIp;
  }
  // X-Forwarded-For ヘッダを取得する（無ければ null）
  const forwarded = request.headers.get("x-forwarded-for");
  // カンマ区切りの各要素を空白除去し、空要素を取り除いた配列にする
  const hops = forwarded
    ?.split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  // 末尾の要素（最後のプロキシが追記した、偽装できない接続元 IP）を取り出す
  const lastHop = hops?.[hops.length - 1];
  // 空・過剰な長さのキーは不正値とみなし共通の "unknown" に倒す（キー長でのメモリ消費も防ぐ）
  if (!lastHop || lastHop.length > MAX_CLIENT_KEY_LENGTH) {
    return "unknown";
  }
  // 妥当な長さのクライアント IP をキーとして返す
  return lastHop;
}

/**
 * 中断（abort）由来のエラーかどうかを判定する。
 * クライアント切断でストリームを打ち切ったときに発生するエラーは異常系ではないため、
 * エラーログやストリームのエラー通知に流さず静かに終了させる判定に使う。
 * @param error - 捕捉したエラー
 * @returns true なら中断由来のエラー
 */
function isAbortError(error: unknown): boolean {
  // Anthropic SDK が中断時に投げる型付きエラーなら中断と判定する
  if (error instanceof Anthropic.APIUserAbortError) {
    return true;
  }
  // fetch / AbortController 由来の中断エラー（name が "AbortError"）も中断と判定する
  return error instanceof Error && error.name === "AbortError";
}

/**
 * リクエストボディを上限バイト数まで読み取って文字列として返す。
 * Content-Length ヘッダの事前チェックは自己申告値しか見られず、チャンク転送
 * （Content-Length 無し）では素通りしてしまうため、実際に読んだバイト数で
 * 上限を強制する（§セキュリティ: 入力は信用しない・リクエストサイズ上限）。
 * @param request - 受信リクエスト
 * @param limitBytes - 許容する最大バイト数
 * @returns ボディ文字列（上限を超えた場合は null）
 */
async function readBodyWithinLimit(
  request: NextRequest,
  limitBytes: number
): Promise<string | null> {
  // ボディストリームの読み取り口を取得する（ボディが無ければ空文字列を返す）
  const reader = request.body?.getReader();
  if (!reader) {
    return "";
  }
  // 読み取ったチャンク（バイト列）を貯めておく配列
  const chunks: Uint8Array[] = [];
  // ここまでに読み取った合計バイト数
  let total = 0;
  // ボディを最後まで（または上限超過まで）順に読み取る
  while (true) {
    // 次のチャンクを 1 つ読み取る
    const { done, value } = await reader.read();
    // 読み終わったらループを抜ける
    if (done) {
      break;
    }
    // 合計バイト数を更新する
    total += value.byteLength;
    // 合計が上限を超えたら、それ以上読まずに打ち切って「超過」を知らせる
    if (total > limitBytes) {
      // 残りのボディの受信を中止する（読み続けてメモリを消費しない）。
      // 既にエラーで終わっているストリームの cancel は reject するため、
      // 捕まえずに待つと 413 のつもりが「想定外のエラー」の 500 に化ける
      // （目的は解放なので、失敗しても実害は無い。debug には残す）
      await reader.cancel().catch((cancelError: unknown) => {
        console.debug("リクエストボディの解放に失敗しました:", cancelError);
      });
      return null;
    }
    // 上限内のチャンクを配列に追加する
    chunks.push(value);
  }
  // すべてのチャンクを 1 つのバイト列に結合する
  const merged = new Uint8Array(total);
  // 結合位置（オフセット）を先頭から進めながらコピーする
  let offset = 0;
  for (const chunk of chunks) {
    // このチャンクを結合先の現在位置へコピーする
    merged.set(chunk, offset);
    // 次のコピー開始位置をチャンク分だけ進める
    offset += chunk.byteLength;
  }
  // バイト列を UTF-8 文字列に変換して返す（デコーダはモジュールで共有する）
  return bodyDecoder.decode(merged);
}

/**
 * リクエストボディの messages を検証し、問題があれば日本語のエラーメッセージを返す。
 * 形だけの配列チェックでは巨大な本文・未知のロール・空配列がそのまま Claude へ
 * 転送されてしまうため、境界（件数・文字数・型）まで検証する（§セキュリティ: 入力は信用しない）。
 * @param messages - リクエスト由来の未検証の値
 * @returns エラーメッセージ（問題なければ null）
 */
function validateMessages(messages: unknown): string | null {
  // 配列でない場合は形式エラーとする
  if (!Array.isArray(messages)) {
    return ERROR_MESSAGES.messagesRequired;
  }
  // 空配列は Claude API 側でエラーになるため、ここで 400 として弾く
  if (messages.length === 0) {
    return ERROR_MESSAGES.messagesEmpty;
  }
  // 件数上限を超える履歴は受け付けない（トークン浪費・リソース枯渇防止）
  if (messages.length > MAX_MESSAGE_COUNT) {
    return TOO_MANY_MESSAGES_MESSAGE;
  }
  // 各メッセージの中身（ロール・本文）を検証する
  for (const message of messages) {
    // オブジェクトでない要素（null・文字列など）は形式エラーとする
    if (typeof message !== "object" || message === null) {
      return ERROR_MESSAGES.messageShapeInvalid;
    }
    // 検証のためにロールと本文を取り出す（この時点では未検証の unknown として扱う）
    const { role, content } = message as { role?: unknown; content?: unknown };
    // ロールが許可リストに無い場合は弾く（"system" 等を Claude へ転送させない）
    if (!ALLOWED_ROLES.includes(role as Role)) {
      return ERROR_MESSAGES.messageRoleInvalid;
    }
    // 本文が文字列でない・空文字列の場合は弾く
    if (typeof content !== "string" || content.trim() === "") {
      return ERROR_MESSAGES.messageContentEmpty;
    }
    // 本文が上限文字数を超える場合は弾く（巨大ボディの転送防止）
    if (content.length > MAX_CONTENT_LENGTH) {
      return CONTENT_TOO_LONG_MESSAGE;
    }
  }
  // 先頭が user 発言でない履歴は上流 Claude が必ず 400 で拒否するため、ここで弾く。
  // 画面側（trimHistoryForRequest）は窓の先頭が user になるまで古い側を捨てて
  // この形を保証しているが、保証を送信側だけに置くと上流を 1 往復むだに呼ぶ
  // （課金と待ち時間が発生する）うえ、画面以外の呼び出し元では保証が消える。
  // 検証はこの層（入力は信用しない境界）に置く
  if ((messages[0] as Message).role !== "user") {
    return ERROR_MESSAGES.messagesMustStartWithUser;
  }
  // 末尾も user 発言でなければ弾く。assistant 発言で終わる履歴を送ると、上流は
  // 「その続きを書く」ため、送り主が置いた assistant の書き出しをモデルが
  // そのまま引き継いでしまう（カテゴリ別のシステムプロンプトによる制約より、
  // 送り主が書いた文章のほうが強く効く形になる）。認証の無い従量課金の
  // エンドポイントなので、この形は受け付けない。画面側は必ず末尾に今回の
  // ユーザー入力を積むので、正規の利用では起こらない
  if ((messages[messages.length - 1] as Message).role !== "user") {
    return ERROR_MESSAGES.messagesMustEndWithUser;
  }
  // すべての検証を通過したら問題なし（null）を返す
  return null;
}

/** Claude API から受け取るストリーム（SSE 変換に必要な最小限の形）。
 * SDK の Stream 型に依存せず「非同期反復できて中断できる」ことだけを要求することで、
 * テストのモックとも実装を共有できるようにする。 */
type UpstreamStream = AsyncIterable<Anthropic.RawMessageStreamEvent> & {
  /** クライアント切断時に上流の生成を打ち切るためのコントローラ */
  controller: { abort: () => void };
};

/**
 * 上流の Claude ストリームを、ブラウザへ返す SSE 形式の ReadableStream に変換する。
 * POST ハンドラーから切り出して「SSE への変換」という単一の責務に閉じ込める（§6 単一責務）。
 * @param stream - 上流 Claude API のイベントストリーム
 * @param requestSignal - リクエストの中断シグナル。SDK は中断でも throw せず正常終了するため、
 *                        ループが終わった理由（流し切った／中断された）はこれでしか区別できない
 * @returns SSE のバイト列を流す ReadableStream
 */
function createSseStream(
  stream: UpstreamStream,
  requestSignal: AbortSignal
): ReadableStream<Uint8Array> {
  // 受信側が自分から切断した（cancel() が呼ばれた）かどうかを覚えておくフラグ。
  // 切断後は controller へ書けなくなるので、書き込みの前に必ずこれを確認する。
  // cancel() は controller が使えなくなるのと同時に同期的に呼ばれ、確認と書き込みの
  // 間には await を挟まないため、確認を通ったあとに切断が割り込むことはない
  let cancelledByConsumer = false;
  // SSE のチャンクを順次書き出す ReadableStream を組み立てて返す
  return new ReadableStream({
    async start(controller) {
      // 上流が伝えてきた生成の終了理由（届かなければ null のまま）。
      // 「打ち切りの理由を列挙して弾く」のではなく「最後まで話し終えた理由だけを
      // 完了とみなす」向きで判定する。SDK の StopReason には max_tokens 以外にも
      // model_context_window_exceeded や refusal といった途中終了があり、
      // 列挙側で持つと新しい理由が増えるたびに黙って「完全な回答」に化ける
      let finalStopReason: Anthropic.StopReason | null = null;
      try {
        // テキストデルタイベントを順次読み出す
        for await (const event of stream) {
          // 生成の終了理由を伝えるイベントなら、その理由を控える
          if (event.type === "message_delta" && event.delta.stop_reason) {
            finalStopReason = event.delta.stop_reason;
          }
          // content_block_delta イベントからテキスト差分を取得する
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            // 受信側が既に切断していれば、書く相手がいないのでここで終える。
            // 書きに行くと「Invalid state: Controller is already closed」の
            // TypeError になり、正常な切断が上流障害と見分けられなくなる
            if (cancelledByConsumer) {
              return;
            }
            // テキスト差分を SSE 形式でエンコードして送信する（書式は @/lib/sse に集約）
            const data = JSON.stringify({ text: event.delta.text });
            controller.enqueue(sseEncoder.encode(formatSseFrame(data)));
          }
        }
        // 上流を読み切ったあとも、書く前に受信側が残っているかを確かめる。
        // SDK は反復中の中断を throw せず正常終了する（core/streaming.js の
        // 「abort されたら return する」）ため、切断はここへ普通に到達する
        if (cancelledByConsumer) {
          return;
        }
        // ループが例外なく終わったことは「上流が最後まで流し切った」ことを意味しない。
        // SDK は中断でも throw せず return するので、プラットフォームの実行時間上限や
        // ゲートウェイのアイドルタイムアウトで request.signal が中断された場合も
        // ここへ普通に到達する。区別せず [DONE] を送ると、途中で切れた回答が
        // 「完全な回答」としてクライアントに確定・保存され、次のターンでは
        // 欠けたままの回答が文脈として送り返される（しかもサーバには何も残らない）
        //
        // ここではログを出さない: 中断の理由が「クライアントがタブを閉じた」のか
        // 「プラットフォームが実行時間上限で打ち切った」のかは区別できない。
        // タブ閉じでも request.signal は中断され、cancel() が届く順序は保証が無いので、
        // ログを出すと通常の離脱のたびに障害ログが積まれて本物の障害が埋もれる。
        // 上流そのものの失敗（下の console.error）は別経路なので記録は失われない
        if (requestSignal.aborted) {
          // 受信側には「完了していない」ことを伝える（正常完了と見分けられるようにする）
          controller.error(new Error("ストリーミングが完了前に中断されました"));
          return;
        }
        // 最後まで話し終えた理由でなければ「完了」ではないので終端の番兵を送らない。
        // 受信側は [DONE] を受け取れなかった読み取りを「途中で切れた回答」として
        // 扱い、印を付けて履歴に残す。通信としては正常なのでエラーにはしない
        // （エラーにすると、実際には届いている回答に通信障害の警告が出てしまう）。
        //
        // 終了理由が 1 度も届かなかった場合（null）も完了ではない。上流の応答本文が
        // message_delta を出す前に途切れると、SDK は途切れを例外にせず反復を終える
        // ため、ここには「理由なしの正常終了」として現れる。null を完了側へ倒すと、
        // その途切れた回答だけが唯一「完全な回答」として確定してしまい、既知の
        // 打ち切り理由に対する扱い（完了の理由だけを完了とみなす）と正反対になる
        if (
          finalStopReason === null ||
          !COMPLETE_STOP_REASONS.includes(finalStopReason)
        ) {
          controller.close();
          return;
        }
        // ストリーム終了を通知する（番兵の値は読み取り側と共有の定数を使う）
        controller.enqueue(sseEncoder.encode(formatSseFrame(SSE_DONE_MARKER)));
        // ストリームを閉じる
        controller.close();
      } catch (error) {
        // ここへ来るのは上流の反復そのものが失敗した場合だけになる
        // （受信側への書き込みは上の切断チェックで守られているため）。
        // だから失敗の種類で分類してから、受信側の有無で後始末を変える。
        //
        // 分類を先に行うのが重要: 上流の失敗と受信側の切断はネットワーク障害で
        // 同時に起きうる。切断の有無を先に見て早期 return すると、その競合の
        // ときだけ本物の上流障害が無記録で消え、いちばんログが欲しい場面で
        // 記録が残らなくなる

        // 中断由来のエラー（SDK の分類が変わった場合などの保険）はサーバの障害では
        // ないので記録しない。ただし受信側がまだ読んでいるなら、回答は途中で切れて
        // いるので黙って閉じてはいけない。[DONE] なしで close() すると、読み手は
        // done で抜けて「完全な回答」として確定させてしまい、正常完了と区別が付かない。
        // error() なら終端も伝わる（宙吊りにならない）うえ、切れたことも伝わる
        // なお、受信側が既に切断していれば error() は仕様上その場で戻る（何も起きない）
        // ので、切断の有無で呼び分ける必要はない。呼び分けが要るのは enqueue() /
        // close() のほうで、あちらは切断後に呼ぶと TypeError になる
        if (isAbortError(error)) {
          controller.error(error);
          return;
        }

        // 中断以外の失敗（上流の切断・overloaded 等）はサーバログに必ず残す。
        // この時点では既に 200 とヘッダを返し終えているため POST ハンドラーの
        // catch（mapErrorToResponse）へは戻らず、controller.error() は受信側を
        // reject させるだけでサーバ側には何の記録も残らない。ログを出さないと
        // 上流障害が繰り返し起きても運用者が気づけない（§6 エラーを握り潰さない）
        console.error(
          "チャット API のストリーミング中にエラーが発生しました:",
          error
        );

        // 受信側へ失敗を伝える（切断済みなら上と同じく何も起きない）
        controller.error(error);
      }
    },
    cancel() {
      // 受信側が自分から切断したことを記録する（上の catch が後始末を分岐するのに使う）
      cancelledByConsumer = true;
      // 受信側（クライアント）が切断したら上流の Claude ストリームも中断する。
      // 放置すると切断後も上流の生成が続き、トークンが課金され続けてしまう
      stream.controller.abort();
    },
  });
}

/**
 * 捕捉した例外を、クライアントへ返す HTTP レスポンスへ対応付ける。
 * POST ハンドラーから切り出して「エラー→ステータス変換」の責務に閉じ込める（§6 単一責務）。
 * @param error - 捕捉した未知の例外
 * @returns クライアントへ返すレスポンス
 */
function mapErrorToResponse(error: unknown): NextResponse<ChatErrorResponse> | Response {
  // 接続確立前にクライアントが切断した場合の中断（request.signal 経由の abort）は
  // 異常系ではないため、サーバ障害としてログに残さず静かに応答を打ち切る
  // （499 はクライアント切断を表す慣用ステータス。切断済みなので誰も受け取らない）
  if (isAbortError(error)) {
    return new Response(null, { status: 499 });
  }

  // Anthropic SDK の型付きエラーはステータスコードで分類する。
  // 旧実装のメッセージ文字列への部分一致（"API"/"key"）は、上流の 429 を 500 に
  // 誤分類し、逆に 401 では英語の内部エラーメッセージをそのまま外部へ漏らしていた
  if (error instanceof Anthropic.APIError) {
    // 認証エラー（API キー無効等）は 401 と日本語の安全な文言を返す
    if (error.status === 401) {
      return jsonError(ERROR_MESSAGES.invalidApiKey, 401);
    }
    // 上流のレート制限（429）はそのまま 429 として返す（CLAUDE.md のステータス契約）。
    // 待機時間は上流が指定していればそれに従う（自前の待機時間は上流の都合を知らない）
    if (error.status === 429) {
      // 上流の指定が無ければ引数を省略し、既定（自前の待機時間）を 1 か所に保つ
      return rateLimitedResponse(upstreamRetryAfterSeconds(error) ?? undefined);
    }
    // 上流の 400（リクエスト内容起因のエラー）はクライアントエラーとして 400 で返す。
    // 500 に倒すとクライアント起因の問題がサーバ障害として誤って記録・表示されてしまう
    if (error.status === 400) {
      return jsonError(ERROR_MESSAGES.invalidRequest, 400);
    }
  }

  // API キー未設定（getAnthropicClient が投げる専用エラー）は 401 を返す。
  // 旧実装は例外の message をそのままクライアントへ返しており、匿名の呼び出し元に
  // サーバ側の環境変数名（ANTHROPIC_API_KEY）という内部構成情報を漏らしていた
  // （§9 内部詳細をエラー応答に漏らさない／§6 クライアント文言は ERROR_MESSAGES に一元管理）。
  // 判定も message の部分一致から instanceof へ変え、throw の文言変更で静かに 500 へ
  // 化けない（型で守られる）ようにする。
  if (error instanceof MissingApiKeyError) {
    // 設定漏れは運用者が必ず気づくべき障害なので、詳細はサーバログにだけ残す（§6 握り潰さない）
    console.error(
      "チャット API の呼び出しに必要な API キーが未設定です:",
      error.name
    );
    // クライアントへは一元管理された安全な文言だけを返す
    return jsonError(ERROR_MESSAGES.invalidApiKey, 401);
  }

  // 想定外のエラーは詳細をサーバログにだけ残す（内部情報を外部へ返さない）
  console.error("チャット API で想定外のエラーが発生しました:", error);

  // その他のエラーは 500 と汎用の安全な文言を返す
  return jsonError(ERROR_MESSAGES.internal, 500);
}

/**
 * POST ハンドラー
 * ユーザーのチャットメッセージを受け取り、Claude API にストリーミングで転送する。
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<ChatErrorResponse> | Response> {
  try {
    // Content-Type が application/json でないリクエストは、他のどの処理よりも先に
    // 415 で弾く。ボディを読む前に判定するので上流呼び出しも発生しない。
    // レート制限より前に置くのが重要: 第三者サイトが被害者のブラウザから simple request
    // （text/plain 等）を大量に送ると、レート制限が先だとその分だけ被害者 IP の枠が減り、
    // 本人が正規に使おうとしたときに 429 になってしまう（枠の枯渇による嫌がらせ）。
    // ここで先に弾けば「この API が受け付ける形ですらないリクエスト」は枠を消費しない。
    // 逆に無制限に 415 を叩かれる懸念はあるが、ヘッダ 1 本を見るだけの安価な拒否であり、
    // 正しい Content-Type で叩けば結局レート制限に当たるため攻撃者の得は増えない
    if (!hasJsonContentType(request)) {
      return jsonError(ERROR_MESSAGES.unsupportedMediaType, 415);
    }

    // リクエスト元を識別するキーを取得する
    const clientKey = resolveClientKey(request);

    // レート制限チェックを行う
    if (rateLimiter.isRateLimited(clientKey)) {
      // 制限超過の場合は 429 を返す（Retry-After で再試行までの待機秒数を伝える）
      return rateLimitedResponse();
    }

    // Content-Length ヘッダを数値として取得する（無ければ 0 とみなす）
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    // 申告値が明らかに大きすぎるボディは読み取り前に 413 で弾く（速い前段チェック）
    if (contentLength > MAX_BODY_BYTES) {
      return jsonError(ERROR_MESSAGES.bodyTooLarge, 413);
    }

    // ボディを上限バイト数を強制しながら読み取る（ヘッダ申告に依存しない実測の上限。
    // チャンク転送等で Content-Length が無いリクエストもここで必ず頭打ちになる）
    const rawBody = await readBodyWithinLimit(request, MAX_BODY_BYTES);
    // 実際の読み取りが上限を超えたボディは 413 で弾く（メモリ枯渇の防止）
    if (rawBody === null) {
      return jsonError(ERROR_MESSAGES.bodyTooLarge, 413);
    }

    // リクエストボディを JSON としてパースする（壊れた JSON は 400 として弾く）
    let body: { messages?: unknown; category?: unknown };
    try {
      // JSON パースを試みる（unknown として受け取り、この後の検証で絞り込む）
      body = JSON.parse(rawBody) as { messages?: unknown; category?: unknown };
    } catch {
      // JSON として不正なボディは 400（クライアント起因のエラー）を返す
      return jsonError(ERROR_MESSAGES.invalidJson, 400);
    }

    // JSON として正しくてもオブジェクトとは限らない（"null" / "1" / "[]" / 文字列も
    // 正しい JSON）。null のまま次の行で body.messages を読むと TypeError になり、
    // 入力の誤りが 500 と「想定外のエラー」のサーバログに化ける。
    // 入力検証の誤りは 400 で返す契約なので、ここで形を確かめる
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(ERROR_MESSAGES.messagesRequired, 400);
    }

    // メッセージ配列を検証する（件数・ロール・本文の型と長さまで確認する）
    const validationError = validateMessages(body.messages);
    // 検証エラーがあれば 400 を返す
    if (validationError) {
      return jsonError(validationError, 400);
    }

    // 検証を通過したメッセージ配列を型付きで取り出す
    const messages = body.messages as Message[];

    // カテゴリは既知の ID のみ採用する（未知の値は undefined として general に倒す）
    const category = isCategoryId(body.category) ? body.category : undefined;

    // Anthropic クライアントを取得する（API キー未設定なら例外が飛ぶ）
    const client = getAnthropicClient();

    // 選択カテゴリに応じたシステムプロンプトを取得する
    const systemPrompt = getSystemPrompt(category);

    // Claude API にストリーミングリクエストを送信する。
    // 旧実装の messages.stream() は接続を待たずに MessageStream を同期的に返すため、
    // await しても上流の 401/429/400 はここで捕捉できず（エラーは反復中に初めて
    // 表面化する）、下の catch のステータスマッピングが本番経路では一度も効かない
    // 到達不能コードになっていた。stream: true の messages.create() は上流の HTTP
    // 応答を受け取ってから解決する Promise を返し、認証エラー等は Anthropic.APIError
    // として reject されるため、200 を確定させる前に catch へ届く
    // （CLAUDE.md のエラーステータス契約を実経路で機能させる）。
    const stream = await client.messages.create(
      {
        model: MODEL_NAME,
        // カテゴリ別の上書き設定があればそれを、なければ既定値を使う
        max_tokens: getMaxTokens(category, DEFAULT_MAX_TOKENS),
        system: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        // イベント単位のストリーミング応答を要求する
        stream: true,
      },
      {
        // クライアント切断でリクエストが中断されたら、上流への問い合わせも中断する
        signal: request.signal,
        // 応答しない上流に接続を占有され続けないよう明示的な上限を設ける（§9）
        timeout: UPSTREAM_TIMEOUT_MS,
      }
    );

    // 上流ストリームを SSE へ変換する。リクエストの中断シグナルも渡し、
    // 「上流が流し切った」のか「途中で中断された」のかを区別できるようにする
    const readableStream = createSseStream(stream, request.signal);

    // SSE レスポンスを返す
    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        // nginx 等の逆プロキシがレスポンスをバッファリングすると、生成が終わるまで
        // 1 文字も届かず「ストリーミング」にならないため、明示的に無効化する。
        // （Connection ヘッダはホップバイホップで Response に付けても無視されるため外した）
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: unknown) {
    // 例外の種類に応じた応答（499 / 401 / 429 / 400 / 500）へ変換して返す
    return mapErrorToResponse(error);
  }
}
