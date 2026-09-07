// `.github/dependabot.yml` などの設定ファイルを「構造として」読むための共有ヘルパー。
//
// なぜ切り出すのか:
//   Dependabot の ignore を見張るテストは 1 本ではなくなった
//   (`tests/dependabot-eslint-guard.test.ts` と `tests/node-runtime-alignment.test.ts`)。
//   どちらも「npm・対象ディレクトリのブロックを選ぶ → その ignore から対象パッケージの
//   エントリを**すべて**集める」という同じ読み方をする。書き写すと、Dependabot の仕様に
//   合わせた細かい配慮 (`directories` の複数形・glob、`dependency-name` のワイルドカード、
//   複数エントリがすべて適用されること) が片方だけ直され、もう片方の検出網が静かに緩む。
//   読み方の定義はここ 1 か所に置く (CLAUDE.md §6 DRY / 定数の一元管理)。
//
// ここに置くのは「設定をどう読むか」だけで、「何を良しとするか」は各テストが持つ。
// 読み手を増やすときは、既存のテストが数えている「読み飛ばし」の範囲
// (dependabot-eslint-guard.test.ts の countUnreadableElements) も合わせて見直すこと。

// 設定ファイルを読むため (Node 標準の同期 API で十分)
import { readFileSync } from "node:fs";
// 検査対象のパスを組み立て、失敗文言では相対パスに畳むため
import { dirname, relative, resolve } from "node:path";
// このファイル自身の場所を ESM の標準的な方法で求めるため
// (`__dirname` は CommonJS の変数で、素の ESM として読まれた時点で ReferenceError になる)
import { fileURLToPath } from "node:url";

// リポジトリのルート (このファイルは tests/lib/ にあるので 2 つ上が repo のルート)
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Dependabot の設定ファイル
export const DEPENDABOT_PATH = resolve(REPO_ROOT, ".github/dependabot.yml");
// 依存の宣言
export const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
// 依存の解決済み版 (package.json には現れない推移依存もここに出る)
export const PACKAGE_LOCK_PATH = resolve(REPO_ROOT, "package-lock.json");
// 保留を書くエコシステム。ここ以外に置いても npm には効かない
export const NPM_ECOSYSTEM = "npm";
// 保留を書く対象ディレクトリ。npm のブロックが複数ある構成 (モノレポ等) で読み違えないために見る
export const NPM_DIRECTORY = "/";
// major 更新だけを止めるための update-types 値 (Dependabot の予約語)
export const MAJOR_UPDATE_TYPE = "version-update:semver-major";
// ignore エントリに書いてよいキーの一覧 (これ以外が増えると効き方が変わる)。
// 例えば `versions: [">=9.40.0"]` を足すと現行系列の更新まで止まるので、
// 「major だけを止める」という意図と実際の効き方がずれる
export const ALLOWED_IGNORE_KEYS = ["dependency-name", "update-types"];


// dependabot.yml のうち、この検査が読む部分だけを表す型。
// 全項目を書き写すと設定を増やすたびに型の更新が要るので、必要な枝だけ宣言する
export interface DependabotIgnoreEntry {
  "dependency-name"?: unknown;
  "update-types"?: unknown;
}
export interface DependabotUpdateEntry {
  "package-ecosystem"?: unknown;
  // Dependabot は単数形の `directory` と複数形の `directories`(配列) の両方を受け付ける
  directory?: unknown;
  directories?: unknown;
  ignore?: unknown;
}
export interface DependabotConfig {
  updates?: unknown;
}

/**
 * 配列でなければ空配列にして返す。
 *
 * YAML は何でも書けるので、想定した形でなければ「空」として扱い、
 * 呼び出し側の検査 (エントリが存在すること) を落とす方向へ倒す。
 */
export function asArray(value: unknown): unknown[] {
  // 配列ならそのまま、そうでなければ空配列 (= 見つからなかった扱い)
  return Array.isArray(value) ? value : [];
}

/**
 * 配列のうち「オブジェクトとして書かれた要素」だけを返す (配列そのものは除く)。
 *
 * YAML のリストは、ブロックをコメントアウトした残りとして空要素 `-` を書けてしまう。
 * それをパースすると要素が `null` になるので、素直にキーを読むと
 * `TypeError: Cannot read properties of null` になり、**describe のトップレベルで
 * 評価されるこのファイルは全検査が収集時エラーとして落ちる**。CI は赤くなるものの、
 * このファイルが掲げている「何を直せばよいか分かる日本語の失敗文言」が一切出ない。
 *
 * そこで読めない形の要素はここで落とし、「そのエントリは無かった」ものとして扱う。
 *
 * **ただし「落とした」こと自体は握り潰さない。** 落とすだけだと、正しいエントリの
 * *隣* に空要素が増えたケース (`[{...}, null]`) で件数が変わらず、設定が壊れている
 * のに全検査が緑になる — 直前まで収集時エラーで赤かったものが静かに通るので、
 * 修正がかえって検出網を緩めてしまう。下の countUnreadableElements で数を突き合わせ、
 * 読めない要素が 1 つでもあれば専用の検査が落ちるようにしてある。
 */
export function objectElementsOf(value: unknown): Record<string, unknown>[] {
  // 配列でなければ空配列 (= 要素なし) にしてから、要素を 1 つずつ振るう
  return asArray(value).filter(
    // null と配列を除いたオブジェクトだけを残す (typeof は null も配列も "object" と答えるため)
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

/**
 * 指定エコシステムの update ブロックを返す (ディレクトリでは絞らない)。
 *
 * guardedBlocksOf はこの関数の戻り値に対してだけ coversDirectory を掛けるので、
 * **coversDirectory が呼ばれるのはここを通ったブロックだけ**。
 * つまり「directory / directories が読まれる範囲」はこの関数の戻り値そのもの。
 * 読み手 (guardedBlocksOf) と数え手 (countUnreadableElements) が同じ定義を
 * 共有できるよう、エコシステムの照合を 1 か所に置く (§6 DRY)。
 * 手で書き写すと、照合規則を変えたときに「読む場所」と「数える場所」がずれる。
 */
export function ecosystemBlocksOf(
  blocks: readonly Record<string, unknown>[],
  ecosystem: string,
): Record<string, unknown>[] {
  // 読み込み済みのブロック配列をエコシステムで絞る
  return blocks.filter((entry) => entry["package-ecosystem"] === ecosystem);
}

/**
 * ignore エントリの `dependency-name` が、対象パッケージに当たるかを判定する。
 *
 * Dependabot の `dependency-name` は `*` をワイルドカードとして解釈するため、
 * 文字列の完全一致だけで見ると `"*"` や `"eslint*"` のエントリを取り落とす。
 * それらも eslint に効いてしまう (しかも update-types 無しなら全バージョンを止める) ので、
 * ワイルドカードを展開して照合する。
 *
 * パターンはこのリポジトリ自身の設定ファイル由来なので、外部入力を正規表現に
 * 通すときの懸念 (§9 の ReDoS) は当たらない。それでも `*` 以外のメタ文字は
 * エスケープして、意図しないパターンとして解釈されないようにする。
 */
export function ignoreNameMatches(pattern: unknown, dependencyName: string): boolean {
  // 文字列でなければ照合のしようがない (= 当たらない扱い)
  if (typeof pattern !== "string") return false;
  // `*` 以外の正規表現メタ文字を無効化してから、`*` だけを「任意の文字列」に置き換える
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  // 前後を固定して全体一致で判定する
  return new RegExp(`^${source}$`).test(dependencyName);
}

/**
 * update ブロックが、対象ディレクトリを担当しているかを判定する。
 *
 * Dependabot は単数形の `directory: "/"` と複数形の `directories: ["/"]` の両方を
 * 受け付ける。単数形だけを見ていると、複数形へ書き換えられた瞬間に「ブロックが無い」と
 * 読み違え、実際には効いている ignore を「消えた」と報告してしまう
 * (その指摘に従って 2 件目を足すと、今度は Dependabot が両方を適用して効きすぎる)。
 */
export function coversDirectory(entry: DependabotUpdateEntry, directory: string): boolean {
  // 単数形が一致すればそれで確定
  if (entry.directory === directory) return true;
  // 複数形は glob も書ける (`["/**"]` / `["/*"]`)。完全一致だけを見ると、
  // 実際には担当しているブロックを「無い」と読み違えるので、glob も展開して照合する
  return asArray(entry.directories).some(
    (value) => typeof value === "string" && directoryPatternCovers(value, directory),
  );
}

/**
 * `directories` に書ける 1 つのパターンが、対象ディレクトリを覆うかを判定する。
 *
 * Dependabot の `directories` は完全一致のほか `*` / `**` の glob を受け付ける。
 * ここで扱うのは自分たちが書いた設定の 1 要素だけなので、`*` を「`/` を含まない任意」、
 * `**` を「任意」として素直に展開すれば足りる。
 */
export function directoryPatternCovers(pattern: string, directory: string): boolean {
  // `**` は「任意」、`*` は「/ を含まない任意」に相当する。先に `**` を目印へ退避し、
  // 残った正規表現メタ文字を無効化してから、目印を展開し直す
  const doubleStarMark = "\u0000";
  const escaped = pattern
    .replace(/\*\*/g, doubleStarMark)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .split(doubleStarMark)
    .join(".*");
  // 前後を固定して全体一致で判定する
  return new RegExp(`^${escaped}$`).test(directory);
}

/**
 * 入力ファイルの表示名 (repo ルートからの相対パス) を返す。
 *
 * 失敗文言とテスト名で同じ名前を何度も使うので、導き方を 1 か所に置く (§6 DRY)。
 * 表示の仕方を変えたくなったとき、書き換える場所が 1 つで済むようにする。
 */
export function displayPath(path: string): string {
  // repo ルートからの相対パスにすると、環境ごとの絶対パスが文言に混ざらない
  return relative(REPO_ROOT, path);
}

/**
 * 読み取り例外を、環境ごとの絶対パスを含まない形の文字列にする。
 *
 * 例外メッセージには絶対パスがそのまま入る (ENOENT は
 * `open '/home/<誰か>/my-first-ai-app/package-lock.json'` の形)。displayPath で
 * ファイル名だけ相対化しても、隣に貼る原因文字列から絶対パスが漏れては同じこと
 * — CI の出力が実行機ごとに変わり、手元と突き合わせづらくなる。
 * repo ルートの接頭辞だけを畳んで、相対パスとして読めるようにする。
 */
export function describeReadError(error: unknown, root: string): string {
  // 例外を文字列にしてから、repo ルートの接頭辞をすべて取り除く
  return String(error).split(`${root}/`).join("");
}

/**
 * 値の「形」だけを短い日本語で表す (失敗文言に埋め込む用)。
 *
 * 値そのものを文字列化しないのは、JSON.stringify が循環参照で例外を投げるうえ
 * (YAML のアンカーで自己参照する配列が書ける)、大きな値だと文言が読めなくなるため。
 * ここで返すのは固定長の短い語句だけなので、どんな入力でも安全に使える。
 */
export function describeShape(value: unknown): string {
  // null は typeof が "object" になるので先に分ける
  if (value === null) return "null";
  // 配列も typeof が "object" なので個別に名前を付ける
  if (Array.isArray(value)) return "配列";
  // それ以外は型名だけを返す (string / number / boolean / undefined / object)
  return typeof value;
}

// 1 つの入力ファイルを読んだ結果 (解釈できた値と、読めなかったときの原因)
export interface ReadResult {
  // パースできた値 (読めなければ null)
  value: unknown;
  // 読み取り・パースで投げられた例外 (問題なければ null)
  error: unknown;
}

/**
 * ファイルを読んで解釈し、**例外を投げずに** 結果か原因のどちらかを返す。
 *
 * 3 つの入力 (dependabot.yml / package.json / package-lock.json) はいずれも
 * describe のトップレベルで読まれる。そこで例外が投げられると、このファイルの検査は
 * すべて「収集時エラー」になり、丁寧に書いた日本語の失敗文言が 1 つも出ない。
 * 実際に起こりうるのは、ファイルの削除・改名 (ENOENT)、マージ事故による破損
 * (SyntaxError / YAMLParseError) など。とくに dependabot.yml の削除は検出対象 (b)
 * 「保留の消失」そのもので、ロックファイルの破損は
 * 「上流プラグインがすべて読み取れる」検査の対象そのものなので、
 * **そこで案内が消えるとこのファイルの存在意義が失われる**。
 *
 * 例外は握り潰さず ReadResult に載せ、専用のテストが原因付きで報告する
 * (CLAUDE.md §6 エラーを握り潰さない)。
 */
export function readParsed(path: string, parse: (text: string) => unknown): ReadResult {
  // 読み取りとパースの結果を受ける入れ物
  let value: unknown;
  try {
    // ファイルを読んで解釈する
    value = parse(readFileSync(path, "utf8"));
  } catch (error) {
    // 読めなかった場合は値を持たず、原因だけを返す
    return { value: null, error };
  }
  // **例外が出なくても「構造として解釈できた」とは限らない。**
  // 空ファイルや全体をコメントアウトしたファイルは parseYaml が null を返す (実測)。
  // これを素通りさせると、「構造として解釈できる」と名乗るテストが
  // 中身の無いファイルに対して緑になり、読み手に誤った安心を与える。
  // 3 つの入力はいずれもトップレベルがオブジェクトである前提なので、そうでなければ
  // 読めなかったものとして扱う (fail-closed)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // 何が入っていたかを添えて原因を作る。**値そのものは埋め込まない** —
    // JSON.stringify は循環参照 (YAML のアンカーで自己参照配列が書ける。実測) で
    // 例外を投げ、しかもこの行は catch の外なので、収集時エラーになって
    // この関数の存在意義 (例外を投げない) が崩れる。巨大な値の丸ごと出力も避ける
    return {
      value: null,
      error: new Error(
        // 末尾に句点を置かない — 呼び出し側が原因を文中へ差し込むときに句点を足すため
        `トップレベルがオブジェクトではありません (${describeShape(value)})。` +
          `空ファイル・全体のコメントアウト・別の形への書き換えが疑われます`,
      ),
    };
  }
  // ここまで来れば構造として読めている
  return { value, error: null };
}

/**
 * この検査が「担当する」update ブロック (エコシステムとディレクトリの両方が一致) を返す。
 *
 * 絞り込みを 1 か所に集約するためのヘルパー (§6 DRY)。ignore を実際に読む
 * collectIgnoreEntries と、その読み飛ばしを数える countUnreadableElements が
 * **同じ条件**で動く必要がある。片方だけ条件が変わると「読んでいる場所」と
 * 「壊れを数えている場所」がずれ、読み飛ばしの検査に穴が空く。
 */
export function guardedBlocksOf(
  ecosystemBlocks: readonly Record<string, unknown>[],
  directory: string,
): Record<string, unknown>[] {
  // **エコシステムで絞った後の配列を受け取る。** 中で絞り直すと、呼び出し側が
  // すでに同じ絞り込みを持っている場合 (countUnreadableElements) に同じ配列を
  // 2 度走査することになる。受け取る形にすれば重複が構造的に起きない。
  // ディレクトリで絞るのは、npm のブロックが複数ある構成 (モノレポ等) で
  // 別ディレクトリのブロックに書かれた ignore を、このプロジェクトに効いていると
  // 読み違えないため
  return ecosystemBlocks.filter((entry) => coversDirectory(entry, directory));
}

/**
 * 指定したエコシステムの ignore から、対象パッケージのエントリを**すべて**集める。
 *
 * 1 件目だけを取らないのは、Dependabot が同じパッケージに対する複数のエントリを
 * **すべて適用する**ため。`- dependency-name: "eslint"` だけのエントリ (update-types 無し =
 * 全バージョンを無視) が 2 件目に足されると、1 件目だけ見ていては「major だけ止めている」
 * と誤読したまま、実際には 9 系の更新も止まっている状態を見逃す。
 *
 * エコシステム違い・パッケージ名違いはすべて「見つからない」に落ちるので、
 * 置き場所を間違えた ignore を有効なものと取り違えることもない。
 */
export function collectIgnoreEntries(
  config: DependabotConfig,
  ecosystem: string,
  directory: string,
  dependencyName: string,
): DependabotIgnoreEntry[] {
  // 担当ブロック (エコシステムとディレクトリの両方が一致するもの) を共通ヘルパーで得る
  // (絞り込みの理由は guardedBlocksOf 側に書いてある)
  const blocks = guardedBlocksOf(
    ecosystemBlocksOf(objectElementsOf(config.updates), ecosystem),
    directory,
  );
  // 該当ブロックの ignore から対象パッケージに当たるエントリをすべて集めて返す
  // (完全一致だけでなく `*` / `eslint*` のようなワイルドカードも拾う)。
  // ignore 側のリストにも空要素は書けるので、同じヘルパーで振るう
  return blocks.flatMap((block) =>
    objectElementsOf(block.ignore).filter((entry) =>
      ignoreNameMatches(entry["dependency-name"], dependencyName),
    ),
  );
}

/**
 * ロックファイルから、指定パッケージのメタデータを取り出す。
 *
 * npm のロックファイルは「巻き上げ (hoist) された `node_modules/<name>`」と
 * 「入れ子の `node_modules/<親>/node_modules/<name>`」のどちらにも書かれうるので、
 * 入れ子を優先しつつ両方を見る。
 */
export function findLockEntry(
  packages: Record<string, unknown>,
  parentName: string,
  name: string,
): Record<string, unknown> | undefined {
  // 入れ子 → 巻き上げの順に候補パスを並べる
  const candidates = [`node_modules/${parentName}/node_modules/${name}`, `node_modules/${name}`];
  // 先に見つかった方を採用する
  for (const key of candidates) {
    // その候補パスのメタデータを取り出す
    const meta = packages[key];
    // オブジェクトで書かれていれば採用
    if (typeof meta === "object" && meta !== null) return meta as Record<string, unknown>;
  }
  // どちらにも無ければ見つからなかったことを伝える
  return undefined;
}

/**
 * ロックファイルの `packages` 枝 (パッケージのパス → メタデータ) を取り出す。
 *
 * 形が違えば空オブジェクトを返し、呼び出し側が「1 つも読めなかった」ものとして
 * 落ちる方向へ倒す (fail-closed)。読み取りの入口を 1 か所に集めておくことで、
 * 下の 2 つの走査が同じ前提で動くことを保証する (§6 DRY)。
 */
export function readLockPackages(lock: unknown): Record<string, unknown> {
  // トップレベルがオブジェクトでなければ読み進めない
  if (typeof lock !== "object" || lock === null) return {};
  // packages の枝を取り出す
  const packages = (lock as { packages?: unknown }).packages;
  // それ自体がオブジェクトでなければ、やはり読み進めない
  if (typeof packages !== "object" || packages === null) return {};
  // 型を絞った参照を返す
  return packages as Record<string, unknown>;
}

/**
 * オブジェクトなら Record として、そうでなければ空オブジェクトとして返す小さな補助。
 */
export function asRecord(value: unknown): Record<string, unknown> {
  // オブジェクト以外は「キーが無い」ものとして扱う
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * ignore エントリに書かれているキーを並べ替えて返す。
 *
 * 想定外のキー (`versions` など) が増えていないかを比較するために使う。
 *
 * **要素がオブジェクトであることは呼び出し側が保証している。** 渡ってくるのは
 * collectIgnoreEntries の戻り値の要素だけで、そこは objectElementsOf を通しているため
 * null や非オブジェクトは既に振るい落とされている。ここで同じ判定を重ねても
 * 決して真にならない分岐が増えるだけなので置かない (CLAUDE.md §6 デッドコードを残さない)。
 *
 * **「要素がオブジェクトであること」と「その要素が存在すること」は別の話で、
 * 保証の強さが違うので扱いも変える。** 前者は objectElementsOf という*構築*が
 * 型のレベルで保証しており、崩す方法が無いので分岐を置かない (§6)。後者
 * (空配列への添字アクセスが undefined になること) を防いでいるのは
 * 「直前の toHaveLength(1) が先に throw する」という**文の並び順だけ**で、
 * 検査を分割・並べ替えれば簡単に崩れる。だから呼び出し側は `?? {}` を残している。
 * 一方だけ残っているのは書き忘れではなく、この差による意図的な非対称。
 */
export function sortedKeysOf(entry: DependabotIgnoreEntry): string[] {
  // キーを取り出して並べ替える (比較しやすくするため)
  return Object.keys(entry).sort();
}

/**
 * `"^9.39.4"` のようなバージョン範囲から、許容される最小の major を取り出す。
 *
 * ここで扱うのは自分たちが書いた package.json の 1 エントリだけなので、`^` / `~` / 素の数値
 * という実際に使っている形しか解釈しない。文字列でない値 (キーごと消えて undefined など) や
 * 判定できない書き方 (`>=9 <11` のような複合範囲) は null を返し、呼び出し側で「読めなかった」
 * として落とす — 読めない範囲を勝手に「9 系だろう」と決めつけると、10 系へ上げた日に
 * 検査が黙って素通りしてしまう。
 */
export function parseAllowedMajor(range: unknown): number | null {
  // 文字列でなければ解釈のしようがない (返り値の契約どおり null を返し、例外は投げない)
  if (typeof range !== "string") return null;
  // 先頭のレンジ記号 (^ または ~) を 1 つだけ許し、そのあとに major の数字が続く形に限定する
  const matched = range.trim().match(/^[\^~]?(\d+)(?:\.\d+)*$/);
  // 形が合わなければ「読めなかった」ことを呼び出し側へ伝える
  if (!matched) return null;
  // 取り出した major を数値にして返す
  return Number(matched[1]);
}

/**
 * package.json の devDependencies から、指定パッケージのバージョン範囲を取り出す。
 *
 * `JSON.parse` の戻り値は `any` になるため (CLAUDE.md §6 で禁止)、`unknown` で受けてから
 * 必要な枝だけを型で絞る。途中の形が想定と違えば undefined を返し、呼び出し側の
 * 「解釈できる形か」検査で落ちる。
 */
export function readDevDependencyRange(json: unknown, dependencyName: string): unknown {
  // トップレベルがオブジェクトでなければ読み進めない
  if (typeof json !== "object" || json === null) return undefined;
  // devDependencies の枝を取り出す
  const devDependencies = (json as { devDependencies?: unknown }).devDependencies;
  // それ自体がオブジェクトでなければ、やはり読み進めない
  if (typeof devDependencies !== "object" || devDependencies === null) return undefined;
  // 目的のパッケージのバージョン範囲を返す (無ければ undefined)
  return (devDependencies as Record<string, unknown>)[dependencyName];
}

