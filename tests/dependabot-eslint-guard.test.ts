// `.github/dependabot.yml` の「ESLint major 更新を保留する ignore」と、`package.json` が
// 宣言している eslint のバージョン範囲が食い違っていないことを固定するテスト。
//
// なぜテストで縛るのか:
//   この ignore は「上流 (eslint-plugin-react) が ESLint 10 に未対応な間だけ」有効な
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
//   (d) 保留の置き場所間違い … ignore が npm 以外のエコシステム (docker 等) の下に
//       置かれた状態。npm には何も効かないので (b) と同じ結末になる。
//
// **なぜ YAML パーサ (yaml) を devDependency として入れたのか**:
//   最初はパーサを足さずに済ませようと自前でテキストを読んでいたが、2 通り試して
//   どちらも正確性の穴を作った:
//     1 回目 (行の形を追う方式) … `"eslint"` を `'eslint'` に書き換えるだけの
//        意味の変わらない整形でエントリを見失い、(a) の検査が緑のまま素通りした。
//     2 回目 (ファイル全体をテキスト一致で見る方式) … コメント文中の
//        `version-update:semver-major` にも一致してしまい、設定行が消えても
//        検査が通る (c) の穴と、エコシステムを区別できない (d) の穴が残った。
//   「YAML を正しく読む」ことがこの検査の本体である以上、それを近似で済ませると
//   検出網そのものが静かに緩む。yaml (ISC / 依存ゼロ / Prettier も採用) を
//   devDependency として入れ、構造をそのまま読む方式に切り替えた
//   (CLAUDE.md §9「新規依存は最小限に絞って出所・メンテ状況を確認する」)。
//   これでコメントは解析時に落ち、エコシステム・エントリ単位で正確に見られる。

// Vitest の DSL
import { describe, expect, it } from "vitest";
// 設定ファイルを読むため (Node 標準の同期 API で十分)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// dependabot.yml を構造として読むため
import { parse as parseYaml } from "yaml";

// リポジトリのルート (このテストファイルは tests/ 直下にある)
const REPO_ROOT = resolve(__dirname, "..");
// 検査対象 1: Dependabot の設定ファイル
const DEPENDABOT_PATH = resolve(REPO_ROOT, ".github/dependabot.yml");
// 検査対象 2: eslint のバージョン範囲を宣言している場所
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

// ignore の対象パッケージ名 (dependabot.yml の dependency-name と一致させる)
const GUARDED_DEPENDENCY = "eslint";
// 保留を書いているエコシステム。ここ以外に置いても npm には効かない
const GUARDED_ECOSYSTEM = "npm";
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

// dependabot.yml のうち、この検査が読む部分だけを表す型。
// 全項目を書き写すと設定を増やすたびに型の更新が要るので、必要な枝だけ宣言する
interface DependabotIgnoreEntry {
  "dependency-name"?: unknown;
  "update-types"?: unknown;
}
interface DependabotUpdateEntry {
  "package-ecosystem"?: unknown;
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
  dependencyName: string,
): DependabotIgnoreEntry[] {
  // updates 直下から目的のエコシステムのブロックを探す
  const block = asArray(config.updates)
    .map((entry) => entry as DependabotUpdateEntry)
    .find((entry) => entry["package-ecosystem"] === ecosystem);
  // ブロックが無ければ ignore も無い
  if (!block) return [];
  // そのブロックの ignore から対象パッケージのエントリをすべて集めて返す
  return asArray(block.ignore)
    .map((entry) => entry as DependabotIgnoreEntry)
    .filter((entry) => entry["dependency-name"] === dependencyName);
}

/**
 * ignore エントリに書かれているキーを並べ替えて返す。
 *
 * 想定外のキー (`versions` など) が増えていないかを比較するために使う。
 * オブジェクトでなければ空配列を返し、呼び出し側の比較を落とす方向へ倒す。
 */
function sortedKeysOf(entry: DependabotIgnoreEntry): string[] {
  // オブジェクトでなければキーを数えようがない
  if (typeof entry !== "object" || entry === null) return [];
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
 * 必要な枝だけを型で絞る。キー名を書き間違えても静かに undefined にならないよう、
 * 途中の形が想定と違えば undefined を返し、呼び出し側の「解釈できる形か」検査で落ちる。
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
  // Dependabot 設定を構造として読む (コメントはパーサが落とすので検査に混ざらない)
  const dependabotConfig = parseYaml(readFileSync(DEPENDABOT_PATH, "utf8")) as DependabotConfig;
  // package.json も同様に unknown で受けてから絞る
  const packageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  // devDependencies に書かれている eslint のバージョン範囲 (無ければ undefined)
  const declaredRange = readDevDependencyRange(packageJson, GUARDED_DEPENDENCY);
  // 許容している最小 major (解釈できなければ null)
  const allowedMajor = parseAllowedMajor(declaredRange);
  // npm エコシステムの ignore にある eslint のエントリ (複数書かれていればすべて)
  const ignoreEntries = collectIgnoreEntries(
    dependabotConfig,
    GUARDED_ECOSYSTEM,
    GUARDED_DEPENDENCY,
  );

  it("package.json の eslint バージョン範囲が、このテストで解釈できる形で書かれている", () => {
    // 解釈できない書き方だと以降の判定が意味を失うので、ここで落として気付けるようにする
    // (devDependencies から eslint が消えた場合もここで落ちる)
    expect(allowedMajor).not.toBeNull();
  });

  it("留め置いている major に居る間は、major 更新の ignore を 1 件だけ維持している", () => {
    // 留め置いている major から動いていない = 保留が必要な状態
    if (allowedMajor !== HELD_MAJOR) return;

    // npm エコシステムの ignore にエントリが「ちょうど 1 件」あること。
    // 消された場合・docker など別エコシステムへ移された場合はもちろん、
    // 2 件目が足された場合もここで落ちる (Dependabot は複数の条件をすべて適用するため、
    // update-types 無しのエントリが 1 件混ざるだけで全バージョンが止まる)
    expect(ignoreEntries).toHaveLength(1);
    // 止める対象は major だけ。update-types ごと消えると Dependabot は
    // 「全バージョンを無視」と解釈し、9 系の修正まで届かなくなる
    expect(ignoreEntries[0]?.["update-types"]).toEqual([MAJOR_UPDATE_TYPE]);
    // 書かれているキーがちょうど想定どおりであること。`versions` のような
    // 別の絞り込みが足されると、update-types が正しくても効き方が変わってしまう
    expect(sortedKeysOf(ignoreEntries[0])).toEqual([...ALLOWED_IGNORE_KEYS].sort());
  });

  it("留め置いている major から先へ進んだら、用済みの ignore が残っていない", () => {
    // 留め置き中、または解釈できない範囲のときは、このテストの出番ではない
    if (allowedMajor === null || allowedMajor <= HELD_MAJOR) return;

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
        `新しい major で留め置き直すなら HELD_MAJOR を ${allowedMajor} へ更新してください。`,
    ).toHaveLength(0);
  });

  it("留め置いている major より下へは戻っていない", () => {
    // 解釈できない範囲のときは、このテストの出番ではない (上のテストが落とす)
    if (allowedMajor === null) return;

    // ダウングレードは想定していない。起きたなら HELD_MAJOR との対応が崩れているので、
    // 保留の判定そのものを見直す合図として落とす
    expect(allowedMajor).toBeGreaterThanOrEqual(HELD_MAJOR);
  });
});
