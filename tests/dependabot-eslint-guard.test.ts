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
// dependabot.yml を構造として読むため
import { parse as parseYaml } from "yaml";
// peer 範囲が特定のバージョンを許すかを正しく判定するため。
// 自前で「範囲に現れる数字の最大値」を見る方式は、`>=9.7` のような開いた範囲を
// 「9 まで」と読み違え(期限切れを見逃す)、`>=9.0.0 <10.0.0` のような上限付きを
// 「10 に言及している」と読み違える(誤って保留解除を促す)。範囲の解釈は
// 専用ライブラリに任せる (§9 自前実装しない)
import { satisfies } from "semver";
// 設定ファイルの「読み方」と、検査対象のパス・Dependabot の語彙は
// tests/node-runtime-alignment.test.ts と共有する (§6 DRY / 定数の一元管理)。
// 書き写すと、Dependabot の仕様に合わせた配慮 (directories の複数形・glob、
// dependency-name のワイルドカード、複数エントリがすべて適用されること) を直したときに
// 片方だけが古い読み方のまま残り、そちらの検出網が静かに緩む
import {
  ALLOWED_IGNORE_KEYS,
  asRecord,
  collectIgnoreEntries,
  countUnreadableElements,
  DEPENDABOT_PATH,
  describeReadError,
  directoryPatternCovers,
  displayPath,
  findLockEntry,
  MAJOR_UPDATE_TYPE,
  NPM_DIRECTORY,
  NPM_ECOSYSTEM,
  PACKAGE_JSON_PATH,
  PACKAGE_LOCK_PATH,
  parseAllowedMajor,
  readDevDependencyRange,
  readLockPackages,
  readParsed,
  REPO_ROOT,
  sortedKeysOf,
  type DependabotConfig,
} from "./lib/dependabot-config";

// ignore の対象パッケージ名 (dependabot.yml の dependency-name と一致させる)
const GUARDED_DEPENDENCY = "eslint";
// 保留を書いているエコシステム / 対象ディレクトリ。ここ以外に置いても npm には効かない。
// 値そのものは共有ヘルパー側が持つ (この検査と Node のピン留めを見張る検査で同じ値を
// 別々に書き写していると、npm ブロックの directory を変えたときに片方だけ直される)
const GUARDED_ECOSYSTEM = NPM_ECOSYSTEM;
const GUARDED_DIRECTORY = NPM_DIRECTORY;
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

// 上流パッケージ 1 つ分の「eslint に対する peer 範囲」
interface UpstreamPeer {
  // パッケージ名 (失敗メッセージに出す)
  name: string;
  // eslint に対する peer 範囲の文字列
  range: string;
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

// 「そろって許している major の上限」を探すときの打ち切り幅。
// `*` のような常に充足する範囲が混ざると上限が無くなるので、ここで止める。
// 到達したこと自体を呼び出し側が「上限なし」として扱う
const MAJOR_PROBE_SPAN = 30;

/**
 * 監視対象の peer 範囲が「そろって許している major」の上限を返す。
 *
 * `from` から 1 つずつ上へ試し、全員が許す限り進める。`from` を 1 つでも許さない者が
 * いれば `from - 1` を返す (= まだ保留が要る)。全員が打ち切りまで許したときは
 * `from + MAJOR_PROBE_SPAN` を返すので、呼び出し側はそれを「上限なし」と読む。
 *
 * **なぜ「次の major」1 点だけでは足りないのか (issue #44 A.2)。**
 * `version-update:semver-major` は**すべての** major 更新を止めるので、保留を外してよいのは
 * 「これ以上の major が無い」ときだけ。`HELD_MAJOR + 1` を許すかだけを見ると、保留が長引いて
 * eslint 11 が出た時点で、peer が `^10` までしか許していなくても blockingPeers が空になり
 * 「全部そろった、ignore とこのテストを消せ」と指示してしまう。従うと Dependabot が 11 を
 * 提案して lint が壊れるのに、警告してくれるはずのガードは同じ指示で削除済みになる。
 *
 * **レジストリへ問い合わせずに「実際に提案される major」は分からない**
 * (§11 外部 API はモックして実際には呼ばない)。そこで判定は従来どおり
 * 「次の major を全員が許したか」で発火させ、**文言側にこの上限を出して人が決める材料にする**
 * ——「上限まで上げて打ち止めなら削除、上限より上の major が既に出ているなら
 * HELD_MAJOR を上限へ更新」の 2 通りを示す。
 */
function highestCommonlyAllowedMajor(peers: readonly UpstreamPeer[], from: number): number {
  // 1 つでも許さない者がいれば「まだ from には届いていない」ことを表す値から始める
  let highest = from - 1;
  // from から 1 つずつ上へ、全員が許す限り進める
  for (let major = from; major <= from + MAJOR_PROBE_SPAN; major += 1) {
    // 全員が許すかを代表バージョン (`<major>.0.0`) で見る
    if (!peers.every((peer) => satisfies(`${major}.0.0`, peer.range))) break;
    // 許されたのでここまでは進める
    highest = major;
  }
  // 到達できた上限を返す
  return highest;
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
  const inputSources = [
    { path: DEPENDABOT_PATH, error: dependabotRead.error },
    { path: PACKAGE_JSON_PATH, error: packageJsonRead.error },
    { path: PACKAGE_LOCK_PATH, error: packageLockRead.error },
  ];
  const unreadableSources = inputSources
    // 読めたものは報告対象から外す
    .filter((source) => source.error !== null)
    // 失敗文言に載せるため、repo ルートからの相対パスと原因を組み立てる
    .map(
      (source) => `${displayPath(source.path)}: ${describeReadError(source.error, REPO_ROOT)}`,
    );
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

  // ロックファイルが「この検査に使える構造」を持っているか。
  // **例外が出ないことだけでは足りない。** lockfileVersion 1 形式 (packages 枝が無く
  // dependencies だけ)、設定パッケージのエントリが null、その `dependencies` 枝が
  // 無い、といった形はいずれも readParsed から見れば「トップレベルはオブジェクト」で
  // error が立たない。その状態で規則照合を走らせると deriveExpectedPlugins が
  // [] を返し、「一覧を合わせてください」→ 一覧を空にする → 期限判定が un-skip →
  // 「ignore を削除してください」という、lint を壊す助言の連鎖に入ってしまう。
  //
  // **判定は「規則から 1 つでも導けたか」で行う。** 「エントリが undefined でないか」
  // のような手前の条件で代用すると、deriveExpectedPlugins が実際に要求する前提
  // (null でないオブジェクトで、かつ dependencies が読める) との差から漏れが出る。
  // 使う側と同じ結果を見れば、前提が増えても判定が自動で追随する
  const derivedFromRule = deriveExpectedPlugins(packageLock);
  // ロックに依存する検査を走らせてよいか = 規則から 1 つでも導けたか。
  // **読めなかった場合もこの 1 つで足りる** — readParsed は失敗時に必ず value: null を
  // 返すので、deriveExpectedPlugins(null) は [] になりここが false になる。
  // `packageLockRead.error === null` を並べても判定を変えないため置かない
  // (§6 デッドコードを残さない)。名前も 1 つに保ち、
  // 「構造の検査」と「それを根拠に skip する検査」が同じ述語を見ていることを明らかにする
  const lockUsable = derivedFromRule.length > 0;
  // ロックファイルに記録されている上流プラグイン群の peer 範囲
  const upstreamPeers = collectUpstreamPeers(packageLock);
  // 規則 (設定パッケージの直接依存 ＋ repo 固有分) から導いた「見張るべき一覧」
  const derivedPlusLocal = [...derivedFromRule, ...LOCALLY_ADDED_LINT_PLUGINS];
  // 一覧が規則どおりか。ずれているなら「見張るべきなのに見張れていない」ものが居る。
  // 下の規則照合テストと同じ正規化 (sortedNames) を通すので、判定が食い違わない
  const pluginListMatchesRule = sameNameSet(derivedPlusLocal, REQUIRED_UPSTREAM_PLUGINS);
  // 留め置きを外せるかの判定に使う「次の major」の代表バージョン
  const nextMajorVersion = `${HELD_MAJOR + 1}.0.0`;
  // 次の major をまだ許していない上流 (= 保留の理由として残っているもの)
  const blockingPeers = upstreamPeers.filter((peer) => !satisfies(nextMajorVersion, peer.range));
  // 監視対象がそろって許している major の上限 (保留を外してよいかの材料。issue #44 A.2)
  const commonlyAllowedMajor = highestCommonlyAllowedMajor(upstreamPeers, HELD_MAJOR + 1);
  // 打ち切りまで進めたら「上限なし」(`*` のような常に充足する範囲しか無い状態)
  const commonlyAllowedIsUnbounded = commonlyAllowedMajor >= HELD_MAJOR + 1 + MAJOR_PROBE_SPAN;

  // **ディレクトリの glob 判定の境界を固定する。** この判定が「覆っている」と誤れば、
  // root へ効かなくなった ignore を「効いている」と読んで検査が緑のまま素通りする
  // (issue #44 A.1。`/*` が root を覆うと判定していた)。公式ドキュメントへ到達できないため
  // 意味論は近似なので、どちらへ倒すかをここで明示的に固定する
  it("ディレクトリの glob 判定が、空のパス要素を作らない", () => {
    // **本題**: 区切りのあいだを丸ごと占める `*` は 1 文字以上。
    // `directories: ["/*"]` は 1 階層下を指す綴りで root は含まない
    expect(directoryPatternCovers("/*", "/"), "`/*` は root を覆わない").toBe(false);
    // 1 階層下は覆う
    expect(directoryPatternCovers("/*", "/app"), "`/*` は 1 階層下を覆う").toBe(true);
    // 2 階層下は覆わない (`*` は区切りを跨げない)
    expect(directoryPatternCovers("/*", "/a/b"), "`/*` は 2 階層下を覆わない").toBe(false);
    // 途中の階層でも同じ規則
    expect(directoryPatternCovers("/packages/*", "/packages/app")).toBe(true);
    expect(directoryPatternCovers("/packages/*", "/packages")).toBe(false);

    // **締めすぎない側**: 区切りの一部を占める `*` は空にも一致する
    // (shell の glob と同じ。一律 1 文字以上にすると、こちらが逆向きの誤判定になる)
    expect(directoryPatternCovers("/app*", "/app"), "`/app*` は `/app` を覆う").toBe(true);
    expect(directoryPatternCovers("/app*", "/application")).toBe(true);
    expect(directoryPatternCovers("/app*", "/app/x")).toBe(false);

    // `**` は「0 個以上のパス要素」なので root も覆う
    expect(directoryPatternCovers("/**", "/"), "`/**` は root を覆う").toBe(true);
    expect(directoryPatternCovers("/**", "/a/b")).toBe(true);

    // 完全一致はそのまま通る (glob を含まない現行の設定がこれ)
    expect(directoryPatternCovers("/", "/")).toBe(true);
    expect(directoryPatternCovers("/app", "/")).toBe(false);

    // 正規表現のメタ文字は無効化されている (パスの一部として扱う)
    expect(directoryPatternCovers("/a.b", "/axb"), "`.` はメタ文字として効かない").toBe(false);
    expect(directoryPatternCovers("/a.b", "/a.b")).toBe(true);
  });

  // **「そろって許している上限」の挙動を合成入力で固定する。** 実在の peer 範囲は
  // 現時点でどれも次の major を許していないので、この関数を潰しても
  // (常に `from - 1` を返すようにしても) ほかの検査は全件緑のまま通る。
  // 失敗文言がこの値を出して保留解除の判断材料にする以上、値そのものを固定する
  it("そろって許している major の上限を、合成した peer 範囲で正しく求める", () => {
    // 1 つでも次の major を許さなければ「まだ届いていない」
    expect(
      highestCommonlyAllowedMajor([{ name: "a", range: "^9.0.0" }], 10),
      "9 までしか許さない peer があれば 9 (= from - 1)",
    ).toBe(9);
    // 全員が 10 までなら上限は 10
    expect(
      highestCommonlyAllowedMajor(
        [
          { name: "a", range: "^9.0.0 || ^10.0.0" },
          { name: "b", range: ">=10.0.0 <11.0.0" },
        ],
        10,
      ),
    ).toBe(10);
    // **一番狭い者に合わせる** — 1 人が 12 まで許しても、もう 1 人が 10 までなら 10
    expect(
      highestCommonlyAllowedMajor(
        [
          { name: "a", range: ">=10.0.0 <13.0.0" },
          { name: "b", range: ">=10.0.0 <11.0.0" },
        ],
        10,
      ),
      "上限は最も狭い peer で決まる",
    ).toBe(10);
    // **途切れたらそこで止める** — 11 を飛ばして 12 を許す範囲でも 10 止まり
    expect(
      highestCommonlyAllowedMajor([{ name: "a", range: "^10.0.0 || ^12.0.0" }], 10),
      "連続して許されている範囲までしか進めない",
    ).toBe(10);
    // 常に充足する範囲しか無ければ打ち切りまで進む (呼び出し側が「上限なし」と読む)
    expect(
      highestCommonlyAllowedMajor([{ name: "a", range: "*" }], 10),
      "`*` は打ち切りまで進む",
    ).toBe(10 + MAJOR_PROBE_SPAN);
    // 監視対象が空なら `every` は真になるので打ち切りまで進む。
    // **呼び出し側はこの状態に入らない** (件数一致と規則照合が先に skip させる) が、
    // 値の意味を固定しておく
    expect(highestCommonlyAllowedMajor([], 10)).toBe(10 + MAJOR_PROBE_SPAN);
  });

  // 件数もファイル名も定数側から導く — テスト名に書き写すと、入力を増減したときや
  // パス定数を変えたときに、CI の出力だけが実態と食い違ったまま残る (§6 一元管理)
  it(`検査に使う ${inputSources.length} つの入力ファイルが読めて、構造として解釈できる`, () => {
    // 読み取り・パースで例外が出ていないこと。落ちる代表例は
    // ファイルごと削除・改名された (ENOENT) か、キーの重複やマージ事故で
    // 壊れている (YAMLParseError / SyntaxError) 場合。
    // 複数が同時に壊れることもあるので、1 件ずつではなくまとめて報告する。
    // 例外の内容をそのまま文言に載せて、原因の切り分けを読み手に渡す
    expect(
      unreadableSources,
      `検査に使う入力ファイルを読めませんでした: ${unreadableSources.join(" / ")}。` +
        `削除・改名されていないか、YAML / JSON として壊れていないかを確認してください。` +
        `${displayPath(DEPENDABOT_PATH)} が消えている場合は ` +
        `${GUARDED_DEPENDENCY} の major 保留も一緒に消えており、` +
        `${displayPath(PACKAGE_LOCK_PATH)} が読めない場合は ` +
        `上流プラグインの peer 範囲を評価できません` +
        `(どちらもこのファイルの検査対象そのものなので、ここで止めて他の検査に` +
        `誤った前提で判断させないようにしています)。`,
    ).toEqual([]);
  });

  // ロックファイル自体が読めていないときは対象外 (直前のテストが原因を報告する)
  it.skipIf(packageLockRead.error !== null)(
    `${displayPath(PACKAGE_LOCK_PATH)} が、この検査の使う構造を持っている`,
    () => {
      // JSON として読めても、この検査が辿る枝が無ければ peer 範囲を評価できない。
      // 下のロック依存の検査はこの状態だと skip されるので、**なぜ skip されたのか**を
      // 示す役割をこのテストが持つ (黙って評価されないまま緑にしない)
      expect(
        lockUsable,
        `${displayPath(PACKAGE_LOCK_PATH)} から、規則 (${UPSTREAM_CONFIG_PACKAGE} の直接依存の` +
          `うち ${GUARDED_DEPENDENCY} に peer 依存を宣言しているもの) が 1 つも導けません。` +
          `packages 枝を持たない lockfileVersion 1 形式への差し替え、` +
          `node_modules/${UPSTREAM_CONFIG_PACKAGE} エントリの欠落や null、` +
          `その dependencies 枝の欠落が疑われます。` +
          `この状態では上流プラグインの peer 範囲を評価できないため、` +
          `規則照合と期限判定は skip しています` +
          `(走らせると「監視対象は 1 つも無い」と読める文言が出て、` +
          `一覧を空にし ignore を削除する方向へ誤って誘導するため)。` +
          `npm install で再生成するか、依存構成の変更なら保留の前提ごと見直してください。`,
      ).toBe(true);
    },
  );

  // 入力そのものが読めていないときは対象外 (skip として CI の出力にも現れる)。
  // 空ファイルや削除で dependabotConfig が {} に均された状態でこの検査を走らせると、
  // 「読めない要素は 0 個」と**中身の無いファイルに対して緑**になり、
  // 直前のテストが赤いのに「設定は健全」と読める出力が並んでしまう。
  // 評価できないことは skip で示し、原因の報告は直前のテストに任せる
  // **判定はこのファイルが読めたかどうかだけを見る。** unreadableSources 全体で
  // 判定すると、無関係な package-lock.json の破損だけでこの検査が止まり、
  // 同時に混入した dependabot.yml の壊れが 1 つも報告されなくなる
  // (objectElementsOf が黙って読み飛ばすので他の検査は緑のまま通る)
  it.skipIf(dependabotRead.error !== null)(
    `${displayPath(DEPENDABOT_PATH)} に読めない形のリスト要素が無い`,
    () => {
      // 空要素 `-` (ブロックをコメントアウトした残り) が混ざっていないかを見る。
      // この検査が無いと、正しいエントリの**隣**に空要素が増えたケースで
      // ignore の件数が変わらず、壊れた設定のまま全検査が緑になる。
      // 読み手側 (このテスト) が黙って読み飛ばすようになった分、
      // 「意図して書いた形か」は独立した検査で担保する
      expect(
        unreadableElementCount,
        `${displayPath(DEPENDABOT_PATH)} のうち、この検査が実際に読む場所に、` +
          `想定した形で書かれていない箇所が ${unreadableElementCount} 個あります。` +
          `読む場所と典型的な壊れ方は次のとおりです — ` +
          `(a) updates そのもの: キーが無い / リストでない。` +
          `(b) updates 直下: ブロックをコメントアウトしたときに残った空要素 \`-\`。` +
          `(c) **全ブロックの** package-ecosystem: 値が消えている ` +
          `(${GUARDED_ECOSYSTEM} 以外のブロックも対象。値で担当を選ぶため全部読みます)。` +
          `(d) ${GUARDED_ECOSYSTEM} ブロックの directory / directories: ` +
          `どこも指していない (\`directory:\` と値を消す・\`directories: []\`) か、` +
          `directories がリストでない (\`directories: "/"\`)。` +
          `(e) ${GUARDED_ECOSYSTEM}・${GUARDED_DIRECTORY} ブロックの ignore: ` +
          `キーがリストでない・空要素 \`-\`・` +
          `\`dependency-name: ["eslint"]\` のように名前が文字列でない。` +
          `この検査はそれを読み飛ばすので、放置すると設定が壊れたまま他の検査が緑になります` +
          `(とくに \`directory\` が読めないと担当ブロックが 0 件になり、` +
          `保留の期限判定ごと skip されて検出網が静かに止まります)。` +
          `(Dependabot 側がこの形をどう扱うかはこの環境から裏取りできていないため、` +
          `無害と決めつけず意図した形でない時点で落としています)。`,
      ).toBe(0);
    },
  );

  // package.json そのものが読めていないときは対象外 (skip として CI の出力にも現れる)。
  // 走らせると「`^9.39.4` の形で書いてください(現在の値: undefined)。dependencies へ
  // 移した・キーごと消した場合もここで落ちます」と、**どれも当てはまらない原因**だけを
  // 名指ししてしまい、実際の欠損・破損へ辿り着けない。原因の報告は入力ファイルの検査に任せる
  it.skipIf(packageJsonRead.error !== null)(
    `${displayPath(PACKAGE_JSON_PATH)} の ${GUARDED_DEPENDENCY} バージョン範囲が、` +
      `このテストで解釈できる形で書かれている`,
    () => {
      // ここが落ちると、下の構造検査とダウングレード検査が skip され、
      // ignore の削除・重複を捕まえる網まで黙って無効になる。何を直せばよいかを明示する
      expect(
        allowedMajor,
        `${displayPath(PACKAGE_JSON_PATH)} の devDependencies.${GUARDED_DEPENDENCY} を、` +
          // 書式例の major は留め置き中の major に追随させる。ここだけ数字を直書きすると、
          // HELD_MAJOR を新しい major へ更新し直したときに例だけ古い数字のまま残り、
          // 「^11 と書いてあるのに ^9 にしろと言われた」という誤解を生む
          `\`^${HELD_MAJOR}.39.4\` のような` +
          `「先頭に ^ か ~ が 1 つ、あとは数字とドット」の形で書いてください` +
          `(現在の値: ${JSON.stringify(declaredRange)})。` +
          `dependencies へ移した・キーごと消した場合もここで落ちます。` +
          `この検査が落ちている間は ignore の削除・重複を見張る検査が skip され、` +
          `検出網が無効になります。`,
      ).not.toBeNull();
    },
  );

  // ロックファイルが読めていないときは対象外 (skip として CI の出力にも現れる)。
  // **ここを走らせると助言そのものが有害になる。** 読めないと deriveExpectedPlugins は
  // [] を返すので「規則から導けるのは [なし]」と出て「一覧を合わせてください」と促すが、
  // 従って一覧を空にすると件数一致と規則一致が両方成立し、期限判定が un-skip されて
  // 「すべて eslint 10 を許すようになりました…ignore を削除してください」まで進む。
  // 削除すると eslint 10 が入り lint が壊れる。原因の報告は入力ファイルの検査に任せる
  it.skipIf(!lockUsable)(
    "REQUIRED_UPSTREAM_PLUGINS が規則から導いた一覧と一致する",
    () => {
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
          `見張られていません** — ${HELD_MAJOR} 系に留まったまま他が ${HELD_MAJOR + 1} ` +
          `対応すると、期限判定が誤って ` +
          `保留解除を促します(そのため一覧がずれている間、期限判定は skip されます)。` +
          `上流の依存構成が変わったなら REQUIRED_UPSTREAM_PLUGINS を合わせてください。` +
          `${UPSTREAM_CONFIG_PACKAGE} の依存ではなく eslint.config.mjs へ直接載せた ` +
          `プラグインなら、REQUIRED_UPSTREAM_PLUGINS と LOCALLY_ADDED_LINT_PLUGINS の ` +
          `両方へ足すと一致します。` +
          // **散文へ一覧を写させない (issue #44 C.9)。** 以前はここで
          // 「dependabot.yml と CLAUDE.md の説明にも反映してください」と案内していたが、
          // 内訳を散文に持つ限り drift は必ず起きる (PR #43 がその修正に費やされた)。
          // 散文側からは一覧と内訳を落とし、この失敗文言を正本にした
          `**内訳の正本はこの文言**なので、${displayPath(DEPENDABOT_PATH)} と CLAUDE.md §3 ` +
          `には一覧を写さないでください(どちらも「内訳はここを見る」と書いてあります)。` +
          `${GUARDED_DEPENDENCY} の留め置き中の major そのものを変える場合だけ、` +
          `散文側の数字も同じ変更に含めてください。`,
      ).toEqual(expected);
    },
  );

  // 上の規則照合と重なる部分はあるが、独立した意味がある:
  //   - LOCALLY_ADDED_LINT_PLUGINS の分は規則からは導けないので、そちらが
  //     ロックファイルから読めなくなったことはこの検査でしか分からない。
  //   - 期限判定の skip 条件 (件数一致) が拠り所にしているのはこの検査の文言なので、
  //     「なぜ skip されたか」を専用のメッセージで示す役割も持つ。
  // ロックファイルが「この検査に使える形」でないときは対象外
  // (skip として CI の出力にも現れる)。**該当するのは 2 通り** — 読めない場合と、
  // 読めても規則から 1 つも導けない場合 (設定パッケージのエントリが無い・null など)。
  // どちらでも「読み取れない」のは事実だが、原因はロックファイル側であって
  // 上流の依存構成が変わったことではない。ここで「依存構成が変わったなら
  // REQUIRED_UPSTREAM_PLUGINS と保留の前提を見直してください」と促すと、
  // 一覧を空にする方向へ誘導し、最終的に ignore の削除まで進んでしまう。
  // 原因の報告は入力ファイルの検査とロック構造の検査に任せる
  it.skipIf(!lockUsable)(
    "保留の理由になっている上流プラグインが、すべてロックファイルから読み取れる",
    () => {
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
    },
  );

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
          // **「ignore を消せ」と言い切らない (issue #44 A.2)。** この ignore は
          // **すべての** major 更新を止めているので、外してよいのは「これ以上の major が
          // 無い」ときだけ。そろって許している上限を出して、2 通りの直し方を人に選ばせる
          `**監視対象がそろって許しているのは major ` +
          `${commonlyAllowedIsUnbounded ? `${HELD_MAJOR + 1} 以上(上限なし)` : commonlyAllowedMajor}` +
          ` までです。** やることは 2 通りで、どちらかは ` +
          `「${commonlyAllowedIsUnbounded ? "" : `major ${commonlyAllowedMajor} より上の `}` +
          `${GUARDED_DEPENDENCY} の major が既に出ているか」で決まります` +
          `(\`npm view ${GUARDED_DEPENDENCY} versions\` 等で確認)。` +
          `(1) 出ていない → ${displayPath(DEPENDABOT_PATH)} の ignore とこのテストを削除し、` +
          `${GUARDED_DEPENDENCY} の major 更新を取り込む。` +
          `(2) 出ている → ignore は残したまま HELD_MAJOR を ` +
          `${commonlyAllowedIsUnbounded ? "その major" : commonlyAllowedMajor} へ更新する` +
          `(消すと Dependabot がさらに上の major を提案し、peer が許さないので lint が壊れます)。`,
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
          `この保留が要る理由は ${displayPath(DEPENDABOT_PATH)} のコメントと CLAUDE.md ` +
          `§3「テスト」節の eslint 留め置きの項を参照 (消すと lint が ` +
          `contextOrFilename.getFilename is not a function で落ちます)。`,
      ).toHaveLength(1);
    },
  );

  // **形の検査は `allowedMajor` から切り離す (issue #44 A.3)。**
  // 以前はこの 3 つが上の件数検査と同じ `it` に入っており、`package.json` の eslint 範囲が
  // `>=9` のように解釈できない書き方になると `allowedMajor` が null になって
  // `skipIf(allowedMajor !== HELD_MAJOR)` が成立し、**`*` への書き換え・`update-types` の
  // 消失・`versions` の追加を見張る網まで丸ごと skip** されていた。
  // 形の正しさは「いまどの major に居るか」とは独立なので、**ignore が 1 件以上あるなら
  // 常に見る**。入力そのものが読めないときだけ対象外にする (原因は入力ファイルの検査が報告)。
  //
  // **1 件ずつ expect せず、問題を全部集めて 1 回で比較する。** 2 件目以降に別の壊れ方が
  // あっても最初の 1 件で例外が飛ぶと残りが出力に現れず、直して再実行の往復になる
  it.skipIf(dependabotRead.error !== null || ignoreEntries.length === 0)(
    `${GUARDED_DEPENDENCY} の ignore エントリが、どれも想定どおりの形をしている`,
    () => {
      // 見つかった問題を「何件目の・何が」の形で集める
      const problems: string[] = [];
      // 集めたエントリを 1 つずつ確かめる
      ignoreEntries.forEach((entry, index) => {
        // 名前が eslint そのものであること。`*` へ**書き換えられた**場合、
        // 件数も update-types もキー集合も想定どおりのまま素通りしてしまうが、
        // 実際には npm の全パッケージの major 更新が止まる (next / prisma / react …)
        if (entry["dependency-name"] !== GUARDED_DEPENDENCY) {
          problems.push(
            `${index + 1} 件目: dependency-name が ${JSON.stringify(entry["dependency-name"])}` +
              ` (想定: ${JSON.stringify(GUARDED_DEPENDENCY)})`,
          );
        }
        // 止める対象は major だけ。update-types ごと消えると Dependabot は
        // 「全バージョンを無視」と解釈し、留め置き中の major の修正まで届かなくなる
        if (
          !Array.isArray(entry["update-types"]) ||
          entry["update-types"].length !== 1 ||
          entry["update-types"][0] !== MAJOR_UPDATE_TYPE
        ) {
          problems.push(
            `${index + 1} 件目: update-types が ${JSON.stringify(entry["update-types"])}` +
              ` (想定: [${JSON.stringify(MAJOR_UPDATE_TYPE)}])`,
          );
        }
        // 書かれているキーがちょうど想定どおりであること。`versions` のような
        // 別の絞り込みが足されると、update-types が正しくても効き方が変わってしまう
        const keys = sortedKeysOf(entry);
        const allowed = [...ALLOWED_IGNORE_KEYS].sort();
        if (keys.join(",") !== allowed.join(",")) {
          problems.push(
            `${index + 1} 件目: キー集合が [${keys.join(", ")}] (想定: [${allowed.join(", ")}])`,
          );
        }
      });
      // 問題が 1 つも無いことを 1 回で比較する (全件が一度に出る)
      expect(
        problems,
        `${GUARDED_ECOSYSTEM} / ${GUARDED_DIRECTORY} の ignore に書かれた ` +
          `${GUARDED_DEPENDENCY} のエントリの形が想定と違います: ${problems.join(" / ")}。` +
          `dependency-name を \`*\` へ書き換えると npm の全パッケージの major が止まり、` +
          `update-types が消えると Dependabot は「全バージョンを無視」と解釈して` +
          `留め置き中の major の修正まで届かなくなります。` +
          `\`versions\` のような別の絞り込みを足した場合も効き方が変わります。`,
      ).toEqual([]);
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
          `後者を選ぶ場合、major の数字を書いている散文 — ${displayPath(DEPENDABOT_PATH)} の` +
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
