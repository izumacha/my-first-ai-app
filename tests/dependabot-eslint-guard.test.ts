// `.github/dependabot.yml` の「ESLint major 更新を保留する ignore」と、`package.json` が
// 宣言している eslint のバージョン範囲が食い違っていないことを固定するテスト。
//
// なぜテストで縛るのか:
//   この ignore は「上流のプラグイン群 (eslint-config-next が引き込む eslint-plugin-react /
//   -import / -jsx-a11y / -react-hooks) が ESLint 10 に未対応な間だけ」有効な
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
//       判定対象は eslint-plugin-react 1 つではなく、eslint-config-next が引き込む
//       eslint peer 依存すべて(import / jsx-a11y / react-hooks 等)。1 つだけが先に
//       対応しても lint は落ちたままなので、全部が揃って初めて保留を外せる。
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
import { resolve } from "node:path";
// dependabot.yml を構造として読むため
import { parse as parseYaml } from "yaml";
// peer 範囲が特定のバージョンを許すかを正しく判定するため。
// 自前で「範囲に現れる数字の最大値」を見る方式は、`>=9.7` のような開いた範囲を
// 「9 まで」と読み違え(期限切れを見逃す)、`>=9.0.0 <10.0.0` のような上限付きを
// 「10 に言及している」と読み違える(誤って保留解除を促す)。範囲の解釈は
// 専用ライブラリに任せる (§9 自前実装しない)
import { satisfies } from "semver";

// リポジトリのルート (このテストファイルは tests/ 直下にある)
const REPO_ROOT = resolve(__dirname, "..");
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
// 実際に eslint を 9 系までに制限しているプラグイン。期限判定はこの全員が
// 次の major を許したときだけ発火させる。
// **走査で必ず見つかること自体も固定する**: 設定パッケージ本体の peer は `>=9.0.0` と
// 緩く、それだけを拾えた状態でも「全員が 10 を許した」に見えてしまう。上流の依存構成が
// 変わってプラグインが走査から外れたら、誤って保留解除を促す前に落とす (fail-closed)
const REQUIRED_UPSTREAM_PLUGINS = [
  "eslint-plugin-react",
  "eslint-plugin-import",
  "eslint-plugin-jsx-a11y",
  "eslint-plugin-react-hooks",
];

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
  // 複数形の配列に含まれていれば、そのブロックが担当している
  return asArray(entry.directories).includes(directory);
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
  // updates 直下から「エコシステムとディレクトリの両方が一致する」ブロックを集める。
  // エコシステムだけで最初の 1 件を採ると、npm のブロックが複数ある構成 (モノレポ等) で
  // 別ディレクトリのブロックに書かれた ignore を、このプロジェクトに効いていると読み違える
  const blocks = asArray(config.updates)
    .map((entry) => entry as DependabotUpdateEntry)
    .filter(
      (entry) => entry["package-ecosystem"] === ecosystem && coversDirectory(entry, directory),
    );
  // 該当ブロックの ignore から対象パッケージに当たるエントリをすべて集めて返す
  // (完全一致だけでなく `*` / `eslint*` のようなワイルドカードも拾う)
  return blocks.flatMap((block) =>
    asArray(block.ignore)
      .map((entry) => entry as DependabotIgnoreEntry)
      .filter((entry) => ignoreNameMatches(entry["dependency-name"], dependencyName)),
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
 * 設定パッケージ (eslint-config-next) 本体と、それが引き込む依存のうち
 * eslint に peer 依存しているものをロックファイルから集める。
 *
 * **eslint-plugin-react だけを見ないのが要点。** 同じ lint 実行に載る
 * eslint-plugin-import / jsx-a11y / react-hooks も eslint を `^9` までに制限しており、
 * react だけが先に ESLint 10 へ対応しても lint は落ちたままになる。1 つだけを見ていると
 * 「上流が対応した」と誤って知らせ、保留を外させて元の破損を呼び戻してしまう。
 *
 * 1 件も見つからなければ空配列を返し、呼び出し側で落とす — 依存の構成が変わったなら、
 * 保留の前提そのものを見直す必要があるため (fail-closed)。
 */
function collectUpstreamPeers(lock: unknown): UpstreamPeer[] {
  // トップレベルがオブジェクトでなければ読み進めない
  if (typeof lock !== "object" || lock === null) return [];
  // packages の枝 (パッケージのパス → メタデータ) を取り出す
  const packages = (lock as { packages?: unknown }).packages;
  // それ自体がオブジェクトでなければ、やはり読み進めない
  if (typeof packages !== "object" || packages === null) return [];
  // 型を絞った参照を用意する
  const table = packages as Record<string, unknown>;
  // 設定パッケージ本体のメタデータを取り出す (これが無ければ前提が崩れている)。
  // 本体は直接の devDependency なので必ず巻き上げ側 (`node_modules/<name>`) に居る
  const config = table[`node_modules/${UPSTREAM_CONFIG_PACKAGE}`];
  // オブジェクトで書かれていなければ前提が崩れているので空を返す
  if (typeof config !== "object" || config === null) return [];
  // 設定パッケージが引き込む依存を走査対象にする。
  // **本体そのものは含めない**: その peer は `>=9.0.0` と緩く、常に次の major を許すため、
  // 混ぜると「全員が許した」の判定を無条件に甘くしてしまう
  const names = Object.keys(asRecord((config as Record<string, unknown>).dependencies));
  // 集めた peer 範囲を溜める配列
  const peers: UpstreamPeer[] = [];
  // 走査対象を順に見ていく
  for (const name of names) {
    // そのパッケージのロックエントリを引く (設定パッケージ配下の入れ子も見る)
    const meta = findLockEntry(table, UPSTREAM_CONFIG_PACKAGE, name);
    // 見つからなければ対象外 (別の依存に巻き上げられているだけの場合もある)
    if (!meta) continue;
    // eslint に対する peer 範囲を取り出す
    const range = asRecord(meta.peerDependencies)[GUARDED_DEPENDENCY];
    // 文字列で書かれていれば採用する (eslint に peer 依存しないパッケージは対象外)
    if (typeof range === "string") peers.push({ name, range });
  }
  // 見つかった分を返す (空なら呼び出し側が落とす)
  return peers;
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
  // Dependabot 設定を構造として読む (コメントはパーサが落とすので検査に混ざらない)
  const dependabotConfig = parseYaml(readFileSync(DEPENDABOT_PATH, "utf8")) as DependabotConfig;
  // package.json も同様に unknown で受けてから絞る
  const packageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  // ロックファイル (上流プラグイン群の peer 範囲を読むため)
  const packageLock: unknown = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, "utf8"));
  // devDependencies に書かれている eslint のバージョン範囲 (無ければ undefined)
  const declaredRange = readDevDependencyRange(packageJson, GUARDED_DEPENDENCY);
  // 許容している最小 major (解釈できなければ null)
  const allowedMajor = parseAllowedMajor(declaredRange);
  // npm エコシステムの ignore にある eslint のエントリ (複数書かれていればすべて)
  const ignoreEntries = collectIgnoreEntries(
    dependabotConfig,
    GUARDED_ECOSYSTEM,
    GUARDED_DIRECTORY,
    GUARDED_DEPENDENCY,
  );

  // ロックファイルに記録されている上流プラグイン群の peer 範囲
  const upstreamPeers = collectUpstreamPeers(packageLock);
  // 留め置きを外せるかの判定に使う「次の major」の代表バージョン
  const nextMajorVersion = `${HELD_MAJOR + 1}.0.0`;
  // 次の major をまだ許していない上流 (= 保留の理由として残っているもの)
  const blockingPeers = upstreamPeers.filter((peer) => !satisfies(nextMajorVersion, peer.range));

  it("package.json の eslint バージョン範囲が、このテストで解釈できる形で書かれている", () => {
    // 解釈できない書き方だと以降の判定が意味を失うので、ここで落として気付けるようにする
    // (devDependencies から eslint が消えた場合もここで落ちる)
    expect(allowedMajor).not.toBeNull();
  });

  it("保留の理由になっている上流プラグインが、すべてロックファイルから読み取れる", () => {
    // 走査で拾えたパッケージ名の一覧
    const found = upstreamPeers.map((peer) => peer.name);
    // 実際に eslint を制限しているプラグインが 1 つでも走査から外れると、
    // 残った緩い peer だけを見て「全員が次の major を許した」と誤読しうる。
    // 上流の依存構成が変わったなら、保留の前提ごと見直す合図として落とす
    for (const plugin of REQUIRED_UPSTREAM_PLUGINS) {
      expect(
        found,
        `${plugin} が ${UPSTREAM_CONFIG_PACKAGE} 配下の eslint peer 依存として見つかりません` +
          `(見つかったのは ${found.join(", ") || "なし"})。依存構成が変わったなら、` +
          `REQUIRED_UPSTREAM_PLUGINS と保留の前提を見直してください。`,
      ).toContain(plugin);
    }
  });

  // 次のどちらかなら、この検査は対象外 (skip として CI の出力にも現れる):
  //   - 保留そのものが無い … 上流が出揃って ignore を消したあと、このテストだけが
  //     赤く残り続けて「もう存在しない ignore を消せ」と言い続ける状態を避ける
  //   - 上流を 1 つも読み取れていない … 前提が崩れているだけなのに blockingPeers が空になり、
  //     「全員が許した」と読める文言で保留の削除を促してしまう。前提崩れは
  //     直前の「上流プラグインがすべて読み取れる」テストが専用の文言で落とす役割
  it.skipIf(ignoreEntries.length === 0 || upstreamPeers.length === 0)(
    "上流がまだ次の major に対応していない (= 保留の理由が残っている)",
    () => {
      // 上流のどれか 1 つでも次の major を許していなければ、保留はまだ必要。
      // **全部が許すようになって初めて**保留を外せる — eslint-plugin-react だけが
      // 先に対応しても、同じ lint 実行に載る import / jsx-a11y / react-hooks が
      // 9 までに制限したままなら lint は落ちるため。
      // ここで落ちたら「上流が出揃った」合図。ignore を外して major 更新を取りにいく
      // (この検査が無いと、保留が効いている限り package.json は 9 のまま動かず、
      //  package.json の major を見る判定が永久に発火しないという循環に陥る)
      expect(
        blockingPeers.map((peer) => peer.name),
        `${UPSTREAM_CONFIG_PACKAGE} 配下のすべてが eslint ${nextMajorVersion} を許すようになりました` +
          `(${upstreamPeers.map((peer) => `${peer.name}: ${peer.range}`).join(", ")})。` +
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
          `この保留が要る理由は .github/dependabot.yml のコメントと CLAUDE.md §3 ` +
          `「テスト」節の eslint 留め置きの項を参照 (消すと lint が ` +
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
      expect(sortedKeysOf(ignoreEntries[0])).toEqual([...ALLOWED_IGNORE_KEYS].sort());
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
          `新しい major で留め置き直すなら HELD_MAJOR を ${allowedMajor} へ更新してください。`,
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
