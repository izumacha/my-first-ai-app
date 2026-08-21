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
//
// **なぜ YAML を構文解析しないのか**:
//   YAML パーサを新規依存として足さずに済ませたい (CLAUDE.md §9「新規依存は最小限に」)。
//   一方で「YAML の形を自前で真似て読む」書き方 (インデントとクォートの並びを行単位で
//   追う方式) は最初にこの検査を書いたときに実際に破綻した: `"eslint"` を `'eslint'` に
//   書き換える・キーの順を入れ替えるといった**意味の変わらない整形**でエントリを見失い、
//   「ignore は存在しない」と誤読して (a) の検査が緑のまま素通りしてしまう。
//   そこで構造を読むのはやめ、**「eslint を名指しする ignore エントリが 1 つでも
//   書かれているか」をテキストとして見る**方式に寄せた。整形の揺れに強く、
//   どちらへ転んでも安全側 (fail-closed) に倒れる。
//
//   この単純化は「この ignore リストのエントリは eslint 1 件だけ」という前提の上に
//   成り立つ (update-types の検査をファイル全体に対して行うため)。前提が崩れたら
//   判定が意味を失うので、**前提そのものもテストで固定して落とす**。

// Vitest の DSL
import { describe, expect, it } from "vitest";
// 設定ファイルを読むため (Node 標準の同期 API で十分)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// リポジトリのルート (このテストファイルは tests/ 直下にある)
const REPO_ROOT = resolve(__dirname, "..");
// 検査対象 1: Dependabot の設定ファイル
const DEPENDABOT_PATH = resolve(REPO_ROOT, ".github/dependabot.yml");
// 検査対象 2: eslint のバージョン範囲を宣言している場所
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

// ignore の対象パッケージ名 (dependabot.yml の dependency-name と一致させる)
const GUARDED_DEPENDENCY = "eslint";
// major 更新だけを止めるための update-types 値 (Dependabot の予約語)
const MAJOR_UPDATE_TYPE = "version-update:semver-major";
// major 以外の update-types。9 系の修正が届かなくなるので書かれていてはいけない
const NON_MAJOR_UPDATE_TYPES = [
  "version-update:semver-minor",
  "version-update:semver-patch",
];
// 上流 (eslint-plugin-react) が未対応で、保留を続ける必要がある最初の major。
// package.json がこの major 以上を許すようになったら ignore は用済み
const UNSUPPORTED_MAJOR = 10;

// ignore エントリの `dependency-name:` 行からパッケージ名を取り出す正規表現。
// 整形の揺れに強くするため、次をすべて同じものとして拾う:
//   `      - dependency-name: "eslint"` / `- dependency-name: 'eslint'`
//   `        dependency-name: eslint`   (リスト項目の 2 つ目以降のキーとして書いた場合)
//   行末の `# コメント` 付き
// 逆に `#` で始まるコメント行は拾わない (コメントアウトされた ignore は効いていないため、
// 「存在しない」と読むのが正しい)。`\s*` は `#` に一致しないので自然にそうなる。
const DEPENDENCY_NAME_LINE = /^\s*(?:-\s*)?dependency-name:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm;

/**
 * dependabot.yml に書かれている ignore エントリのパッケージ名をすべて集める。
 *
 * 構造 (どのエコシステムの ignore か) は見ない。この設定ファイルで `dependency-name` を
 * 使うのは npm ブロックの ignore だけで、増えたら下の「前提」テストが落ちるため。
 */
function collectIgnoredDependencyNames(yaml: string): string[] {
  // 集めたパッケージ名を溜める配列
  const names: string[] = [];
  // 正規表現は g フラグ付きなので、matchAll で全一致を順に取り出す
  for (const match of yaml.matchAll(DEPENDENCY_NAME_LINE)) {
    // キャプチャした 1 つ目のグループがパッケージ名
    names.push(match[1]);
  }
  // 見つかった順に返す
  return names;
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

describe("dependabot.yml の ESLint major 保留", () => {
  // 設定ファイルの中身 (どのテストからも同じものを読む)
  const dependabotYaml = readFileSync(DEPENDABOT_PATH, "utf8");
  // package.json は JSON なのでそのままパースできる
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  // devDependencies に書かれている eslint のバージョン範囲 (無ければ undefined)
  const declaredRange: unknown = packageJson.devDependencies?.[GUARDED_DEPENDENCY];
  // 許容している最小 major (解釈できなければ null)
  const allowedMajor = parseAllowedMajor(declaredRange);
  // ignore に名前が挙がっているパッケージの一覧
  const ignoredNames = collectIgnoredDependencyNames(dependabotYaml);
  // eslint が ignore に挙がっているか
  const eslintIsIgnored = ignoredNames.includes(GUARDED_DEPENDENCY);

  it("package.json の eslint バージョン範囲が、このテストで解釈できる形で書かれている", () => {
    // 解釈できない書き方だと以降の判定が意味を失うので、ここで落として気付けるようにする
    // (devDependencies から eslint が消えた場合もここで落ちる)
    expect(allowedMajor).not.toBeNull();
  });

  it("ignore に載っているのは eslint だけ (update-types をファイル全体で見る前提)", () => {
    // 下の update-types 検査はファイル全体を対象にするため、エントリが増えると
    // 「どのエントリの update-types か」を取り違える。前提が崩れたら落として、
    // 判定方法ごと見直すよう促す (黙って緩めない)
    expect(ignoredNames.filter((name) => name !== GUARDED_DEPENDENCY)).toEqual([]);
    // 同じパッケージを 2 度書くのも同様に前提外
    expect(ignoredNames.length).toBeLessThanOrEqual(1);
  });

  it("eslint 9 系に留まっている間は major 更新の ignore を維持している", () => {
    // まだ上流未対応の major (10) へ上げていない = 保留が必要な状態
    if (allowedMajor === null || allowedMajor >= UNSUPPORTED_MAJOR) return;

    // ignore エントリ自体が存在すること (消されていないこと)
    expect(eslintIsIgnored).toBe(true);
    // 止める対象に major が含まれること
    expect(dependabotYaml).toContain(MAJOR_UPDATE_TYPE);
    // minor / patch まで止めると 9 系の修正が届かなくなるので、書かれていてはいけない
    for (const updateType of NON_MAJOR_UPDATE_TYPES) {
      expect(dependabotYaml).not.toContain(updateType);
    }
  });

  it("eslint 10 以上へ上げたら、用済みの ignore が残っていない", () => {
    // 上流が対応して 10 以上を許すようになった = 保留の理由が消えた状態
    if (allowedMajor === null || allowedMajor < UNSUPPORTED_MAJOR) return;

    // ここで落ちたら dependabot.yml の ignore を削除する (以後の major を止めないため)。
    // 判定は整形に左右されないテキスト一致なので、書き方を変えても見逃さない
    expect(eslintIsIgnored).toBe(false);
  });
});
