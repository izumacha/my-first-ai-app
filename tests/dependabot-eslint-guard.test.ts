// `.github/dependabot.yml` の「ESLint major 更新を保留する ignore」と、`package.json` が
// 宣言している eslint のバージョン範囲が食い違っていないことを固定するテスト。
//
// なぜテストで縛るのか:
//   この ignore は「上流のプラグイン群 (eslint-config-next が引き込む eslint-plugin-react /
//   -import / -jsx-a11y など) が ESLint 10 に未対応な間だけ」有効な
//   一時的な措置で、外す条件はコメントにしか書かれていない。人手の約束のままだと、
//   上流が対応して eslint を 10 系へ上げた日に ignore を消し忘れる。消し忘れても
//   lint も型チェックも通るので誰も気付かないまま、**その先の major (11 以降) が
//   Dependabot から二度と提案されなくなる**。「更新が来ない」は静かな壊れ方で、
//   放置された依存はセキュリティ上の負債になる (CLAUDE.md §9 依存の管理)。
//
// 何を防ぐか:
//   (a) 保留の解除漏れ … package.json が eslint 10 以上を許すようになったのに
//       ignore が残っている状態 (= 用済みのガードが以後の major を止め続ける)。
//   (b) 保留の消失 … まだ eslint 9 系に留まっているのに ignore だけ消された状態
//       (= 落ちると分かっている Dependabot PR が毎週再び立つ)。
//   (c) 保留の効きすぎ … update-types が消える・`versions` のような別の絞り込みが
//       足される・同じパッケージのエントリが 2 件になるなどで、eslint 9 系の修正まで
//       届かなくなる状態。Dependabot は update-types を書かない ignore エントリを
//       「全バージョンを無視」として扱い、かつ複数のエントリを**すべて適用する**ため、
//       行が 1 つ増減するだけで起きる。
//   (d) 保留の置き場所間違い … ignore が npm 以外のエコシステム (docker 等) や、
//       npm でも別ディレクトリのブロックの下に置かれた状態。このプロジェクトには
//       何も効かないので (b) と同じ結末になる。
//   (e) 保留の期限切れ … 上流が ESLint 10 に対応したのに保留が残り続ける状態。
//       (a) だけでは検出できない: 保留が効いている限り Dependabot は eslint 10 を
//       提案しないので package.json は 9 のまま動かず、「package.json の major を見る」
//       判定は永久に発火しない(判定が循環している)。そこで上流の peer 範囲を
//       package-lock.json から直接読み、保留の理由が消えた時点で落とす。
//       判定対象は eslint-plugin-react 1 つではなく、REQUIRED_UPSTREAM_PLUGINS に
//       明示した「同じ lint 実行に載り、eslint に peer 依存を宣言しているもの」全部
//       (現時点で 9 系に制限しているかは問わない)。1 つだけが先に対応しても
//       lint は落ちたままなので、全部が揃って初めて保留を外せる。
//
// **なぜ YAML パーサ (yaml) を使うのか**:
//   設定を自前でテキストとして読むと、この検査の本体である「YAML を正しく読む」部分が
//   近似になり、検出網が静かに緩む。実際に近似で書いたときは
//   (1) クォートの種類を変えただけでエントリを見失う、
//   (2) 解説コメント中の `version-update:semver-major` にも一致して設定行の削除を見逃す、
//   (3) エコシステムを区別できない、という穴がそれぞれ生じた。
//   yaml (ISC / 依存ゼロ / Prettier も採用) を devDependency として入れ、構造を
//   そのまま読む方式にしてある (CLAUDE.md §9「新規依存は最小限に絞って出所・メンテ状況を
//   確認する」に沿って採否を判断した)。パーサがコメントを落とすため (2) は原理的に起きず、
//   エコシステム → ignore → エントリと辿るので (3) も塞がる。

// Vitest の DSL
import { describe, expect, it } from "vitest";
// 設定ファイルを読むため (Node 標準の同期 API で十分)
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
// このファイル自身の場所を ESM の標準的な方法で求めるため。
// `__dirname` は CommonJS の変数で、いまは Vitest の互換シムのおかげで動いているだけ。
// このファイルが素の ESM として読まれた時点で ReferenceError になるので、
// 同じ用途で REPO_ROOT を組み立てている scripts/capture-*.mjs と同じ書き方に揃える
import { fileURLToPath } from "node:url";
// dependabot.yml を構造として読むため
import { parse as parseYaml } from "yaml";
// peer 範囲が特定のバージョンを許すかを正しく判定するため。
// 自前で「範囲に現れる数字の最大値」を見る方式は、`>=9.7` のような開いた範囲を
// 「9 まで」と読み違え(期限切れを見逃す)、`>=9.0.0 <10.0.0` のような上限付きを
// 「10 に言及している」と読み違える(誤って保留解除を促す)。範囲の解釈は
// 専用ライブラリに任せる (§9 自前実装しない)
import { satisfies } from "semver";

// リポジトリのルート (このテストファイルは tests/ 直下にあるので 1 つ上が repo のルート)。
// import.meta.url は「このファイルの URL」なので、それをパスへ直してから親ディレクトリを取る
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 検査対象 1: Dependabot の設定ファイル
const DEPENDABOT_PATH = resolve(REPO_ROOT, ".github/dependabot.yml");
// 検査対象 2: eslint のバージョン範囲を宣言している場所
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
// 検査対象 3: 上流プラグインの peer 範囲が解決済みで記録されている場所。
// package.json には現れない推移依存なので、ロックファイルを読む
const PACKAGE_LOCK_PATH = resolve(REPO_ROOT, "package-lock.json");

// ignore の対象パッケージ名 (dependabot.yml の dependency-name と一致させる)
const GUARDED_DEPENDENCY = "eslint";
// 保留を書いているエコシステム。ここ以外に置いても npm には効かない
const GUARDED_ECOSYSTEM = "npm";
// 保留を書いている対象ディレクトリ。npm のブロックが複数ある構成 (モノレポ等) で、
// 別ディレクトリのブロックに書かれた ignore を「効いている」と読み違えないために見る
const GUARDED_DIRECTORY = "/";
// major 更新だけを止めるための update-types 値 (Dependabot の予約語)
const MAJOR_UPDATE_TYPE = "version-update:semver-major";
// ignore エントリに書いてよいキーの一覧 (これ以外が増えると効き方が変わる)。
// 例えば `versions: [">=9.40.0"]` を足すと 9 系の更新まで止まるので、
// 「major だけを止める」という意図と実際の効き方がずれる
const ALLOWED_IGNORE_KEYS = ["dependency-name", "update-types"];
// いま eslint を留め置いている major。package.json の宣言もこの major であることを前提に、
// 「保留が要る / 用済み」を判定する。
// **上流が対応して次の major へ進んだら**、この ignore ごと削除するのが基本。
// ただし将来また別の major (11 など) で同じ足踏みが起きたときは、ignore を残したまま
// この値を新しい major へ更新する運用もありうる (下の失敗メッセージで両方を案内する)
const HELD_MAJOR = 9;
// 保留の起点になっている設定パッケージ。ここが引き込むプラグイン群が
// eslint のどこまでを許すかで、保留を外せるかどうかが決まる
const UPSTREAM_CONFIG_PACKAGE = "eslint-config-next";
// **同じ lint 実行に載り、eslint に peer 依存するルールプラグインの一覧
// (この検査が peer 範囲を見張る対象そのもの)。**
// 期限判定はここに挙げた全員が次の major を許したときだけ発火する。
//
// **「今 9 系に制限しているか」で出し入れしない — 載るなら制限の有無を問わず挙げる。**
// 現時点で eslint-plugin-react-hooks (7.1.1) の peer は
// `... || ^9.0.0 || ^10.0.0` で既に 10 を許しており、保留を実際に塞いでいるのは
// 残る 3 つ (react: `^9.7` まで / import・jsx-a11y: `^9` まで) だけ。それでも
// react-hooks を一覧に残すのは、**将来 peer が狭まったことを検出できる唯一の経路が
// ここだから**。外すと「react-hooks が 10 非対応の版へ差し替わり、同時に他の 3 つが
// 10 対応した」ときに blockingPeers が空になり、期限判定が「全部 10 を許した、
// ignore を消せ」と誤って指示する (従うと lint が壊れる)。
// 逆に一覧へ残しておけば、その版が blockingPeers に現れて保留が正しく維持される。
//
// **一覧の決め方(この規則で機械的に導ける):**
//   `eslint-config-next` の直接依存のうち、**eslint に peer 依存を宣言しているもの全部**。
//   eslint.config.mjs は core-web-vitals と typescript の両方を読み込むので、
//   同 config の直接依存はすべて同じ lint 実行に載る。
//   2026-08 時点の該当は以下 6 つ(範囲は package-lock.json の解決済み値):
//     eslint-plugin-react               ^9.7 まで   ← 保留を塞いでいる
//     eslint-plugin-import              ^9   まで   ← 保留を塞いでいる
//     eslint-plugin-jsx-a11y            ^9   まで   ← 保留を塞いでいる
//     eslint-plugin-react-hooks         ^10 を許す
//     typescript-eslint                 ^10 を許す
//     eslint-import-resolver-typescript `*`(常に充足)
//
// **peer 依存を宣言していないものはここへ入れられない。**
//   @next/eslint-plugin-next / eslint-import-resolver-node / globals は同じ lint 実行に
//   載るが peerDependencies.eslint を持たない。collectUpstreamPeers は peer 範囲が
//   文字列で書かれているものしか拾わないため、入れると upstreamPeers が一覧より
//   短いままになり、**期限判定が永久に skip され、存在確認が永久に落ちる**
//   (検出網が両方向に死ぬ)。追跡したくなったら、まず「存在確認」と「peer 範囲の評価」を
//   別の一覧に分ける設計変更が要る。
//
// **eslint.config.mjs へ直接 spread したプラグイン**は規則の外側なので、
//   この一覧と LOCALLY_ADDED_LINT_PLUGINS の両方へ足す(下のコメント参照)。
//
// 規則どおりかは下の「規則から導いた一覧と一致する」テストが機械的に照合する
// (上流が新しい制限付き依存を足したときに手で気付く必要がないようにするため)。
const REQUIRED_UPSTREAM_PLUGINS = [
  "eslint-plugin-react",
  "eslint-plugin-import",
  "eslint-plugin-jsx-a11y",
  "eslint-plugin-react-hooks",
  "typescript-eslint",
  "eslint-import-resolver-typescript",
];

// REQUIRED_UPSTREAM_PLUGINS のうち、**規則では導けない分**の受け皿。
// 判定基準は「設定パッケージの依存かどうか」であって devDependencies への記載有無ではない
// (上流のプラグインを版固定のため devDependencies に書いても、規則側で導けるのでここには不要)。
// eslint.config.mjs へ直接 spread したプラグインだけがここへ来る。
// 受け皿が無いと、それを足した瞬間に規則照合が永久に落ち、直す手段が
// 「一覧から外す」= 検出網に穴を開けることしか無くなる。
// 現在は該当なし — eslint.config.mjs は eslint-config-next の 2 つの入口だけを読む
const LOCALLY_ADDED_LINT_PLUGINS: string[] = [];

// dependabot.yml のうち、この検査が読む部分だけを表す型。
// 全項目を書き写すと設定を増やすたびに型の更新が要るので、必要な枝だけ宣言する
interface DependabotIgnoreEntry {
  "dependency-name"?: unknown;
  "update-types"?: unknown;
}
interface DependabotUpdateEntry {
  "package-ecosystem"?: unknown;
  // Dependabot は単数形の `directory` と複数形の `directories`(配列) の両方を受け付ける
  directory?: unknown;
  directories?: unknown;
  ignore?: unknown;
}
interface DependabotConfig {
  updates?: unknown;
}

/**
 * 配列でなければ空配列にして返す。
 *
 * YAML は何でも書けるので、想定した形でなければ「空」として扱い、
 * 呼び出し側の検査 (エントリが存在すること) を落とす方向へ倒す。
 */
function asArray(value: unknown): unknown[] {
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
function objectElementsOf(value: unknown): Record<string, unknown>[] {
  // 配列でなければ空配列 (= 要素なし) にしてから、要素を 1 つずつ振るう
  return asArray(value).filter(
    // null と配列を除いたオブジェクトだけを残す (typeof は null も配列も "object" と答えるため)
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

/**
 * 設定の中に「読めない形のリスト要素」がいくつあるかを数える。
 *
 * 読み飛ばしを握り潰さないための検査。**数える範囲は「この検査が実際に読む場所」に
 * 揃える** — 読まない場所の壊れを数えても、この保留の正しさとは関係が無いのに
 * eslint の保留を守る検査が無関係なエコシステムの設定まで咎めることになる。
 * 該当するのは次の 4 か所で、どれも読み手が黙って要素を捨てる。
 *
 * **範囲は「読み手が読みうる場所」を覆う向きに合わせる (厳密な一致ではなく過剰側)。**
 * 読み手には短絡があるため、ある実行で実際に触れる要素だけを厳密に写すことはできない
 * — 例えば coversDirectory は単数形の `directory` が一致した時点で true を返し、
 * `directories` を読まずに終わる。それでも `directories` は数える: 過剰に数えると
 * 「壊れていないのに落ちる」だけ (fail-closed) だが、取りこぼすと「壊れているのに緑」
 * になり、この検査の存在理由そのものが失われるため。
 * 一方で**エコシステムが違うブロックのように、どう転んでも読まない場所は数えない** —
 * eslint の保留を守る検査が無関係な設定を咎めても直し方の案内にならないので、
 * そこは絞る:
 *
 *   1. `updates` 直下 … objectElementsOf がオブジェクト以外を捨てる。
 *      全ブロックが担当判定の対象なので、全要素が読む対象。
 *   2. **エコシステムが一致するブロックの** `directories` 直下 …
 *      coversDirectory が文字列以外を捨てる。guardedBlocksOf の絞り込みは
 *      `エコシステム一致 && coversDirectory(...)` で、`&&` は短絡するため
 *      **coversDirectory が呼ばれるのはエコシステムが一致したブロックだけ**。
 *      全ブロックを数えると、読みもしない docker ブロックの空要素を
 *      eslint の保留を守る検査が咎めることになる。
 *      なお同じブロックでも、単数形の `directory` が一致していれば
 *      `directories` は実際には読まれない (上記の過剰側に倒す方針どおり数える。
 *      `directory` の書き方が変われば読まれるようになるため)。
 *      **単数形の `directory` 自体も、キーがあるのに文字列でない形 (`directory:` と
 *      値を消す等) を数える。** coversDirectory が黙って不一致にすると担当ブロックが
 *      0 件になり、(3)(4) が何も数えられなくなるうえ**保留の期限判定ごと skip され、
 *      検出網が静かに止まる**（このとき唯一赤くなる ignore 件数の検査は
 *      「別のブロックへ移された」と案内するので、原因からも遠ざかる）。
 *   3. **担当ブロックの** `ignore` 直下 … objectElementsOf がオブジェクト以外を捨てる。
 *      ignore を読むのは担当ブロック (エコシステム＋ディレクトリが一致) だけなので、
 *      ここは担当分に絞る。
 *   4. **担当ブロックの** `ignore` のうち `dependency-name` が文字列でないもの …
 *      ignoreNameMatches が文字列以外を「当たらない」として捨てる。
 *      `dependency-name: ["eslint"]` のように書き崩れたエントリが、
 *      正しいエントリの隣にあると件数が変わらず素通りする。
 *
 * 各読み手の受け入れ条件をこちら側から組み立て直す形なので、**読み手を増やしたら
 * ここにも足す**必要がある (読み手自身に「何を捨てたか」を報告させる設計なら
 * 足し忘れは起きないが、既存の 4 つの読み手すべての戻り値を変える改修になるため、
 * ここでは列挙を保ち、対応関係を上のとおり明記しておく)。
 *
 * これを検査しないと、空要素 `-` が正しいエントリの隣に増えたときに件数が変わらず、
 * 壊れた設定のまま緑になる。**Dependabot がこの形の設定をどう扱うかは
 * docs.github.com へ到達できず裏取りできていない**ので、「無害だから通してよい」とは
 * 判断せず、意図して書いた形でない時点で落とす (fail-closed)。
 */
function countUnreadableElements(
  config: DependabotConfig,
  ecosystem: string,
  directory: string,
): number {
  // (1) updates 直下: 元の要素数から、オブジェクトとして読めた数を引く
  const blocks = objectElementsOf(config.updates);
  let unreadable = asArray(config.updates).length - blocks.length;
  // (2) directory / directories: coversDirectory が呼ばれるのはエコシステムが一致した
  //     ブロックだけ (guardedBlocksOf の `&&` が短絡するため)。読む範囲に合わせて絞る
  for (const block of blocks.filter((entry) => entry["package-ecosystem"] === ecosystem)) {
    // 単数形の `directory` は「キーはあるのに文字列でない」形が書ける
    // (`directory:` と値を消す等)。coversDirectory は黙って不一致にするため、
    // 担当ブロックが 0 件になり **期限判定ごと skip されて検出網が静かに止まる**。
    // 値の消えた `directory` はここで数えて落とす
    if ("directory" in block && typeof block["directory"] !== "string") unreadable += 1;
    // 複数形の `directories` は要素ごとに文字列以外が捨てられる
    unreadable += asArray(block["directories"]).filter(
      (value) => typeof value !== "string",
    ).length;
  }
  // (3)(4) ignore 直下: 実際に読むのは担当ブロックだけなので、同じ絞り込みを通してから数える
  for (const block of guardedBlocksOf(config, ecosystem, directory)) {
    // ignore のうちオブジェクトとして読めたエントリ
    const entries = objectElementsOf(block["ignore"]);
    // (3) オブジェクトですらない要素 (空要素 `-` など) は元の要素数との差で数える
    unreadable += asArray(block["ignore"]).length - entries.length;
    // (4) オブジェクトではあるが dependency-name が文字列でないものも読み飛ばされる
    //     (ignoreNameMatches が文字列以外を「当たらない」として捨てるため)
    unreadable += entries.filter(
      (entry) => typeof entry["dependency-name"] !== "string",
    ).length;
  }
  // 合計を返す (0 なら「読む場所」に読めない要素は無い)
  return unreadable;
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
function ignoreNameMatches(pattern: unknown, dependencyName: string): boolean {
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
function coversDirectory(entry: DependabotUpdateEntry, directory: string): boolean {
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
function directoryPatternCovers(pattern: string, directory: string): boolean {
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

// 1 つの入力ファイルを読んだ結果 (解釈できた値と、読めなかったときの原因)
interface ReadResult {
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
function readParsed(path: string, parse: (text: string) => unknown): ReadResult {
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
    // 何が入っていたかを添えて原因を作る (空ファイルなら null と表示される)
    return {
      value: null,
      error: new Error(
        `トップレベルがオブジェクトではありません (${JSON.stringify(value) ?? "undefined"})。` +
          `空ファイル・全体のコメントアウト・別の形への書き換えが疑われます。`,
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
function guardedBlocksOf(
  config: DependabotConfig,
  ecosystem: string,
  directory: string,
): Record<string, unknown>[] {
  // updates 直下から、オブジェクトとして読める要素だけを取り出して絞り込む。
  // エコシステムだけで最初の 1 件を採ると、npm のブロックが複数ある構成 (モノレポ等) で
  // 別ディレクトリのブロックに書かれた ignore を、このプロジェクトに効いていると読み違える
  return objectElementsOf(config.updates).filter(
    (entry) => entry["package-ecosystem"] === ecosystem && coversDirectory(entry, directory),
  );
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
function collectIgnoreEntries(
  config: DependabotConfig,
  ecosystem: string,
  directory: string,
  dependencyName: string,
): DependabotIgnoreEntry[] {
  // 担当ブロック (エコシステムとディレクトリの両方が一致するもの) を共通ヘルパーで得る
  // (絞り込みの理由は guardedBlocksOf 側に書いてある)
  const blocks = guardedBlocksOf(config, ecosystem, directory);
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
function findLockEntry(
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

// 上流パッケージ 1 つ分の「eslint に対する peer 範囲」
interface UpstreamPeer {
  // パッケージ名 (失敗メッセージに出す)
  name: string;
  // eslint に対する peer 範囲の文字列
  range: string;
}

/**
 * ロックファイルの `packages` 枝 (パッケージのパス → メタデータ) を取り出す。
 *
 * 形が違えば空オブジェクトを返し、呼び出し側が「1 つも読めなかった」ものとして
 * 落ちる方向へ倒す (fail-closed)。読み取りの入口を 1 か所に集めておくことで、
 * 下の 2 つの走査が同じ前提で動くことを保証する (§6 DRY)。
 */
function readLockPackages(lock: unknown): Record<string, unknown> {
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
 * 指定パッケージが宣言している eslint の peer 範囲を返す (無ければ undefined)。
 *
 * **この 1 か所が「監視対象になりうるか」の唯一の判定**。下の 2 つの走査
 * (規則から導く / 一覧の範囲を集める) が同じ条件で動かないと、
 * 件数一致を見る skipIf が意味を失うため、条件をここへ集約する (§6 DRY)。
 */
function readEslintPeerRange(
  table: Record<string, unknown>,
  name: string,
): string | undefined {
  // そのパッケージのロックエントリを引く (設定パッケージ配下の入れ子 → 巻き上げの順)
  const meta = findLockEntry(table, UPSTREAM_CONFIG_PACKAGE, name);
  // 引けなければ判定できない
  if (!meta) return undefined;
  // eslint に対する peer 範囲を取り出す
  const range = asRecord(meta.peerDependencies)[GUARDED_DEPENDENCY];
  // 文字列で宣言されているものだけを採用する (宣言が無い/形が違うものは対象外)
  return typeof range === "string" ? range : undefined;
}

/**
 * 一覧の決め方(規則)をロックファイルから実際に導く。
 *
 * `eslint-config-next` の直接依存を読み、そのうち `peerDependencies.eslint` を
 * **文字列で**宣言しているものだけを返す。REQUIRED_UPSTREAM_PLUGINS はこの規則で
 * 決めると宣言しているので、宣言どおりかを機械的に照合するために使う。
 *
 * これが無いと、上流が新しく「eslint を 9 までに制限する依存」を足したときに
 * 一覧から漏れたまま気付けない。漏れた分は blockingPeers に現れないので、既存の
 * 監視対象が 10 対応した時点で期限判定が「全部そろった、ignore を消せ」と誤って指示する。
 *
 * **この repo 自身の devDependency として lint に載せたプラグインはここには現れない**
 * (設定パッケージの依存ではないため)。それらは LOCALLY_ADDED_LINT_PLUGINS 側に書く。
 *
 * 見つからない・形が違う場合は空配列を返し、呼び出し側の一致比較を落とす (fail-closed)。
 */
function deriveExpectedPlugins(lock: unknown): string[] {
  // packages 枝を共通ヘルパーで取り出す
  const table = readLockPackages(lock);
  // 設定パッケージ自身のロックエントリを引く
  const config = table[`node_modules/${UPSTREAM_CONFIG_PACKAGE}`];
  // 無ければ導けない (fail-closed)
  if (typeof config !== "object" || config === null) return [];
  // その直接依存 (名前 → 範囲) を取り出す
  const dependencies = asRecord((config as Record<string, unknown>).dependencies);
  // 直接依存のうち eslint への peer 宣言があるものだけを採る
  return Object.keys(dependencies).filter(
    (name) => readEslintPeerRange(table, name) !== undefined,
  );
}

/**
 * REQUIRED_UPSTREAM_PLUGINS に挙げたプラグインの eslint peer 範囲をロックファイルから集める。
 *
 * **ロックファイルを機械的に走査するのではなく、明示した一覧だけを見る。**
 * 「eslint に peer 依存するもの全部」を自動で拾うと、lint 実行に載らない無関係な
 * パッケージ (依存の依存など) まで数に入り、それが 9 に留まっているせいで条件を
 * 満たしても永久に発火しなくなる。何を見張るかは一覧側で明示的に決める
 * (決め方の規則は REQUIRED_UPSTREAM_PLUGINS のコメント)。
 *
 * **peer 範囲が文字列で書かれているものしか拾わない。** peerDependencies.eslint を
 * 持たないパッケージを一覧へ入れると、ここで取りこぼされて戻り値が一覧より短くなり、
 * 呼び出し側の件数一致チェックが永久に成立しなくなる (同コメントの注意書きを参照)。
 *
 * 一覧に挙げたものが見つからなければ、その分は戻り値に現れない。呼び出し側は
 * 「全員そろって読み取れたか」を別途確かめ、欠けていれば前提崩れとして落とす (fail-closed)。
 */
function collectUpstreamPeers(lock: unknown): UpstreamPeer[] {
  // packages 枝を共通ヘルパーで取り出す
  const table = readLockPackages(lock);
  // 集めた peer 範囲を溜める配列
  const peers: UpstreamPeer[] = [];
  // 明示した一覧だけを順に見ていく
  for (const name of REQUIRED_UPSTREAM_PLUGINS) {
    // eslint への peer 範囲を共通ヘルパーで読む (判定条件は 1 か所に集約)
    const range = readEslintPeerRange(table, name);
    // 宣言が無い / 読めないものは戻り値に含めない (呼び出し側の存在確認で落ちる)
    if (range === undefined) continue;
    // 読めた範囲を採用する
    peers.push({ name, range });
  }
  // 見つかった分を返す
  return peers;
}

/**
 * パッケージ名の一覧を比較用に正規化する (並び順は意味を持たないので揃える)。
 *
 * skipIf の判定 (sameNameSet) と規則照合テストの `toEqual` が**同じ正規化**を通ることで、
 * 片方だけ条件が変わって「skip されるのに落ちない / 落ちるのに skip されない」という
 * 食い違いが起きないようにする (§6 DRY)。
 */
function sortedNames(names: readonly string[]): string[] {
  // 元の配列を壊さないよう複製してから並べ替える
  return [...names].sort();
}

/**
 * 2 つのパッケージ名一覧が「集合として」一致するかを返す。
 *
 * 期限判定を走らせてよいか (= 一覧が規則どおりか) の判断に使う。
 */
function sameNameSet(left: readonly string[], right: readonly string[]): boolean {
  // 先に件数で振るう (違えば中身を見るまでもない)
  if (left.length !== right.length) return false;
  // 同じ正規化を通してから 1 要素ずつ突き合わせる
  const sortedRight = sortedNames(right);
  return sortedNames(left).every((name, index) => name === sortedRight[index]);
}

/**
 * オブジェクトなら Record として、そうでなければ空オブジェクトとして返す小さな補助。
 */
function asRecord(value: unknown): Record<string, unknown> {
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
function sortedKeysOf(entry: DependabotIgnoreEntry): string[] {
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
function parseAllowedMajor(range: unknown): number | null {
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
function readDevDependencyRange(json: unknown, dependencyName: string): unknown {
  // トップレベルがオブジェクトでなければ読み進めない
  if (typeof json !== "object" || json === null) return undefined;
  // devDependencies の枝を取り出す
  const devDependencies = (json as { devDependencies?: unknown }).devDependencies;
  // それ自体がオブジェクトでなければ、やはり読み進めない
  if (typeof devDependencies !== "object" || devDependencies === null) return undefined;
  // 目的のパッケージのバージョン範囲を返す (無ければ undefined)
  return (devDependencies as Record<string, unknown>)[dependencyName];
}

describe("dependabot.yml の ESLint major 保留", () => {
  // 3 つの入力を、例外を投げない形で読む (理由は readParsed の docstring)。
  // Dependabot 設定は構造として読む (コメントはパーサが落とすので検査に混ざらない)
  const dependabotRead = readParsed(DEPENDABOT_PATH, parseYaml);
  // package.json (eslint のバージョン範囲の宣言もと)
  const packageJsonRead = readParsed(PACKAGE_JSON_PATH, JSON.parse);
  // ロックファイル (上流プラグイン群の peer 範囲を読むため)
  const packageLockRead = readParsed(PACKAGE_LOCK_PATH, JSON.parse);
  // 読めなかったファイルだけを、原因付きで集める (下の専用テストが報告する)。
  // 表示名はパス定数から導く — 文字列で書き写すと、定数を変えたときに
  // 「読んでいるファイル」と「文言が名指しするファイル」がずれる (§6 一元管理)
  const unreadableSources = [
    { path: DEPENDABOT_PATH, error: dependabotRead.error },
    { path: PACKAGE_JSON_PATH, error: packageJsonRead.error },
    { path: PACKAGE_LOCK_PATH, error: packageLockRead.error },
  ]
    // 読めたものは報告対象から外す
    .filter((source) => source.error !== null)
    // 失敗文言に載せるため、repo ルートからの相対パスと原因を組み立てる
    .map((source) => `${relative(REPO_ROOT, source.path)}: ${String(source.error)}`);
  // **パース結果は null にもなる** — 空ファイルや、全体をコメントアウトしたファイルが該当する
  // (どちらも実測済み)。null のまま枝を読むと TypeError で全検査が収集時エラーになる。
  // asRecord でオブジェクトへ均しておけば、updates が空として扱われ、
  // 「ignore がちょうど 1 件」の検査が本来の文言で落ちる (fail-closed)
  const dependabotConfig: DependabotConfig = asRecord(dependabotRead.value);
  // package.json は unknown で受けてから必要な枝だけ絞る
  const packageJson: unknown = packageJsonRead.value;
  // ロックファイルも同様
  const packageLock: unknown = packageLockRead.value;
  // devDependencies に書かれている eslint のバージョン範囲 (無ければ undefined)
  const declaredRange = readDevDependencyRange(packageJson, GUARDED_DEPENDENCY);
  // 許容している最小 major (解釈できなければ null)
  const allowedMajor = parseAllowedMajor(declaredRange);
  // この検査が実際に読む場所に、読めないリスト要素がいくつあるか (0 が正常)。
  // 絞り込み条件は collectIgnoreEntries と同じものを渡す
  const unreadableElementCount = countUnreadableElements(
    dependabotConfig,
    GUARDED_ECOSYSTEM,
    GUARDED_DIRECTORY,
  );
  // npm エコシステムの ignore にある eslint のエントリ (複数書かれていればすべて)
  const ignoreEntries = collectIgnoreEntries(
    dependabotConfig,
    GUARDED_ECOSYSTEM,
    GUARDED_DIRECTORY,
    GUARDED_DEPENDENCY,
  );

  // ロックファイルに記録されている上流プラグイン群の peer 範囲
  const upstreamPeers = collectUpstreamPeers(packageLock);
  // 規則 (設定パッケージの直接依存 ＋ repo 固有分) から導いた「見張るべき一覧」
  const derivedPlusLocal = [...deriveExpectedPlugins(packageLock), ...LOCALLY_ADDED_LINT_PLUGINS];
  // 一覧が規則どおりか。ずれているなら「見張るべきなのに見張れていない」ものが居る。
  // 下の規則照合テストと同じ正規化 (sortedNames) を通すので、判定が食い違わない
  const pluginListMatchesRule = sameNameSet(derivedPlusLocal, REQUIRED_UPSTREAM_PLUGINS);
  // 留め置きを外せるかの判定に使う「次の major」の代表バージョン
  const nextMajorVersion = `${HELD_MAJOR + 1}.0.0`;
  // 次の major をまだ許していない上流 (= 保留の理由として残っているもの)
  const blockingPeers = upstreamPeers.filter((peer) => !satisfies(nextMajorVersion, peer.range));

  it("検査に使う 3 つの入力ファイルが読めて、構造として解釈できる", () => {
    // 読み取り・パースで例外が出ていないこと。落ちる代表例は
    // ファイルごと削除・改名された (ENOENT) か、キーの重複やマージ事故で
    // 壊れている (YAMLParseError / SyntaxError) 場合。
    // 複数が同時に壊れることもあるので、1 件ずつではなくまとめて報告する。
    // 例外の内容をそのまま文言に載せて、原因の切り分けを読み手に渡す
    expect(
      unreadableSources,
      `検査に使う入力ファイルを読めませんでした: ${unreadableSources.join(" / ")}。` +
        `削除・改名されていないか、YAML / JSON として壊れていないかを確認してください。` +
        `${relative(REPO_ROOT, DEPENDABOT_PATH)} が消えている場合は ` +
        `${GUARDED_DEPENDENCY} の major 保留も一緒に消えており、` +
        `${relative(REPO_ROOT, PACKAGE_LOCK_PATH)} が読めない場合は ` +
        `上流プラグインの peer 範囲を評価できません` +
        `(どちらもこのファイルの検査対象そのものなので、ここで止めて他の検査に` +
        `誤った前提で判断させないようにしています)。`,
    ).toEqual([]);
  });

  // 入力そのものが読めていないときは対象外 (skip として CI の出力にも現れる)。
  // 空ファイルや削除で dependabotConfig が {} に均された状態でこの検査を走らせると、
  // 「読めない要素は 0 個」と**中身の無いファイルに対して緑**になり、
  // 直前のテストが赤いのに「設定は健全」と読める出力が並んでしまう。
  // 評価できないことは skip で示し、原因の報告は直前のテストに任せる
  it.skipIf(unreadableSources.length > 0)(
    ".github/dependabot.yml に読めない形のリスト要素が無い",
    () => {
      // 空要素 `-` (ブロックをコメントアウトした残り) が混ざっていないかを見る。
      // この検査が無いと、正しいエントリの**隣**に空要素が増えたケースで
      // ignore の件数が変わらず、壊れた設定のまま全検査が緑になる。
      // 読み手側 (このテスト) が黙って読み飛ばすようになった分、
      // 「意図して書いた形か」は独立した検査で担保する
      expect(
        unreadableElementCount,
        `${relative(REPO_ROOT, DEPENDABOT_PATH)} のうち、この検査が実際に読む場所` +
          `(updates 直下 / ${GUARDED_ECOSYSTEM} ブロックの directory・directories / ` +
          `${GUARDED_ECOSYSTEM}・${GUARDED_DIRECTORY} ブロックの ignore 直下と、` +
          `その dependency-name が文字列であること) に、` +
          `想定した形で書かれていない箇所が ${unreadableElementCount} 個あります。` +
          `ブロックをコメントアウトしたときに残った空要素 \`-\`、値を消した \`directory:\`、` +
          `\`dependency-name: ["eslint"]\` のような書き崩れが典型です。` +
          `この検査はそれを読み飛ばすので、放置すると設定が壊れたまま他の検査が緑になります` +
          `(とくに \`directory\` が読めないと担当ブロックが 0 件になり、` +
          `保留の期限判定ごと skip されて検出網が静かに止まります)。` +
          `(Dependabot 側がこの形をどう扱うかはこの環境から裏取りできていないため、` +
          `無害と決めつけず意図した形でない時点で落としています)。`,
      ).toBe(0);
    },
  );

  it("package.json の eslint バージョン範囲が、このテストで解釈できる形で書かれている", () => {
    // ここが落ちると、下の構造検査とダウングレード検査が skip され、
    // ignore の削除・重複を捕まえる網まで黙って無効になる。何を直せばよいかを明示する
    expect(
      allowedMajor,
      `package.json の devDependencies.${GUARDED_DEPENDENCY} を、` +
        // 書式例の major は留め置き中の major に追随させる。ここだけ数字を直書きすると、
        // HELD_MAJOR を新しい major へ更新し直したときに例だけ古い数字のまま残り、
        // 「^11 と書いてあるのに ^9 にしろと言われた」という誤解を生む
        `\`^${HELD_MAJOR}.39.4\` のような「先頭に ^ か ~ が 1 つ、あとは数字とドット」の形で書いてください` +
        `(現在の値: ${JSON.stringify(declaredRange)})。` +
        `dependencies へ移した・キーごと消した場合もここで落ちます。` +
        `この検査が落ちている間は ignore の削除・重複を見張る検査が skip され、` +
        `検出網が無効になります。`,
    ).not.toBeNull();
  });

  it("REQUIRED_UPSTREAM_PLUGINS が規則から導いた一覧と一致する", () => {
    // 規則 (eslint-config-next の直接依存のうち eslint に peer 依存を宣言しているもの) を
    // ロックファイルから実際に導く
    // 規則から導いた一覧が「正」。手書きの REQUIRED_UPSTREAM_PLUGINS を received 側に
    // 置くことで、Vitest の差分が「期待 = 規則 / 実際 = 手書き」の向きで表示される
    // (逆にすると、古い手書きの一覧が正であるかのように読めてしまう)
    const expected = sortedNames(derivedPlusLocal);
    // 並び順は意味を持たないので、両方を並べ替えてから比較する
    expect(
      sortedNames(REQUIRED_UPSTREAM_PLUGINS),
      `REQUIRED_UPSTREAM_PLUGINS が規則からずれています。` +
        `規則は「${UPSTREAM_CONFIG_PACKAGE} の直接依存のうち ${GUARDED_DEPENDENCY} に ` +
        `peer 依存を宣言しているもの全部 ＋ LOCALLY_ADDED_LINT_PLUGINS」で、` +
        `規則から導けるのは [${expected.join(", ") || "なし"}]、` +
        `一覧に書かれているのは [${sortedNames(REQUIRED_UPSTREAM_PLUGINS).join(", ")}]。` +
        `**一覧に足りないものがあるなら、そのパッケージは lint 実行に載るのに ` +
        `見張られていません** — 9 系に留まったまま他が 10 対応すると、期限判定が誤って ` +
        `保留解除を促します(そのため一覧がずれている間、期限判定は skip されます)。` +
        `上流の依存構成が変わったなら REQUIRED_UPSTREAM_PLUGINS を合わせてください。` +
        `${UPSTREAM_CONFIG_PACKAGE} の依存ではなく eslint.config.mjs へ直接載せた ` +
        `プラグインなら、REQUIRED_UPSTREAM_PLUGINS と LOCALLY_ADDED_LINT_PLUGINS の ` +
        `両方へ足すと一致します。` +
        `**一覧の増減は .github/dependabot.yml と CLAUDE.md §3 の説明にも反映してください** ` +
        `(そちらは機械検査が無いので、直さないとコードと説明が食い違ったまま残ります)。`,
    ).toEqual(expected);
  });

  // 上の規則照合と重なる部分はあるが、独立した意味がある:
  //   - LOCALLY_ADDED_LINT_PLUGINS の分は規則からは導けないので、そちらが
  //     ロックファイルから読めなくなったことはこの検査でしか分からない。
  //   - 期限判定の skip 条件 (件数一致) が拠り所にしているのはこの検査の文言なので、
  //     「なぜ skip されたか」を専用のメッセージで示す役割も持つ。
  it("保留の理由になっている上流プラグインが、すべてロックファイルから読み取れる", () => {
    // 走査で拾えたパッケージ名の一覧
    const found = upstreamPeers.map((peer) => peer.name);
    // 一覧に挙げたのに走査から漏れたものを**全部**集める。
    // 1 件ずつ expect すると最初の 1 件で例外が飛び、残りは出力に現れない。
    // 「複数が同時に消えること」こそこの検査が警戒している前提崩れなので、
    // 差集合を 1 回だけ比較して全件を一度に見せる (1 件ずつ直して再実行させない)
    const missing = REQUIRED_UPSTREAM_PLUGINS.filter((plugin) => !found.includes(plugin));
    // 実際に eslint を制限しているプラグインが 1 つでも走査から外れると、
    // 残った緩い peer だけを見て「全員が次の major を許した」と誤読しうる。
    // 上流の依存構成が変わったなら、保留の前提ごと見直す合図として落とす
    expect(
      missing,
      `${UPSTREAM_CONFIG_PACKAGE} 配下の eslint peer 依存として見つからないものがあります: ` +
        `[${missing.join(", ")}]` +
        `(見つかったのは ${found.join(", ") || "なし"})。依存構成が変わったなら、` +
        `REQUIRED_UPSTREAM_PLUGINS と保留の前提を見直してください。`,
    ).toEqual([]);
  });

  // 次のどちらかなら、この検査は対象外 (skip として CI の出力にも現れる):
  //   - 保留そのものが無い … 上流が出揃って ignore を消したあと、このテストだけが
  //     赤く残り続けて「もう存在しない ignore を消せ」と言い続ける状態を避ける
  //   - 上流を 1 つでも読み取れていない … 前提が崩れているだけなのに blockingPeers が空になり、
  //     「全員が許した」と読める文言で保留の削除を促してしまう。前提崩れは
  //     直前の「上流プラグインがすべて読み取れる」テストが専用の文言で落とす役割
  //
  // **判定は「1 つも読めない」ではなく「全員そろって読めたか」で行う。** `=== 0` だと
  // 部分的にしか読めていないとき(例: 既に 10 を許しているものだけが読め、実際に
  // 制限しているものがロックファイルの想定パスから消えた場合)に skip されず、
  // blockingPeers が空になって「すべてが eslint 10 を許すようになりました … ignore を
  // 削除してください」という**事実と異なる指示**が出る。直前の存在確認も同時に落ちるので
  // CI 自体は赤のままだが、2 つの失敗のうち誤った方に従って ignore を消すと eslint 10 が
  // 入り、contextOrFilename.getFilename is not a function で lint が壊れる。
  // collectUpstreamPeers は REQUIRED_UPSTREAM_PLUGINS ぶんしか走査しないので、
  // 全員そろった状態は「件数が一覧の長さと一致すること」で表せる。
  //
  // **一覧そのものが規則からずれているときも判定しない (pluginListMatchesRule)。**
  // 件数一致は「一覧に挙げた分が全部読めたか」しか見ておらず、**一覧に挙げ忘れている**
  // ものは検知できない。上流が「eslint を 9 に制限する直接依存」を新設し、既存の
  // 監視対象が全部 10 対応した場合、upstreamPeers は一覧どおり全部読めるので件数は
  // 一致し、blockingPeers は空になって「全部 10 を許した、ignore を消せ」と誤指示する
  // (新設分は走査対象外なので blockingPeers に現れない)。規則照合テストも同時に落ちるが、
  // 2 つの失敗のうち誤った方に従うと lint が壊れるのは部分読み取りのときと同じ。
  // ずれているあいだは「まだ判定できない」として skip し、規則照合テスト側の
  // 専用メッセージに任せる
  it.skipIf(
    ignoreEntries.length === 0 ||
      upstreamPeers.length !== REQUIRED_UPSTREAM_PLUGINS.length ||
      !pluginListMatchesRule,
  )(
    "上流がまだ次の major に対応していない (= 保留の理由が残っている)",
    () => {
      // 上流のどれか 1 つでも次の major を許していなければ、保留はまだ必要。
      // **全部が許すようになって初めて**保留を外せる — eslint-plugin-react だけが
      // 先に対応しても、同じ lint 実行に載る他のプラグインが 9 までに制限したままなら
      // lint は落ちるため
      // (react-hooks / typescript-eslint / eslint-import-resolver-typescript は現時点で
      //  既に 10 を許しているが、将来狭まる可能性があるので判定対象からは外さない。
      //  理由は REQUIRED_UPSTREAM_PLUGINS のコメント)。
      // ここで落ちたら「上流が出揃った」合図。ignore を外して major 更新を取りにいく
      // (この検査が無いと、保留が効いている限り package.json は 9 のまま動かず、
      //  package.json の major を見る判定が永久に発火しないという循環に陥る)
      expect(
        blockingPeers.map((peer) => peer.name),
        // 「配下のすべて」とは書かない — 実際に見たのは REQUIRED_UPSTREAM_PLUGINS に
        // 挙げた分だけで、peer 依存を宣言していないもの(@next/eslint-plugin-next 等)は
        // そもそも走査できていない。評価した対象を明示しないと、読み手が
        // 「もう何も確認せず ignore を消してよい」と受け取ってしまう。
        // `*` のような常に充足する範囲は「10 に対応した」という表明ではないので、
        // 対応の根拠として並べず、未表明であることが分かる印を付ける
        `${UPSTREAM_CONFIG_PACKAGE} 配下の監視対象プラグイン` +
          `(${REQUIRED_UPSTREAM_PLUGINS.length} 件)がすべて eslint ${nextMajorVersion} を許すようになりました` +
          `(${upstreamPeers
            .map(
              (peer) =>
                `${peer.name}: ${peer.range}${
                  // どんな版でも充足する範囲は互換性を何も述べていない。
                  // 読み手が「このパッケージも 10 対応済み」と誤読しないよう注記する
                  satisfies("0.0.0", peer.range) ? " ※常に充足。10 対応の表明ではない" : ""
                }`,
            )
            .join(", ")})。` +
          `peer 依存を宣言していないプラグイン(@next/eslint-plugin-next 等)は` +
          `この判定に含まれていないので、削除前に別途確認してください。` +
          `.github/dependabot.yml の ignore とこのテストを削除し、eslint の major 更新を` +
          `取り込んでください。`,
      ).not.toHaveLength(0);
    },
  );

  // 留め置き中でなければ、この検査は対象外 (skip として CI の出力にも現れる)
  it.skipIf(allowedMajor !== HELD_MAJOR)(
    "留め置いている major に居る間は、major 更新の ignore を 1 件だけ維持している",
    () => {
      // npm エコシステムの ignore にエントリが「ちょうど 1 件」あること。
      // 消された場合・docker など別エコシステムへ移された場合はもちろん、
      // 2 件目 (ワイルドカード `*` を含む) が足された場合もここで落ちる
      // (Dependabot は複数の条件をすべて適用するため、update-types 無しのエントリが
      //  1 件混ざるだけで全バージョンが止まる)
      expect(
        ignoreEntries,
        `${GUARDED_ECOSYSTEM} / ${GUARDED_DIRECTORY} のブロックに ` +
          `${GUARDED_DEPENDENCY} の ignore がちょうど 1 件ある状態を保ってください。` +
          `0 件なら削除されたか、別エコシステム(docker 等)・別ディレクトリのブロックへ` +
          `移されています。2 件以上なら Dependabot が両方を適用し、意図より広く止まります。` +
          `この保留が要る理由は .github/dependabot.yml のコメントと CLAUDE.md `+
          `§3「テスト」節の eslint 留め置きの項を参照 (消すと lint が ` +
          `contextOrFilename.getFilename is not a function で落ちます)。`,
      ).toHaveLength(1);
      // 名前が eslint そのものであること。`*` へ**書き換えられた**場合、
      // 件数も update-types もキー集合も想定どおりのまま素通りしてしまうが、
      // 実際には npm の全パッケージの major 更新が止まる (next / prisma / react …)
      expect(ignoreEntries[0]?.["dependency-name"]).toBe(GUARDED_DEPENDENCY);
      // 止める対象は major だけ。update-types ごと消えると Dependabot は
      // 「全バージョンを無視」と解釈し、9 系の修正まで届かなくなる
      expect(ignoreEntries[0]?.["update-types"]).toEqual([MAJOR_UPDATE_TYPE]);
      // 書かれているキーがちょうど想定どおりであること。`versions` のような
      // 別の絞り込みが足されると、update-types が正しくても効き方が変わってしまう
      // 直前の件数検査が通っていれば [0] は必ずあるが、上の 2 行と同じく
      // 添字アクセスを無防備に置かない (検査の順序を入れ替えたときに
      // Object.keys(undefined) の TypeError で日本語文言が消えるのを防ぐ)。
      // sortedKeysOf 側が保証しているのは「要素がオブジェクトであること」だけで、
      // 「要素が存在すること」はここで埋める必要がある (同関数の docstring 参照)
      expect(sortedKeysOf(ignoreEntries[0] ?? {})).toEqual([...ALLOWED_IGNORE_KEYS].sort());
    },
  );

  // 留め置き中・解釈できない範囲のときは対象外 (skip として CI の出力にも現れる)
  it.skipIf(allowedMajor === null || allowedMajor <= HELD_MAJOR)(
    "留め置いている major から先へ進んだら、用済みの ignore が残っていない",
    () => {
      // ここで落ちたときの直し方は 2 通りある。どちらが正しいかは「なぜ major を
      // 上げたのか」で決まるので、片方だけを指示せず両方を示す:
      //   (1) 上流が対応して保留の理由が消えたのなら → dependabot.yml の ignore と
      //       このテストごと削除する (以後の major を止めないため)
      //   (2) 次の major (11 など) でまた上流が足踏みしていて、新しい major で
      //       留め置き直すのなら → HELD_MAJOR をその major へ更新する
      // 判定は構文解析の結果なので、クォートの種類やキーの順といった整形では揺れない
      expect(
        ignoreEntries,
        `eslint が major ${HELD_MAJOR} から ${allowedMajor} へ動いています。` +
          `保留が不要になったなら ignore とこのテストを削除し、` +
          `新しい major で留め置き直すなら HELD_MAJOR を ${allowedMajor} へ更新してください。` +
          `後者を選ぶ場合、major の数字を書いている散文 — .github/dependabot.yml の` +
          `ignore コメントと CLAUDE.md の該当節 — も同じ変更に含めてください` +
          `(機械検査が無いので、直さないとコードと説明が食い違ったまま残ります)。`,
      ).toHaveLength(0);
    },
  );

  // 解釈できない範囲のときは対象外 (最初のテストが落とすので二重に赤くしない)
  it.skipIf(allowedMajor === null)("留め置いている major より下へは戻っていない", () => {
    // ダウングレードは想定していない。起きたなら HELD_MAJOR との対応が崩れているので、
    // 保留の判定そのものを見直す合図として落とす
    expect(allowedMajor).toBeGreaterThanOrEqual(HELD_MAJOR);
  });
});
