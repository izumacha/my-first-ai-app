// このアプリが**実際に動く Node.js の major** を、宣言している場所すべてで揃えるテスト。
//
// なぜテストで縛るのか:
//   「どの Node で動かすか」はこのリポジトリの中で 4 か所に分かれて書かれている
//   (`.nvmrc`(正本) / `Dockerfile` の `FROM node:<major>` /
//    `package.json` の `engines.node` / README の必要環境。CI は `.nvmrc` を
//    参照するので版を持たない)。ここがずれても
//   **lint も型チェックもテストも通ってしまう**。npm は `engines` を既定で強制しない
//   ので、依存がサポートしていない Node の上でも `npm ci` は成功し、テストも
//   「たまたま動いている間は」緑になる。つまり **CI の緑が「その Node で動く」ことの
//   証明にならない fail-open** で、壊れるのは出荷した先の実行時になる。
//
//   実際このリポジトリはその状態だった: Dockerfile は `node:26-alpine` で出荷する一方、
//   CI の matrix は `[20, 22]` のままで、**出荷する Node を一度も検証していなかった**。
//   しかも Node 20 は既にサポート切れで、`@testing-library/jest-dom` は `engines`
//   に `>=22` を宣言している (= 検証していたのはサポート外の組み合わせ)。
//   さらに `@types/node` は `^26` — 型は Node 26 の API を主張するのに、実行して
//   確かめていたのは 20/22 だったので、26 にしか無い API を書いても
//   `tsc --noEmit` が緑のまま通る状態だった。
//
// 何を防ぐか:
//   (a) ピン留めの食い違い … `.nvmrc` と Dockerfile が別々の major を指す状態。
//       どちらかを上げ忘れると「どの Node に合わせるべきか」が決まらなくなる。
//   (a') CI が版を書き写す形へ戻ること … `node-version: '26'` のように直書きすると、
//       `.nvmrc` とずれても CI は緑のまま通り、この PR 以前の状態に戻る。
//       値の一致ではなく**配線そのもの**を固定する。
//       **ステップを丸ごとイメージの中で走らせる形も落とす。**
//       `uses: docker://<image>` はそのステップだけをイメージの中で走らせるので、
//       同じジョブに正しい `setup-node` を置いても効かない。3 つ目の検査でも拾えない
//       (`uses:` が `./` で始まらないため「リポジトリのコードを実行するステップ」に
//        数えられず、ジョブが要求の対象から外れる。実測)。**イメージ名は問わない** —
//       `node` という名前に絞ると `docker://ghcr.io/acme/ci-node:20` が素通りした (実測)。
//       Node を持ち込まないイメージは `NODE_GUARD_EXEMPTIONS` の `image` へ登録する。
//       **ジョブの `container:` はここでは見ない。** その中でも `setup-node` は動いて
//       `.nvmrc` の Node を入れるので、`container: node:26-alpine` + 正しい setup-node は
//       正当な形。一律に落としていたときは、この形に**直しようの無い要求**が出ていた (実測)。
//       誤りは「setup-node が無いこと」のほうで、それは 3 つ目の検査が container の
//       有無に関係なく落とす。
//       **3 つ目の口は「setup-node を書き忘れる」形。** ランナーには Node が
//       最初から入っているため、`setup-node` の無いジョブで `npm ci && npm run test`
//       と書くとランナー既定の major でスイートが丸ごと走る。上の 2 つを塞いでも
//       これは緑のまま通る (実測) ので、**このリポジトリのコードを実行するジョブ**
//       (`run:` を持つ / ローカルの composite action を呼ぶ) には
//       **無条件の `setup-node` がそのコードより前にある**ことまで求める。
//       置いてあるかだけでは足りない — `run: npm ci` の後ろに置いた形、`if:` を
//       付けた形、ステップ / **ジョブ**の `continue-on-error: true` はどれも実測で
//       素通りした (前半 / 全体がランナー既定の Node で走る、あるいはジョブが失敗しても
//       ワークフローが成功で報告されるのに全件緑)。Node と無関係なジョブは
//       `NODE_GUARD_EXEMPTIONS` の `setupNode` へ理由付きで登録する (判定を `run:` の
//       文言から当てる形は、綴りが変わるだけで黙って外れた。実測は同定数の docstring に記録)。
//       **免除は検査ごとに分ける** — 1 つの理由で両方を免除できると、「イメージは Node と
//       無関係」と登録しただけで同じジョブの `run: npm ci` に対する要求まで外れる (実測)。
//       CI が入れる Node は必ず `.nvmrc` 由来にする、が守りたい 1 つの性質で、
//       版が入り込む口を 3 つとも塞いでおかないとその性質は保証にならない。
//       **読めないワークフローが 1 本でもあれば、その時点で落とす。**
//       ジョブ 0 件として黙って飛ばすと、他に正しい `ci.yml` があるかぎり検査は
//       緑のまま通り、その 1 本だけが検査から外れる (実測。fail-open)。
//   (b) 読み取り不能 … 書式が変わってピンを読めない状態。判定の土台が崩れるので
//       「たぶん合っている」ではなく落とす (fail-closed)。
//   (c) 宣言のずれ … `engines.node` がピン留めした Node を許していない、
//       README の必要環境が古い major のまま、といった状態。
//   (d) 型と実行時のずれ … `@types/node` の major がピンと違う状態
//       (型が API の存在を主張するぶん、`tsc` が緑のまま本番だけ壊れる)。
//   (e) **依存がサポートしない Node で検証している状態** … 直接依存が `engines.node`
//       で宣言している範囲を、ピン留めした Node が満たさない状態。
//       上に書いた「CI が緑でも動くとは限らない」を機械的に落とすのがこの検査。
//   (f) `@types/node` の major 保留の消失・効きすぎ・置き場所間違い …
//       Dependabot がランタイムと無関係に型だけを次の major へ進める PR を毎週立てると、
//       (d) が緑のまま入ってしまう。ignore の形まで含めて固定する。
//
// (a') が保証する範囲を正確に書いておく (この検出網は「証明」ではない):
//   見るのは**ワークフローの YAML に構造として現れる 3 つの口**だけ —
//   `actions/setup-node` の `with`、node イメージを走らせる形 (ジョブの `container:` と
//   ステップの `uses: docker://`)、そして「リポジトリのコードを実行するのに、
//   必ず効く `setup-node` がその前に無い」形。
//   これは「**その場に値として書かれた** Node」と「その場に**書かれていない**こと」しか
//   見ないという意味で、逆に言えば
//   **`run:` の中身で Node を入れ替える形は原理的に見えない**
//   (`volta pin` / `nvm install 20` / `asdf` などを走らせる 1 行を足せば素通りする)。
//   同じ理由で、値が式のとき (`container: ${{ matrix.image }}` など) も中身は分からない
//   — 実行時にしか決まらないものを静的に解決しようとすると、matrix や env の
//   評価器を自前で持つことになり、やはり終わらない。
//   **他リポジトリの再利用可能ワークフローを呼ぶジョブ** (`jobs.<id>.uses:
//   `other-org/repo/.github/workflows/x.yml@ref`) も同様で、steps はこのリポジトリの
//   外にあるため読めない (置き場の中の 1 本を呼ぶ形なら、その 1 本自体が走査対象に入る)。
//   **リポジトリ内の composite action** (`.github/actions/*/action.yml`) の中身は
//   読んでいない。ただし**呼んでいる事実はジョブ側に構造として現れる**ので、
//   `uses: ./...` は `run:` と同じ「リポジトリのコードを実行するステップ」として数える
//   — Node の用意と `npm` の実行を両方そこへ追い出しても、ジョブに無条件の
//   `setup-node` が無ければ落ちる (以前は `run:` の文言だけを見ていたため、
//    この形が全件緑のまま通った。実測)。中身を読まないので
//   **`action.yml` の中で Node を入れ替える形**は依然見えない。
//   `.github/actions/` を走査対象に加えるのは、実際にその形が現れてからでよい
//   (存在しない事情のために対象範囲を広げない。CLAUDE.md §6)。
//   そこまで追うには run スクリプトの中身を解釈することになり、綴りを 1 つ塞ぐたびに
//   次の抜け道が出てくる終わりのない作業になる (この repo が CSP の静的解析で
//   実際に踏んだ形)。**「増やしたことに気付く」ための網であって証明ではない**、
//   と理解して使うこと。
//   **見えない形の担保は、静的な検査ではなく CI の 1 ステップが持つ。**
//   `scripts/verify-node-major.mjs` が、スイートを動かすその Node 自身に
//   「`.nvmrc` と同じ major か」を申告させる (綴りに依存しないので、`run:` の中で
//    入れ替える形・式で決まるイメージ・他リポジトリの再利用可能ワークフローを
//    まとめて覆う)。この検査はそれが CI から消えていないことも見る。
//   **判定そのものの挙動は、このファイル末尾のテーブル駆動テストが固定する。**
//   実際の `ci.yml` が準拠しているだけでは、判定を潰しても (`isUnconditionalSetupNode`
//   を `return true` にする等) 全件緑のまま通ってしまい、「塞いだ」証拠が
//   コミットメッセージにしか残らない (実測)。落とす側と通す側の両方を、合成した
//   ジョブ・ステップと合成した除外表で固定してある。ここを広げたくなったら、まず実際にその形が現れてから、
//   正当なワークフローを巻き添えにしない判定を決めて足すこと。
//
// Node を上げるときの手順 (この検査が要求する形):
//   ピン留め 2 か所と `engines.node` / README / `@types/node` を**同じ PR で**
//   新しい major へ揃える。ignore は残したままでよい (major を上げる主導権を
//   Dependabot ではなく「ランタイムを上げる判断」の側に置くのが目的)。

// Vitest の DSL
import { describe, expect, it } from "vitest";
// ピン留めを書いた素のテキスト (.nvmrc / Dockerfile / README) と、
// ワークフローの一覧 (ファイル名を書き並べず、ディレクトリから列挙する) を読むため
import { readdirSync, readFileSync } from "node:fs";
// 検査対象のパスを組み立てるため
import { resolve } from "node:path";
// ワークフローを構造として読むため (正規表現で近似すると、解説コメント中の
// `node-version-file:` を設定値と取り違える)
import { parse as parseYaml } from "yaml";
// `engines.node` は範囲で書かれるので、判定は専用ライブラリに任せる (§9 自前実装しない)
import { satisfies } from "semver";
// 設定ファイルの読み方・パス・Dependabot の語彙は ESLint 保留のガードと共有する (§6 DRY)
import {
  ALLOWED_IGNORE_KEYS,
  asRecord,
  collectIgnoreEntries,
  countUnreadableElements,
  DEPENDABOT_PATH,
  describeReadError,
  describeShape,
  displayPath,
  isPlainMapping,
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

// ピン留めの出どころ (package.json の engines は「下限」なので別扱い。冒頭コメント参照)
const NVMRC_PATH = resolve(REPO_ROOT, ".nvmrc");
// 実行時に「走っている Node が .nvmrc と同じ major か」を確かめるスクリプト。
// 静的な検出網では見えない形 (run: の中で volta / nvm、式で決まるイメージ、
// 他リポジトリの再利用可能ワークフロー) を、綴りに依存せずまとめて塞ぐのがこれ。
// **どのジョブからも呼ばれなくなったら、静的な網だけが残って性質の担保が消える**ので、
// 少なくとも 1 つのワークフローが走らせていることを下の検査で固定する
const RUNTIME_VERIFIER = "scripts/verify-node-major.mjs";
// ワークフローは**ファイル名を書き並べず、置き場ごと**見る。
// 特定の 1 本 (ci.yml) だけを対象にすると、Node を用意する別のワークフローを足した瞬間に
// その 1 本だけが黙って検査から外れる (痕跡はテスト件数すら変わらない)
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");
const DOCKERFILE_PATH = resolve(REPO_ROOT, "Dockerfile");
// 必要環境を人向けに書いている場所 (コードと同じ major を指していないと読み手を誤らせる)
const README_PATH = resolve(REPO_ROOT, "README.md");

// major 保留の対象パッケージ名 (dependabot.yml の dependency-name と完全一致させる)
const GUARDED_DEPENDENCY = "@types/node";
// Dockerfile のベースイメージ側も同じ理由で major を保留している。
// **こちらにも保留のガードを置く。** 片方だけ見ていると、docker の ignore を消しても
// この検査はすべて緑のまま通り、気付けるのは「Dockerfile だけを別 major へ上げる PR が
// 毎週立って赤くなる」ときになる (赤いのが常態になった検査はいずれ緩められる)
const DOCKER_ECOSYSTEM = "docker";
// Dockerfile の置き場 (dependabot.yml の directory と一致させる)
const DOCKER_DIRECTORY = "/";
// 保留の対象イメージ名 (dependabot.yml の dependency-name と完全一致させる)
const GUARDED_BASE_IMAGE = "node";

/** 「実際に動く Node の major」をピン留めしている出どころ 1 つ分。 */
interface PinnedSource {
  // 失敗メッセージに出す、人が読める出どころの名前
  label: string;
  // 読み取れた major (読めなければ null)
  major: number | null;
}

/** 直接依存 1 つ分の「サポートする Node の範囲」。 */
interface DependencyEngine {
  // パッケージ名 (失敗メッセージに出す)
  name: string;
  // その依存が engines.node に宣言している範囲
  range: string;
}

/**
 * ファイルを文字列として読む。存在しなければ null を返す。
 *
 * 読めないこと自体を「前提崩れ」として呼び出し側で落とすため、ここでは例外にしない
 * (describe のトップレベルで例外を投げると、丁寧に書いた失敗文言が 1 つも出ない)。
 */
function readTextOrNull(path: string): string | null {
  try {
    // UTF-8 のテキストとして読み込む
    return readFileSync(path, "utf8");
  } catch {
    // 存在しない・読めない場合は null を返し、呼び出し側の存在確認で落とす
    return null;
  }
}

/**
 * `#` から行末までのコメントを落とした行の配列を返す。
 *
 * コメントを残したまま数字を拾うと、`# 次の LTS (28) へ上げる予定` のような解説行を
 * 設定値として読んでしまい、存在しない食い違いを報告する。
 */
function stripComments(text: string): string[] {
  // 行に分けたうえで、各行の `#` 以降を落とす
  return text.split("\n").map((line) => line.replace(/#.*$/, ""));
}

/**
 * `.nvmrc` に書かれた major を読み取る。
 *
 * major だけを書く運用だが、先頭の `v` とコメント行は許す。
 */
function readNvmrcMajor(): number | null {
  // ファイルを読む (読めなければ null)
  const text = readTextOrNull(NVMRC_PATH);
  if (text === null) return null;
  // コメントを落としたうえで、最初に数字が現れる行を探す
  for (const line of stripComments(text)) {
    // 先頭の `v` を許して major の数字を取り出す
    const matched = line.trim().match(/^v?(\d+)/);
    if (matched) return Number(matched[1]);
  }
  // 数字が 1 つも無ければ読めなかった扱い
  return null;
}

/** 置き場の一覧を読んだ結果 (読めたファイル名と、読めなかったときの原因)。 */
interface WorkflowListing {
  // 走査対象のワークフローのファイル名
  files: string[];
  // 置き場ごと読めなかったときの原因 (読めたなら null)
  error: string | null;
}

/**
 * `.github/workflows/` に置かれたワークフローのファイル名を並べる。
 *
 * ディレクトリを読むのは、**対象を名前で書き並べると増えた分が黙って外れる**から
 * (`ci.yml` だけを見る形だと、Node を用意する 2 本目を足しても検査は緑のまま通り、
 *  痕跡はテスト件数にも出ない)。
 *
 * **読めなかった原因は握り潰さず持ち帰る (§6)。** 空を返すだけにすると、置き場の
 * 改名・削除・権限といった**入力側の事故**が、呼び出し側の「setup-node が 1 つも無い」
 * = **ワークフローの書き方の問題**という別の文言で報告される (errno も消える)。
 * 同じ差分で足した `readParsed` が原因を `ReadResult` に載せて運ぶのと同じ扱いにそろえる。
 */
function listWorkflowFiles(): WorkflowListing {
  try {
    // 拡張子が .yml / .yaml のものだけを対象にする (README などを YAML として解釈しない)
    const files = readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/i.test(name));
    // 読めたので、原因は無しとして返す
    return { files, error: null };
  } catch (error) {
    // 原因を添えて返す (絶対パスを文言に混ぜないよう共有の整形を通す)
    return { files: [], error: describeReadError(error, REPO_ROOT) };
  }
}

/** ワークフロー 1 本の中の 1 ジョブ (どのファイルの、どの名前で、中身は何か)。 */
interface WorkflowJob {
  // 失敗メッセージに出す、どのワークフローかを示すファイル名
  file: string;
  // ジョブ名 (jobs 直下のキー)
  name: string;
  // そのジョブの定義 (steps / container などを読む)
  definition: Record<string, unknown>;
}

/**
 * ジョブの `steps` が構造として読めるかを調べ、読めない理由を返す (読めれば null)。
 *
 * **`steps` を持たないジョブは正当**なので null を返す (再利用可能ワークフローの
 * 呼び出しは `jobs.<id>.uses:` だけを持つ)。落とすのは「あるのに読めない」形だけ:
 *   - `steps: "npm ci && npm run test"` … 配列でないので `Array.isArray` が偽になり、
 *     ジョブは「steps を持たない」と同じ扱い = 3 つの検査すべてから外れる。
 *   - `steps: ["npm ci && npm run test"]` … 要素が対応表でないので `asRecord` が
 *     `{}` に潰し、`run:` も `uses:` も無いステップとして見える。
 * どちらも実測で全件緑のまま通った (`jobs` とジョブ定義で塞いだ fail-open が
 * 1 段下に残っていた形)。GitHub 側では構文エラーになる書き方なので、
 * 「読めないなら落とす」で正当なワークフローを巻き添えにすることもない。
 */
function describeStepsProblem(steps: unknown): string | null {
  // steps が無いジョブは正当 (再利用可能ワークフローの呼び出し)
  if (steps === undefined) return null;
  // あるのに配列でなければ、ステップを 1 つも読めない
  if (!Array.isArray(steps)) return `steps が配列ではありません (${describeShape(steps)})`;
  // 要素の位置を添えて、対応表でないものを探す
  const badIndex = steps.findIndex((step) => !isPlainMapping(step));
  // 1 つでもあれば、そのステップは run: も uses: も読めない
  if (badIndex !== -1) {
    return `steps[${badIndex}] が対応表ではありません (${describeShape(steps[badIndex])})`;
  }
  // すべて読める形
  return null;
}

/** 置き場のワークフローを 1 本ずつ読んだ結果 (読めたジョブと、読めなかったファイル)。 */
interface WorkflowScan {
  // 読めたワークフローから取り出した全ジョブ
  jobs: WorkflowJob[];
  // 読めなかった / 構造として解釈できなかったワークフロー (ファイル名と原因)
  unreadable: string[];
  // 置き場そのものが読めなかったときの原因 (読めたなら null)
  listError: string | null;
}

/**
 * 置き場のワークフローすべてを読み、ジョブを平らに並べる。
 *
 * **走査を 1 か所に集めるのが目的。** Node の版が入り込む口は 3 つ
 * (`setup-node` の `with` / ジョブの `container:` / `setup-node` の書き忘れ) あり、
 * どの検査も「どのワークフローの、どのジョブを見るか」は同じでなければならない。
 * 走査を各検査に書き写すと、1 つだけ対象範囲を直したときに
 * **残りの検出網が黙って狭くなる** (このリポジトリが繰り返し踏んでいる形)。
 *
 * **読めなかった 1 本は「ジョブ 0 件」で済ませず、名指しで返す。**
 * 済ませてしまうと 2 通りの壊れ方をする (どちらも実測):
 *   - 壊れた YAML … `parseYaml` がその場で例外を投げ、丁寧に書いた失敗文言が
 *     1 つも出ないまま素の `YAMLParseError` とスタックトレースだけが残る。
 *   - 空 / 全体コメントアウトの `.yml` … 例外は出ず jobs 0 件になるので、
 *     **他に正しい `ci.yml` が 1 本あれば「1 つも無い」検査を通過し、
 *     その 1 本だけが黙って検査から外れる** (= 見逃す側へ倒れる fail-open)。
 * 読み取りと「トップレベルがオブジェクトか」の判定は、同じ理由で作られている
 * 共有の `readParsed` に任せる (§6 DRY)。判定は呼び出し側の fail-closed な検査が行う。
 */
function scanWorkflows(): WorkflowScan {
  // 読めたジョブを溜める入れ物
  const jobs: WorkflowJob[] = [];
  // 読めなかったワークフローを原因付きで溜める入れ物
  const unreadable: string[] = [];
  // 置き場の一覧を読む (読めなければ原因を呼び出し側へ運ぶ)
  const listing = listWorkflowFiles();
  // 置き場にあるワークフローを 1 本ずつ見る
  for (const file of listing.files) {
    // 読んで YAML として解釈する (例外は投げず、原因を戻り値に載せてくれる)
    const read = readParsed(resolve(WORKFLOWS_DIR, file), parseYaml);
    // 読めなかった 1 本は名指しで控え、ジョブは取り出さない。
    // 絶対パスをそのまま出さないよう、共有の整形を通す (CI と手元で文言をそろえる)
    if (read.error !== null) {
      unreadable.push(`${file}: ${describeReadError(read.error, REPO_ROOT)}`);
      continue;
    }
    // **`jobs` が対応表になっていることまで確かめる。**
    // `readParsed` が見るのはトップレベルだけなので、`jobs: "extra"` のような形は
    // 例外にならず `asRecord` が `{}` に潰す = そのワークフローが黙って検査から外れる
    // (トップレベルで塞いだのと同じ fail-open が 1 段下に残っていた。実測)
    const jobsValue = asRecord(read.value).jobs;
    if (!isPlainMapping(jobsValue)) {
      unreadable.push(`${file}: jobs が対応表ではありません (${describeShape(jobsValue)})`);
      continue;
    }
    // jobs 直下をジョブ名付きで平らに並べる
    for (const [name, definition] of Object.entries(jobsValue)) {
      // ジョブの中身も対応表でなければ、steps も container も読めない = 見逃す側に倒れる
      if (!isPlainMapping(definition)) {
        unreadable.push(
          `${file}: ジョブ ${name} の定義が対応表ではありません (${describeShape(definition)})`,
        );
        continue;
      }
      // **`steps` の 1 段下も同じ扱いで見る。** `steps: "npm ci"` や
      // `steps: ["npm ci"]` は例外にならず、配列判定 / `asRecord` が黙って潰すため、
      // そのジョブが 3 つの検査すべてから外れる (`jobs` と ジョブ定義で塞いだのと
      // 同じ fail-open が 1 段下に残っていた。実測で全件緑のまま通った)
      const stepsProblem = describeStepsProblem(definition.steps);
      if (stepsProblem !== null) {
        unreadable.push(`${file}: ジョブ ${name} の ${stepsProblem}`);
        continue;
      }
      // 読めたジョブを、どのワークフローの何という名前かと一緒に控える
      jobs.push({ file, name, definition });
    }
  }
  // ジョブ・読めなかったファイル・置き場の読み取り失敗を返す (すべて呼び出し側が検査する)
  return { jobs, unreadable, listError: listing.error };
}

/**
 * `uses:` が Node 準備アクションを指しているかを判定する形。
 *
 * バージョン指定 (`actions/setup-node@v7` / `@<sha>`) を許しつつ、**名前はそこで終わる**
 * ことを求める。前方一致だけにすると `actions/setup-node-foo@v1` のような別アクションまで
 * 拾い、「`node-version-file: '.nvmrc'` を渡せ」という**直しようの無い要求**を出す
 * (`isNodeImage` が `myorg/node-tools` を巻き込まないのと同じ理由。
 *  無関係なものを赤くする検出網はいずれ緩められる)。
 *
 * **大文字小文字は区別しない (`i`)。** GitHub は `uses:` の owner/repo を
 * 大文字小文字を無視して解決するので、`Actions/Setup-Node@v7` と書いた
 * ステップは**実際に動く**。区別する判定にすると、そのステップだけが検査から外れ、
 * `.nvmrc` と別の major で CI が回る (実測で全件緑のまま通った)。
 */
const SETUP_NODE_USES = /^actions\/setup-node(@|$)/i;

/**
 * ジョブの `steps` を対応表の配列として取り出す (steps を持たないジョブは null)。
 *
 * **取り出しと「setup-node のステップか」の判定は、ここと `isSetupNodeStep` の
 * 2 つだけに置く。** 版が入り込む口ごとに書き写すと、認識のしかたを直したとき
 * (ローカルの `./.github/actions/setup-node` も数える、`if:` 付きは数えない 等) に
 * 片方だけが直り、**2 つの検査が黙って食い違う** (この差分自身の `scanWorkflows` /
 * `isPlainMapping` の docstring が警告している形)。
 *
 * null と空配列を区別するのは、「steps が無いジョブ」(再利用可能ワークフローの呼び出し)
 * と「steps が空のジョブ」で扱いが違うため。前者は steps がこのリポジトリの外にあるので
 * `setup-node` を要求しても置く場所が無い。
 */
function stepRecordsOf(job: WorkflowJob): Record<string, unknown>[] | null {
  // steps の値を取り出す
  const steps = job.definition.steps;
  // 配列でなければ「steps を持たないジョブ」として null を返す
  if (!Array.isArray(steps)) return null;
  // 要素が対応表であることは `scanWorkflows` (describeStepsProblem) が保証済みなので、
  // ここで `asRecord` を重ねない。**重ねると害がある** — 将来その fail-closed を
  // 緩めたとき、`steps: ["npm ci"]` が黙って `[{}]` (run: も uses: も無いステップ) に
  // 化けて、そのジョブが 3 つの検査すべてから静かに外れる (c53c6de で塞いだ形が
  // 復活する)。§6 デッドコードを残さない、とも整合する
  return steps as Record<string, unknown>[];
}

/**
 * ステップの `uses:` を文字列として読む (未指定なら空文字列)。
 *
 * **読み方をここ 1 か所に置く。** `uses:` は 3 つの検査が見る同じ 1 つの手掛かりで
 * (setup-node かどうか / ローカル action の呼び出しか / `docker://` のイメージか)、
 * 読み方を書き写すと、読み方を直したとき (前後の空白を落とす、`../` も数える 等) に
 * 一部だけが直り、**同じステップ集合を見るはずの検査が黙って食い違う**
 * (この差分自身が `stepRecordsOf` / `isPlainMapping` の docstring で警告している形)。
 */
function usesOf(step: Record<string, unknown>): string {
  // uses が無いステップ (run: だけのステップ) は空文字列として扱う
  return String(step.uses ?? "");
}

/** そのステップが `actions/setup-node` を呼んでいるか。 */
function isSetupNodeStep(step: Record<string, unknown>): boolean {
  // uses を文字列として照合する (未指定なら空文字列 = 一致しない)
  return SETUP_NODE_USES.test(usesOf(step));
}

/**
 * その `setup-node` ステップが **必ず効く** 置き方かを判定する。
 *
 * 「置いてあること」だけでは足りない。**効かなくても後続が走る**書き方が 2 つあり、
 * どちらも結果は同じ（ランナー既定の Node でスイートが走るのに CI は緑）:
 *   - `if:` … 条件が偽なら実行されない。条件の中身は静的に決まらないので、
 *     「無条件でない」ことをもって落とす。
 *   - `continue-on-error:` … ステップが失敗しても**ジョブは成功で終わる**。
 *     `.nvmrc` の版が setup-node のマニフェストにまだ無い等で失敗したとき、
 *     以降の `npm ci` / `npm run test` はランナー既定の Node で走り、しかも緑になる
 *     (実測: これを付けた形は検査を全件緑のまま通っていた)。
 *     明示的な `false` だけは、効かない書き方ではないので通す。
 */
function isUnconditionalSetupNode(step: Record<string, unknown>): boolean {
  // setup-node のステップでなければ対象外
  if (!isSetupNodeStep(step)) return false;
  // if: が付いていれば、実行されない可能性がある
  if ("if" in step) return false;
  // continue-on-error は「明示的に false」以外を、効かなくても進む書き方として扱う
  return !("continue-on-error" in step) || step["continue-on-error"] === false;
}

/** ワークフロー 1 本の中の `actions/setup-node` ステップ 1 つ分。 */
interface SetupNodeStep {
  // 失敗メッセージに出す、どのワークフローのステップかを示す名前
  file: string;
  // ジョブ名 (同じファイルに setup-node を持つジョブが 2 つあると、
  // ファイル名だけではどちらを直せばよいか分からない。姉妹の 2 つの検査も job を出す)
  job: string;
  // そのステップの `with`（判定の対象）
  inputs: Record<string, unknown>;
}

/**
 * CI の Node 準備ステップが「どう版を決めているか」を集める。
 *
 * **版そのものではなく配線を見るのが要点。** ワークフローに版を書き写す形
 * (`node-version: '26'` や `env.NODE_VERSION`) だと、その値が `.nvmrc` とずれても
 * 「両方を突き合わせる」検査でしか気付けず、しかも `setup-node` の `with` を
 * 書き換えれば宣言だけ残して実際には別の Node を入れられる (env を読むだけの検査は
 * それを緑のまま通す。実測)。`node-version-file: '.nvmrc'` にしておけば、
 * **CI が入れる Node はピンそのもの**になり、ずれが原理的に起きない。
 *
 * 返すのは各 `actions/setup-node` ステップの `with` で、判定は呼び出し側が行う。
 */
function collectSetupNodeSteps(jobs: readonly WorkflowJob[]): SetupNodeStep[] {
  // 共有の走査で平らに並べたジョブを受け取り、各ジョブの steps を見る
  return jobs.flatMap((job) => {
    // steps を持たないジョブ (再利用可能ワークフローの呼び出し) には準備ステップが無い
    const steps = stepRecordsOf(job);
    if (steps === null) return [];
    // setup-node のステップに絞り、その with をファイル名・ジョブ名付きで返す
    return steps
      .filter(isSetupNodeStep)
      .map((step) => ({ file: job.file, job: job.name, inputs: asRecord(step.with) }));
  });
}

/**
 * ジョブを 1 つに定めるキー (どのワークフローの、どの名前か) を作る。
 *
 * ジョブ名はワークフローごとに独立しているので、ファイル名と組にしないと
 * 別ファイルの同名ジョブを取り違える。
 */
function jobKey(file: string, job: string): string {
  // 「ファイル名 : ジョブ名」の形で 1 つの文字列にする
  return `${file}:${job}`;
}

/** ワークフロー 1 本の中で、node イメージを据えている箇所 1 つ分。 */
interface NodeImageUse {
  // 失敗メッセージに出す、どのワークフローのどのジョブかを示す名前
  file: string;
  // ジョブ名 (jobs 直下のキー)
  job: string;
  // 実際に書かれていたイメージ名 (どう直せばよいか分かるように、そのまま出す)
  image: string;
  // 書かれていた場所を、YAML に現れるとおりの 1 つの文字列で持つ
  // (`container: node:20` / `uses: docker://node:20`)。場所と値を別々に持って
  // 文言側で連結すると `uses: docker:// node:20` のように実在しない空白が入り、
  // 読み手がワークフローを grep しても見つからなくなる (実測)
  location: string;
}

/** ステップで直接コンテナイメージを走らせる書き方の接頭辞 (`uses: docker://node:20`)。 */
const DOCKER_USES_PREFIX = "docker://";

/**
 * イメージ名が Node の公式イメージを指しているかを判定する。
 *
 * レジストリ・名前空間の付いた書き方 (`docker.io/library/node:20`) でも拾えるよう、
 * **最後のパス区切り以降**をリポジトリ名として見る。タグ (`:20-alpine`) と
 * ダイジェスト (`@sha256:...`) は落としてから比べる。
 *
 * 判定を「名前が node と完全一致」に絞るのは、`myorg/node-tools` のような
 * 別物まで巻き込むと**直しようの無い要求**を出すことになるから
 * (この repo が繰り返し避けている形。無関係なものを赤くする検出網はいずれ緩められる)。
 *
 * **公式イメージ (名前空間が無いか `library`) だけを対象にする。** `ghcr.io/acme/node:1`
 * のようなベンダー製の別物まで拾うと、その中で `setup-node` を正しく使っていても
 * 落ち続ける (`container:` の中でも setup-node は動いて `.nvmrc` の Node を入れるので、
 * その形は正当。実測で誤検知になっていた)。
 */
function isNodeImage(image: string): boolean {
  // ダイジェスト指定 (`@sha256:...`) が付いていれば切り落とす
  const withoutDigest = image.split("@")[0];
  // レジストリ・名前空間を落として、最後のパス要素だけを取り出す
  const lastSegment = withoutDigest.split("/").pop() ?? "";
  // タグ (`:20-alpine`) を落として、リポジトリ名だけにする
  const repository = lastSegment.split(":")[0];
  // 名前が node でなければ別物 (node-tools 等は拾わない)
  if (repository !== "node") return false;
  // 名前空間を取り出す (`docker.io/library/node` なら library、`node` なら無し)
  const namespaces = withoutDigest.split("/").slice(0, -1);
  // 名前空間が無いか、公式の library だけを公式イメージとして扱う
  return namespaces.length === 0 || namespaces[namespaces.length - 1] === "library";
}

/**
 * 検出網を通さない例外を、**理由と適用範囲つき**で 1 枚にまとめた表。
 *
 * キーは `jobKey` と同じ「ワークフローのファイル名 : ジョブ名」。値は**どの検査を
 * 免除するか**を明示する (省略した検査には効かない)。
 *   - `setupNode` … このジョブはリポジトリのコードを Node で走らせない
 *     (例: `run: shellcheck scripts/x.sh` だけのジョブ)。
 *   - `image` … このジョブの `uses: docker://` はイメージに Node を持ち込まない
 *     (例: `docker://hadolint/hadolint`)。
 *
 * **範囲を分けているのが要点。** 1 つの理由で両方を免除する形にすると、
 * 「イメージは Node と無関係」と登録しただけで**同じジョブの `run: npm ci` に対する
 * `setup-node` の要求まで黙って外れる** — しかも失敗文言が登録を勧めるので、
 * 検出網が自分で塞いだ穴の開け方を案内することになる (実測で全件緑。
 * `docker://hadolint` + `run: npm ci && npm run test` が通った)。
 *
 * **これがあるので検査を fail-closed にできる。** 「Node を使っているか」を `run:` の
 * 文言から当てる形 (以前の `NODE_TOOLING_COMMAND`) は、綴りが変わるだけで黙って対象から
 * 外れた (実測: `./node_modules/.bin/vitest run` も `/usr/local/bin/node server.js` も
 * 拾えなかった)。判定は**構造**で行い、当てはまらない例外だけをここへ 1 行ずつ登録する。
 * 表に無いジョブは検査が拾って落ちるので、**次に同じ形のジョブを足す人は
 * 「setup-node を置くか、除外するか」を必ず一度決める**ことになる
 * (incident-insight の除外表と同じ考え方)。
 *
 * **現在は空** — 除外の必要なジョブがまだ無い。エントリが増える差分は、
 * 理由の妥当性をレビューで必ず確認する (署名からは「Node と無関係か」を判定できない、
 * 人が判断するエスケープハッチ)。
 */
interface JobExemption {
  // setup-node の要求を免除する理由 (省略 = 免除しない)
  setupNode?: string;
  // uses: docker:// のイメージ検査を免除する理由 (省略 = 免除しない)
  image?: string;
}

const NODE_GUARD_EXEMPTIONS: Readonly<Record<string, JobExemption>> = {};

/**
 * 除外表のうち、**実在しないジョブ**を指しているキーを集める。
 *
 * 判定を関数に出しているのは、表が空のあいだ `Object.keys({})` が常に `[]` を返し、
 * **判定を反転させても全件緑のまま通る**から (実測)。最初の除外が足された時点で
 * 腐りを見逃すようになるので、合成した表を渡すテストで判定自体を固定する。
 */
function staleExclusions(
  table: Readonly<Record<string, JobExemption>>,
  existingJobKeys: ReadonlySet<string>,
): string[] {
  // 実在するジョブのキーに無いものだけを残す
  return Object.keys(table).filter((key) => !existingJobKeys.has(key));
}

/**
 * 除外表のうち、**理由として読めない登録**を集める。
 *
 * 2 通りある: 書いた理由が空・空白だけ (値を読まない検査だと空白で黙らせられる) と、
 * 免除する検査を 1 つも書いていない登録 (何も免除しないのに「除外済み」に見える)。
 */
function exclusionsWithoutReason(table: Readonly<Record<string, JobExemption>>): string[] {
  // 登録を 1 つずつ見て、読めない理由を持つキーだけを残す
  return Object.entries(table)
    .filter(([, exemption]) => {
      // 書かれている理由だけを取り出す
      const reasons = [exemption.setupNode, exemption.image].filter(
        (reason): reason is string => reason !== undefined,
      );
      // 1 つも書いていない、または空白だけの理由があれば読めない登録
      return reasons.length === 0 || reasons.some((reason) => reason.trim() === "");
    })
    .map(([key]) => key);
}

/**
 * そのステップが**このリポジトリのコードを実行する**かを判定する。
 *
 * 2 つの形を数える:
 *   - `run:` … シェルに渡す中身はこのリポジトリのコード。
 *   - `uses: ./...` … リポジトリ内の composite action で、やはり中身はこのリポジトリのコード
 *     (`action.yml` の中身は読まないが、**呼んでいる事実**はジョブ側に構造として現れる)。
 *
 * `uses:` が第三者のアクション (`actions/checkout@v7` 等) のステップは数えない。
 * JS アクションはランナー自身の Node で動き、`setup-node` が入れた Node とは無関係なので、
 * それを理由に `setup-node` を要求すると**直しようの無い要求**になる。
 */
function runsRepositoryCode(step: Record<string, unknown>): boolean {
  // run: に中身があれば、リポジトリのコードを走らせている
  if (typeof step.run === "string" && step.run.trim() !== "") return true;
  // ローカルの composite action 呼び出しも同じ扱いにする
  return usesOf(step).startsWith("./");
}

/**
 * 失敗文言に出す、`with:` の指定内容の説明。
 *
 * **`JSON.stringify` を使わない。** YAML はアンカーで自己参照する値が書けるため
 * (`with: &w { node-version: '20', self: *w }`)、循環参照になると
 * `JSON.stringify` が例外を投げ、**丁寧に書いた失敗文言の代わりに素の TypeError** が
 * 残る (実測。共有ライブラリの `describeShape` が避けている形そのもの)。
 * そこで値は `String()` か `describeShape` で固定長の語句に落としてから並べる。
 */
function describeInputs(inputs: Record<string, unknown>): string {
  // 指定が無ければその旨を出す (空の {} だけを見せても読み手に伝わらない)
  if (Object.keys(inputs).length === 0) return "with: の指定なし";
  // キーと値を 1 つずつ、安全に文字列化して並べる
  return Object.entries(inputs)
    .map(([key, value]) => {
      // 入れ子の対応表・配列は中身を出さず「形」だけにする (循環参照でも安全)
      const shown =
        isPlainMapping(value) || Array.isArray(value) ? describeShape(value) : String(value);
      // 「キー=値」の形にそろえる
      return `${key}=${shown}`;
    })
    .join(", ");
}

/** 失敗文言に出す、ステップ 1 つの短い説明。 */
function describeStep(step: Record<string, unknown>): string {
  // run: なら最初の 1 行だけを出す (複数行をそのまま出すと文言が読めなくなる)
  const run = typeof step.run === "string" ? step.run.trim().split("\n")[0] : "";
  // run: に中身があれば、その 1 行を説明として使う
  if (run !== "") return `run: ${run}`;
  // run: が無ければローカル action の呼び出し
  return `uses: ${usesOf(step)}`;
}

/** `setup-node` の置き方が足りていないジョブ 1 つ分。 */
interface MissingSetupNodeJob {
  // 失敗メッセージに出す、どのワークフローかを示すファイル名
  file: string;
  // ジョブ名 (jobs 直下のキー)
  job: string;
  // 何が足りないか (無い / 条件付き / 順序が後ろ) を読み手に伝える理由
  reason: string;
}

/**
 * このリポジトリのコードを実行するのに、**無条件の `setup-node` をその前に**
 * 置いていないジョブを集める。
 *
 * **版が入り込む 3 つ目の口で、しかも「書き忘れ」で到達する。**
 * GitHub ホストのランナー (`ubuntu-latest`) には Node が最初から入っているため、
 * `setup-node` を 1 つも置かないジョブで `npm ci && npm run test` と書くと、
 * **ランナー既定の major** でスイートが丸ごと走る。`.nvmrc` は一切参照されない。
 * `setup-node` の `with` と `container:` だけを見る検査はこれを**全件緑のまま通す** (実測)。
 *
 * 「置いてあるか」だけでは足りず、**位置と条件**まで見る (どちらも実測で素通りした):
 *   - `run: npm ci` の**後ろ**に `setup-node` … `npm ci` はランナー既定の Node で走り、
 *     そこで入る / ビルドされる node_modules は検証していない Node のもの。
 *   - `if:` 付きの `setup-node` … 実行されなければランナー既定の Node のまま。
 *     条件の中身は静的に決まらないので、「無条件でない」ことをもって落とす。
 *
 * 判定を `run:` の**文言**から当てないのは、綴りを変えるだけで黙って外れるから
 * (以前の形の実測は `NODE_GUARD_EXEMPTIONS` の docstring に書いた)。構造で見て、
 * 例外は理由付きの表へ登録させる (fail-closed)。
 *
 * すでに `container:` の検査が名指ししたジョブは除く (同じジョブを 2 通りの文言で
 * 報告すると、どちらを直せばよいのか読み手に伝わらない)。
 */
function collectJobsMissingSetupNode(
  jobs: readonly WorkflowJob[],
  excludedJobKeys: ReadonlySet<string>,
): MissingSetupNodeJob[] {
  // 平らに並べたジョブを 1 つずつ見る
  return jobs.flatMap((job) => {
    // このジョブを一意に指すキー
    const key = jobKey(job.file, job.name);
    // container: の検査が既に名指ししたジョブは、そちらの文言に任せる
    if (excludedJobKeys.has(key)) return [];
    // setup-node の要求を免除すると登録されたジョブは対象外 (表の健全性は専用の検査が見る)
    if (NODE_GUARD_EXEMPTIONS[key]?.setupNode !== undefined) return [];
    // steps が無いジョブ (再利用可能ワークフローの呼び出し) は要求しても置く場所が無い
    const steps = stepRecordsOf(job);
    if (steps === null) return [];
    // このリポジトリのコードを最初に実行するステップの位置
    const firstRepoCode = steps.findIndex(runsRepositoryCode);
    // 1 つも無ければ、第三者アクションだけのジョブなので対象外
    if (firstRepoCode === -1) return [];
    // **ジョブ単位の `continue-on-error` も同じ結末を招く。** 付いているとジョブが
    // 失敗してもワークフローは成功で報告されるので、setup-node が失敗して
    // lint / typecheck / test が 1 つも走らなくても CI は緑になる (実測で素通りした)。
    // ステップ側と同じく、明示的な false 以外を「効かなくても進む書き方」として扱う
    const jobContinues =
      "continue-on-error" in job.definition && job.definition["continue-on-error"] !== false;
    if (jobContinues) {
      return [
        {
          file: job.file,
          job: job.name,
          reason: "ジョブに continue-on-error が付いている (失敗しても CI は緑になる)",
        },
      ];
    }
    // 必ず効く setup-node の位置 (if: / continue-on-error 付きは数えない)
    const setupIndex = steps.findIndex(isUnconditionalSetupNode);
    // 無条件の setup-node が 1 つも無い場合は、条件付きの有無で文言を分ける
    if (setupIndex === -1) {
      // setup-node 自体はあるなら、書き忘れではなく「効かない置き方」だと伝える
      const reason = steps.some(isSetupNodeStep)
        ? "setup-node に if: / continue-on-error が付いている (効かなくても後続が走る)"
        : "setup-node が無い";
      return [{ file: job.file, job: job.name, reason }];
    }
    // 置いてあっても、リポジトリのコードより後ろなら前半はランナー既定の Node で走る
    if (setupIndex > firstRepoCode) {
      return [
        {
          file: job.file,
          job: job.name,
          reason: `setup-node が「${describeStep(steps[firstRepoCode])}」より後ろにある`,
        },
      ];
    }
    // 無条件の setup-node が、リポジトリのコードより前に置かれている = 期待どおり
    return [];
  });
}

/**
 * ステップの `uses: docker://<image>` を集める (イメージ名は問わない)。
 *
 * **`setup-node` が効かない唯一の口。** ジョブの `container:` と違い、この形は
 * **そのステップだけをイメージの中で丸ごと走らせる**ので、同じジョブに正しい
 * `setup-node` を置いても、そのステップの Node には何の影響も無い。
 * イメージ名で絞ると `docker://ghcr.io/acme/ci-node:20` のような形が素通りする
 * (実測で全件緑) ため、**名前を問わず**集めて、Node を持ち込まないと確認できた
 * ものだけを `NODE_GUARD_EXEMPTIONS` の `image` で通す。
 *
 * **`container:` はここでは見ない。** `container: node:20` でも `setup-node` は
 * コンテナの中で動いて `.nvmrc` の Node を入れるので、それ自体は誤りではない。
 * 誤りなのは「リポジトリのコードを走らせるのに `setup-node` が無い」ことのほうで、
 * それは `collectJobsMissingSetupNode` が `container:` の有無に関係なく落とす。
 * ここで node イメージを一律に落としていたときは、`container: node:26-alpine` +
 * 正しい `setup-node` という**正当な形に直しようの無い要求**が出ていた (実測)。
 */
function collectImageOnlySteps(jobs: readonly WorkflowJob[]): NodeImageUse[] {
  // 共有の走査で平らに並べたジョブを受け取り、各ステップの uses: を見る
  return jobs.flatMap((job) => {
    // イメージの検査を免除すると登録されたジョブは対象外
    if (NODE_GUARD_EXEMPTIONS[jobKey(job.file, job.name)]?.image !== undefined) return [];
    // 見つけた箇所を溜める入れ物
    const found: NodeImageUse[] = [];
    // 各ステップを順に見る (steps が無いジョブは空で回す)
    for (const step of stepRecordsOf(job) ?? []) {
      // uses を文字列として取り出す
      const uses = usesOf(step);
      // docker:// で始まらないステップはイメージを直接走らせていない
      if (!uses.startsWith(DOCKER_USES_PREFIX)) continue;
      // 接頭辞を落としてイメージ名だけにする
      const image = uses.slice(DOCKER_USES_PREFIX.length);
      // どのワークフローのどのジョブが、どのイメージを走らせているかを控える
      found.push({ file: job.file, job: job.name, image, location: uses });
    }
    // このジョブで見つかった箇所をすべて返す
    return found;
  });
}

/**
 * Dockerfile が使う Node のベースイメージ major を読み取る。
 *
 * **最初の 1 件だけを見ない。** 多段ビルドで `FROM node:22-alpine AS tools` のような
 * 別 major の段が足されると、先頭だけを見る実装では揃っているように見えてしまい、
 * まさに検出したいドリフトを見逃す。すべての `FROM` の node イメージを集め、
 * 揃っていなければ「読めなかった」として呼び出し側で落とす。
 *
 * **イメージ名は `isNodeImage` と同じ解析に通す。** 以前は `FROM node:(\d+)` という
 * 狭い正規表現で、`FROM docker.io/library/node:22-alpine AS tools` や
 * `FROM --platform=linux/amd64 node:22` を**素通り**させていた (実測で全件緑。
 * まさに多段ビルドのドリフトを見逃す形)。ワークフロー側で同じ取りこぼしを塞いだ
 * 判定があるので、そこへ寄せて書き写しも増やさない (§6 DRY)。
 */
function readDockerfileNodeMajor(): number | null {
  // Dockerfile を読む (読めなければ null)
  const text = readTextOrNull(DOCKERFILE_PATH);
  if (text === null) return null;
  // コメントを落としたうえで、すべての `FROM node:<major>` を集める
  const majors = new Set<number>();
  for (const line of stripComments(text)) {
    // 行頭の FROM 命令だけを対象にする (大文字小文字は Docker 側が区別しない)
    const matched = line.match(/^\s*FROM\s+(.+)$/i);
    // FROM でなければ次の行へ
    if (!matched) continue;
    // `--platform=...` のようなフラグを読み飛ばし、最初の非フラグ語をイメージ名として取る
    const image = matched[1]
      .trim()
      .split(/\s+/)
      .find((word) => !word.startsWith("--"));
    // イメージ名が無い行 (壊れた FROM) は対象外
    if (image === undefined) continue;
    // 公式の node イメージでなければ対象外 (ビルドに使う別イメージの段は見ない)
    if (!isNodeImage(image)) continue;
    // タグから major を取り出す (`node:26-alpine` → 26。ダイジェストだけの指定は読めない)
    const tag = image.split("@")[0].split(":")[1] ?? "";
    const major = tag.match(/^(\d+)/);
    // 数字で始まるタグだけを採用する (`node:lts` のような形は「読めない」に倒す)
    if (major) majors.add(Number(major[1]));
  }
  // ちょうど 1 つに揃っているときだけ採用する (0 件 = 読めない / 2 件以上 = 段ごとに食い違い)
  return majors.size === 1 ? [...majors][0] : null;
}

/**
 * README の「Node.js <major> 系」に書かれた major を読み取る。
 *
 * 人向けの必要環境で、ここだけ古い major が残ると読み手を誤らせる
 * (「20 でいい」と思って動かない環境を作らせる)。書式は 1 行だけなので素直に拾う。
 */
function readReadmeNodeMajor(): number | null {
  // README を読む (読めなければ null)
  const text = readTextOrNull(README_PATH);
  if (text === null) return null;
  // 「Node.js 26 系」の形から major を取り出す。
  // **「26 以上」と書かない** — 実際に検証しているのはピン留めした系列だけで、
  // 「以上」は検査より緩い約束になる (読み手が 28 を入れると、`@types/node@^26` の
  // 型で 28 のランタイムを型チェックするという、この規約が防ぎたい形が裏返しで起きる)
  const matched = text.match(/Node\.js\s+(\d+)\s*系/);
  // 形が合わなければ読めなかった扱い
  return matched ? Number(matched[1]) : null;
}

/**
 * 「実際に動く Node の major」をピン留めしている 2 か所を読み取って並べる。
 *
 * 1 か所だけを正としないのは、上げ忘れたときに**残りと食い違う**ことこそが
 * 検出したい状態だから。両方を返し、呼び出し側で「読めたか」「揃っているか」を見る。
 *
 * **CI はここに含めない。** 版を書き写す形をやめて `.nvmrc` を参照する配線にしたので、
 * CI が入れる Node はピンそのものになった (突き合わせる相手が存在しない)。
 * 代わりに「その配線が保たれているか」を専用のテストで見る。
 */
function collectPinnedSources(): PinnedSource[] {
  // 2 つの出どころをラベル付きで並べて返す
  return [
    { label: ".nvmrc", major: readNvmrcMajor() },
    { label: "Dockerfile (FROM node:<major>)", major: readDockerfileNodeMajor() },
  ];
}

/**
 * package.json の直接依存 (dependencies + devDependencies) の名前を並べる。
 *
 * ロックファイルの `packages[""]` ではなく package.json を読むのは、
 * 「このリポジトリが自分で選んだ依存」がここに書かれているから。推移依存まで見ると、
 * 自分では動かせないパッケージの `engines` で CI の Node を縛ることになる。
 */
function directDependencyNames(json: unknown): string[] {
  // 依存の 2 つの枝を取り出す (無ければ空オブジェクト扱い)
  const record = asRecord(json);
  const runtime = asRecord(record.dependencies);
  const dev = asRecord(record.devDependencies);
  // 名前を連結して返す (重複はしない前提だが、集合に通して念のため一意化する)
  return [...new Set([...Object.keys(runtime), ...Object.keys(dev)])];
}

/**
 * 直接依存のうち、ロックファイルで解決済みメタデータを引けなかったものを返す。
 *
 * **「読めた分だけ検査する」にしない。** 引けなかった依存は engines を宣言していても
 * 黙って対象から外れるので、「違反ゼロ＝緑」と見分けが付かない。全体が読めないときだけ
 * 落とす形にすると、15 件中 14 件が消えても緑のままになる (この検査の存在意義が薄れる)。
 */
function unresolvedDependencies(lock: unknown, names: readonly string[]): string[] {
  // ロックファイルの packages 枝を共有ヘルパーで取り出す
  const table = readLockPackages(lock);
  // 巻き上げ位置にメタデータが無い名前を集める
  return names.filter((name) => Object.keys(asRecord(table[`node_modules/${name}`])).length === 0);
}

/**
 * 直接依存のうち、`engines.node` を宣言しているものの範囲を集める。
 *
 * 宣言が無い依存は「どの Node でもよい」とみなして対象外にする
 * (npm 自体がそう扱うので、こちらで勝手に縛ると実在しない食い違いを報告する)。
 * 解決できなかった依存は unresolvedDependencies が別途落とすので、ここでは黙って外す。
 */
function collectDependencyEngines(lock: unknown, names: readonly string[]): DependencyEngine[] {
  // ロックファイルの packages 枝を共有ヘルパーで取り出す
  const table = readLockPackages(lock);
  // 名前ごとに、巻き上げ位置のメタデータから engines.node を引く
  return names.flatMap((name) => {
    // そのパッケージの解決済みメタデータ
    const meta = asRecord(table[`node_modules/${name}`]);
    // engines.node を取り出す
    const range = asRecord(meta.engines).node;
    // 文字列で宣言されているものだけを対象にする
    return typeof range === "string" ? [{ name, range }] : [];
  });
}

// 「その major 系列の最新版」を表す代役のバージョン。
// setup-node と `.nvmrc` は major だけを指定するので、実際に入るのはその系列の**最新**。
// 具体的な最新版はネットワークを見ないと分からないため、系列の上限に十分近い値で代用する
// (この 1 か所を読み替えれば判定の意味が変わるので、裸の数値を散らさない)
const LATEST_OF_MAJOR_PLACEHOLDER = { minor: 9999, patch: 9999 };

/**
 * 範囲が「その major 系列で実際に入る版」を許しているかを判定する。
 *
 * **`intersects(range, "26.x")` では緩すぎる。** 実測すると
 * `intersects("<26.1.0", "26.x")` も `intersects("^26.0.0 <26.2.0", "26.x")` も true で、
 * 「系列の一部しか許していない範囲」を通してしまう。CI に入るのはその系列の**最新**
 * なので、上限で切られた範囲は実際には満たされない。
 *
 * そこで「系列の十分新しい版」を 1 点作って `satisfies` で判定する。
 * `^22.12.0` のように下限へ minor/patch を持つ宣言を「22 系は不可」と誤判定する
 * (代表値を `22.0.0` にしたときの問題) こともない。
 *
 * **残る限界**: `>=26.9.0` のように「まだ出ていない版から」を要求する宣言は、
 * 現に入る最新版が 26.4.x でもここでは通る (最新版が何かはネットワークを見ないと
 * 分からないため)。実行時に `npm ci` が EBADENGINE で警告するので、そこで気付く。
 *
 * 範囲として解釈できない値は false を返し、呼び出し側で違反として報告させる
 * (読めない範囲を「たぶん大丈夫」と扱うと、検出網が静かに緩む)。
 */
function allowsMajor(range: string, major: number): boolean {
  try {
    // その系列の十分新しい版を satisfies に掛ける
    const latestOfMajor = `${major}.${LATEST_OF_MAJOR_PLACEHOLDER.minor}.${LATEST_OF_MAJOR_PLACEHOLDER.patch}`;
    return satisfies(latestOfMajor, range);
  } catch {
    // semver が解釈できない書き方は「許していない」側に倒す (fail-closed)
    return false;
  }
}

// 検査対象の設定ファイルは 1 度だけ読む (テストごとに読み直す必要はない)。
// ワークフローの走査も同じ扱い — 2 つの検査が使うので、テストごとに呼ぶと
// 置き場の YAML を全部読み直すことになる (この節の方針と食い違う)
const workflowScan = scanWorkflows();
const dependabotRead = readParsed(DEPENDABOT_PATH, (text) => parseYaml(text));
const packageJsonRead = readParsed(PACKAGE_JSON_PATH, (text) => JSON.parse(text));
const packageLockRead = readParsed(PACKAGE_LOCK_PATH, (text) => JSON.parse(text));
// ピン留めの読み取りも 1 度だけ行う
const pinnedSources = collectPinnedSources();
// 判定の基準になる実行時 major。ピンが揃っていない場合は null になり、
// それ自体を最初のテストが落とす (後続は「基準が無い」ことを明示して落ちる)
const runtimeMajor =
  new Set(pinnedSources.map((source) => source.major)).size === 1 ? pinnedSources[0].major : null;

// 対象パッケージに当たる ignore エントリ (件数・中身は個別のテストで確かめる)
const ignoreEntries = collectIgnoreEntries(
  (dependabotRead.value ?? {}) as DependabotConfig,
  NPM_ECOSYSTEM,
  NPM_DIRECTORY,
  GUARDED_DEPENDENCY,
);
// Dockerfile のベースイメージ側の ignore エントリ (同上)
const baseImageIgnoreEntries = collectIgnoreEntries(
  (dependabotRead.value ?? {}) as DependabotConfig,
  DOCKER_ECOSYSTEM,
  DOCKER_DIRECTORY,
  GUARDED_BASE_IMAGE,
);

describe("実行する Node の major を宣言しているすべての場所の整合", () => {
  it("検査に使う設定ファイルが読めて、構造として解釈できる", () => {
    // 3 つの入力のうち読めなかったものを、原因付きで並べる。
    // **名前も原因も共有の整形を通す。** 名前を文字列で書き写すと、定数を変えたときに
    // 「読んでいるファイル」と「文言が名指しするファイル」がずれる。原因をそのまま
    // 文字列化すると ENOENT のメッセージに実行機の絶対パスが載り、CI と手元で
    // 文言が食い違う (describeReadError はそれを畳むために作られている)
    const unreadable = [
      { path: DEPENDABOT_PATH, read: dependabotRead },
      { path: PACKAGE_JSON_PATH, read: packageJsonRead },
      { path: PACKAGE_LOCK_PATH, read: packageLockRead },
    ]
      .filter((input) => input.read.error !== null)
      .map(
        (input) =>
          `${displayPath(input.path)}: ${describeReadError(input.read.error, REPO_ROOT)}`,
      );
    // 1 つでも読めなければ、以降の判定は意味を持たないので前提崩れとして落とす
    expect(unreadable, `設定ファイルを読めない: ${unreadable.join(" / ")}`).toEqual([]);
  });

  it("CI が Node の版を書き写さず、.nvmrc を参照して用意している", () => {
    // 置き場のワークフローの走査結果 (module スコープで 1 度だけ読んだもの)
    const workflows = workflowScan;
    // **置き場ごと読めなかった場合は、その事実を原因付きで落とす。**
    // 下の「setup-node が 1 つも無い」で落とすと、置き場の改名・削除・権限という
    // 入力側の事故が「ワークフローの書き方の問題」として報告される (§6 握り潰さない)
    expect(
      workflows.listError,
      `${displayPath(WORKFLOWS_DIR)} を読めない: ${String(workflows.listError)}。` +
        "置き場を改名・移動したなら、この検査の走査先も合わせて直すこと。",
    ).toBeNull();
    // **読めない 1 本を先に落とす。** ジョブ 0 件で済ませると、他に正しい ci.yml が
    // あるかぎり以降の検査を通過し、その 1 本だけが黙って検査から外れる (fail-open)
    expect(
      workflows.unreadable,
      `.github/workflows/ に読めない・構造として解釈できないワークフローがある: ${workflows.unreadable.join(" / ")}。` +
        "そのファイルは Node の版を直書きしていても検査をすり抜けるため、前提崩れとして落としている。",
    ).toEqual([]);
    // 読めたジョブから Node 準備ステップを集める
    const setupSteps = collectSetupNodeSteps(workflows.jobs);
    // 1 つも無ければ、CI が Node を用意していない (= 検証していない) ので落とす。
    // **soft にする。** hard だとここで中断するので、`container: node:20` に置き換えて
    // setup-node を消した形 (まさに 2 つ目の口が名指ししたい形) で、読み手には
    // 「検出網が書式変更に追随できていない」という別の疑いだけが表示される (実測)。
    // CI が本当に Node を使わなくなった場合は、この検査ごと見直す対象になる
    // (除外表で黙らせる類のものではない)
    expect.soft(
      setupSteps.length,
      ".github/workflows/ に actions/setup-node のステップが見つからない。CI が Node を用意していないか、読み取り側が書式の変更に追随できていない。",
    ).toBeGreaterThan(0);
    // すべてのステップが `.nvmrc` を参照していることを確かめる。
    // **`node-version` を書いた形は、値が合っていても許さない** — 合っているかどうかは
    // その瞬間の話で、片方だけ書き換えれば静かにずれる (版を書き写せる構造そのものを断つ)。
    // **綴りは素の `.nvmrc` だけを認める (意図的)。** `'./.nvmrc'` は setup-node では
    // 同じファイルを指すがここでは落ちる。許す綴りを増やすと「同じものを指す書き方」の
    // 一覧を抱え込むことになり、しかも誤りは**赤へ倒れる**ので見逃す側には転ばない
    // (失敗文言が実際の指定を出すため、直し方も迷わない)
    const misconfigured = setupSteps
      .filter(
        (step) =>
          step.inputs["node-version-file"] !== displayPath(NVMRC_PATH) ||
          "node-version" in step.inputs,
      )
      .map((step) => `${step.file}: ${step.job} (${describeInputs(step.inputs)})`);
    // **3 つの口の判定は soft にする。** 通常の expect は最初の 1 件で中断するので、
    // 2 つ以上の口が同時に開いていると、直して push するたびに次の 1 件が出る
    // (CI の巡が増える)。加えて中断されると下の「node イメージで名指ししたジョブを
    // 除く」重複除け自体が一度も効かない = docstring が書いている挙動が起きえない
    expect.soft(
      misconfigured,
      `actions/setup-node の版は node-version-file: '${displayPath(NVMRC_PATH)}' で指定し、` +
        `node-version は書かないこと` +
        `(cache などの他の入力は付けてよい)。実際の指定: ${misconfigured.join(" / ")}。` +
        `版を直書きすると ${displayPath(NVMRC_PATH)} とずれても CI は緑のまま通り、出荷する Node を検証していない状態に戻る。`,
    ).toEqual([]);
    // **版が入り込む 2 つ目の口**は、ステップを丸ごとイメージの中で走らせる形。
    // `uses: docker://<image>` は同じジョブに正しい setup-node を置いても効かないので、
    // イメージ名を問わず落とす (名前で絞ると docker://ghcr.io/acme/ci-node:20 が
    // 素通りした。実測)。`container:` はここでは見ない — その中でも setup-node は
    // 動くので、誤りなのは「setup-node が無いこと」のほうで、下の検査が落とす
    const imageOnlySteps = collectImageOnlySteps(workflows.jobs);
    const imageSteps = imageOnlySteps.map((use) => `${use.file}: ${use.job} (${use.location})`);
    expect.soft(
      imageSteps,
      `ステップをイメージの中で丸ごと走らせないこと (uses: docker://)。実際の指定: ${imageSteps.join(" / ")}。` +
        "そのステップだけはイメージの Node で走り、同じジョブに setup-node を置いても効かない。" +
        `Node は actions/setup-node に node-version-file: '${displayPath(NVMRC_PATH)}' を渡して用意すること。` +
        "Node を持ち込まないイメージだと確認できている場合は、NODE_GUARD_EXEMPTIONS の image へ理由付きで登録すること。",
    ).toEqual([]);
    // **版が入り込む 3 つ目の口**は「書き忘れ」で到達する。ランナーには Node が
    // 最初から入っているので、setup-node を置かないジョブで npm を叩くと
    // ランナー既定の major でスイートが丸ごと走る (上の 2 つは素通りする。実測)。
    // 置いてあっても「リポジトリのコードより後ろ」「if: / continue-on-error 付き」は
    // 同じ結果になるので、位置と効き方まで見る
    const missingSetup = collectJobsMissingSetupNode(
      workflows.jobs,
      new Set(imageOnlySteps.map((use) => jobKey(use.file, use.job))),
    ).map((job) => `${job.file}: ${job.job} (${job.reason})`);
    // **実行時の検証が CI から消えていないことも見る。** 上の 3 つは宣言しか見ないので、
    // 見えない形 (run: の中で Node を入れ替える等) の担保はこのスクリプトだけが持つ。
    // 呼び出しが消えても静的な検査はすべて緑のままになる
    const runsVerifier = workflows.jobs.some((job) =>
      (stepRecordsOf(job) ?? []).some((step) => String(step.run ?? "").includes(RUNTIME_VERIFIER)),
    );
    expect.soft(
      runsVerifier,
      `どのジョブも ${RUNTIME_VERIFIER} を実行していない。` +
        "静的な検査は宣言として YAML に現れる Node しか見られないので、" +
        "実際に走る Node を確かめるこのステップが無くなると、run: の中で入れ替える形などが" +
        "まったく検証されない状態になる。",
    ).toBe(true);
    expect.soft(
      missingSetup,
      `このリポジトリのコードを実行するジョブ (run: / ローカル action の呼び出し) には、` +
        `無条件の actions/setup-node をそのコードより前に置くこと。足りていないジョブ: ${missingSetup.join(" / ")}。` +
        "ランナーに最初から入っている Node でそのまま走るため、.nvmrc とは無関係な major で検証している状態になる。" +
        "Node と無関係なジョブは NODE_GUARD_EXEMPTIONS の setupNode へ理由付きで登録すること。",
    ).toEqual([]);
  });

  it("Node と無関係なジョブの除外表が、実在するジョブだけを理由付きで挙げている", () => {
    // 判定は関数に切り出してある (表が空だと判定そのものが一度も動かないため、
    // 合成した表を渡すテストを末尾に置いている)
    // 除外表は「検査を fail-closed にするためのエスケープハッチ」なので、
    // 表そのものが腐ると検査が黙って緩む。2 つの腐り方を落とす
    const workflows = workflowScan;
    // **入力側が壊れているときは「実在するか」を判定しない。**
    // 読めなかったワークフローのジョブは `existing` に入らないので、正しい除外まで
    // 「実在しない」と報告してしまう — その指示に従って消すと、上の検査が
    // 本当に Node と無関係なジョブで落ち続ける。原因は姉妹の検査が名指しする
    const inputsBroken = workflows.listError !== null || workflows.unreadable.length > 0;
    // いま実在するジョブのキー一覧
    const existing = new Set(workflows.jobs.map((job) => jobKey(job.file, job.name)));
    // **実在しないジョブの登録**を落とす。ジョブ名を変えた・消したあとも残っていると、
    // 将来その名前のジョブを足した人に黙って除外が効く (差分にも現れない)
    const stale = inputsBroken ? [] : staleExclusions(NODE_GUARD_EXEMPTIONS, existing);
    expect(
      stale,
      `NODE_GUARD_EXEMPTIONS に実在しないジョブが登録されている: ${stale.join(" / ")}。` +
        "ジョブを消した・改名したなら、除外もこの差分で消すこと (残すと将来同じ名前のジョブへ黙って効く)。",
    ).toEqual([]);
    // **理由の空欄**を落とす。値を誰も読まないと、空白を入れて検査を黙らせられる
    const withoutReason = exclusionsWithoutReason(NODE_GUARD_EXEMPTIONS);
    expect(
      withoutReason,
      `NODE_GUARD_EXEMPTIONS の除外には、免除する検査 (setupNode / image) と理由を書くこと` +
        ` (空・空白・免除先なしは不可): ${withoutReason.join(" / ")}。`,
    ).toEqual([]);
  });

  it("実行する Node の major がピン留め 2 か所すべてから読み取れ、値も揃っている", () => {
    // 1 つでも読めなければ前提崩れ (fail-closed)。どこが読めなかったかを名指しする
    const unreadable = pinnedSources
      .filter((source) => source.major === null)
      .map((source) => source.label);
    expect(
      unreadable,
      `実行する Node の major を読み取れない出どころがある: ${unreadable.join(", ")}。` +
        "このテストは 2 か所の一致を前提にしているので、書式を変えた (多段ビルドで別 major を足した等) なら読み取りも合わせて直すこと。",
    ).toEqual([]);
    // 読み取れた major が全て同じであることを確かめる
    expect(
      [...new Set(pinnedSources.map((source) => source.major))],
      `実行する Node の major が食い違っている: ${pinnedSources
        .map((source) => `${source.label}=${source.major}`)
        .join(", ")}。Node を上げるときは 2 か所すべてを同じ major に揃えること。`,
    ).toHaveLength(1);
  });

  it("package.json の engines.node が、ピン留めした major の実行を許している", () => {
    // 基準が決まっていなければ、その事実を明示して落とす
    expect(
      runtimeMajor,
      "ピン留め 2 か所が揃っていないため、engines の判定基準が決まらない",
    ).not.toBeNull();
    // engines.node は下限つきの範囲なので、パース済みの package.json から素直に引く
    const enginesNode = asRecord(asRecord(packageJsonRead.value).engines).node;
    // 文字列で書かれていなければ読めなかった扱いとして落とす
    expect(
      typeof enginesNode,
      `package.json の engines.node を文字列で書くこと。実際の値: ${String(enginesNode)}`,
    ).toBe("string");
    // 等値ではなく「その系列で実際に入る版を許しているか」で見る (下限に minor/patch を
    // 持つ宣言を「許していない」と誤判定しないため。判定の中身は allowsMajor のコメント参照)
    expect(
      allowsMajor(String(enginesNode), runtimeMajor as number),
      `engines.node (${String(enginesNode)}) がピン留めした Node ${runtimeMajor} の実行を許していない。` +
        "最低サポート版を下げたままにするのは妥当だが、ピンより上の下限を残すと動かない環境を宣言することになる。",
    ).toBe(true);
  });

  it("README の必要環境が、ピン留めした major と同じ Node を案内している", () => {
    // README から「Node.js <major> 系」を読み取る
    const readmeMajor = readReadmeNodeMajor();
    // 書式ごと変わって読めない場合は、案内が消えたのと同じなので落とす。
    // **「Node.js 26 以上」と書き換えても落ちる**（読み取りが要求するのは「系」の形）。
    // 検証しているのはピン留めした系列だけなので、「以上」は検査より緩い約束になる
    // (readReadmeNodeMajor のコメント参照)
    expect(
      readmeMajor,
      "README から「Node.js <major> 系」を読み取れない。必要環境の案内を消さず、書式を変えたならこの読み取りも直すこと（「以上」ではなく「系」で書く）。",
    ).not.toBeNull();
    // ピンと同じ major を案内していることを確かめる
    expect(
      readmeMajor,
      `README の必要環境 (Node.js ${readmeMajor} 系) がピン留めした Node ${runtimeMajor} と違う。` +
        "古い major を案内したままにすると、読み手が動かない環境を用意してしまう。",
    ).toBe(runtimeMajor);
  });

  it("package.json の @types/node が、実行する Node と同じ major を指している", () => {
    // package.json の devDependencies から宣言された範囲を取り出す
    const declared = readDevDependencyRange(packageJsonRead.value, GUARDED_DEPENDENCY);
    // 範囲から許容 major を読み取る
    const declaredMajor = parseAllowedMajor(declared);
    // 読めない書き方なら落とす (読めない範囲を「たぶん合っている」と決めつけない)
    expect(
      declaredMajor,
      `package.json の ${GUARDED_DEPENDENCY} を、このテストが解釈できる形 (^26 など) で書くこと。実際の値: ${String(declared)}`,
    ).not.toBeNull();
    // 実行する Node の major と一致していることを確かめる
    expect(
      declaredMajor,
      `${GUARDED_DEPENDENCY} の major (${declaredMajor}) が実行する Node の major (${runtimeMajor}) と違う。` +
        "型だけが先に進むと、実行時に存在しない API を書いても tsc が通ってしまう (本番でのみ壊れる)。",
    ).toBe(runtimeMajor);
  });

  it("ロックファイルの解決済み @types/node も、実行する Node と同じ major になっている", () => {
    // 巻き上げ位置の解決済みメタデータから version を引く
    const meta = asRecord(readLockPackages(packageLockRead.value)[`node_modules/${GUARDED_DEPENDENCY}`]);
    const locked = typeof meta.version === "string" ? meta.version : null;
    // 見つからなければ前提崩れとして落とす
    expect(
      locked,
      `package-lock.json に ${GUARDED_DEPENDENCY} の解決済み版が見つからない`,
    ).not.toBeNull();
    // 宣言が正しくても、overrides や巻き上げで解決だけがずれる場合を捕まえる
    expect(
      parseAllowedMajor(locked),
      `解決済みの ${GUARDED_DEPENDENCY} (${String(locked)}) の major が実行する Node の major (${runtimeMajor}) と違う。`,
    ).toBe(runtimeMajor);
  });

  it("直接依存が engines.node で要求する Node を、ピン留めした major が満たしている", () => {
    // 基準が決まっていなければ、その事実を明示して落とす
    expect(
      runtimeMajor,
      "ピン留め 2 か所が揃っていないため、依存の engines を照合する基準が決まらない",
    ).not.toBeNull();
    // 直接依存の名前を package.json から取り出す
    const names = directDependencyNames(packageJsonRead.value);
    // **まず「全部引けたか」を見る。** 引けなかった依存は engines を宣言していても
    // 黙って対象から外れ、「違反ゼロ＝緑」と見分けが付かなくなる
    const unresolved = unresolvedDependencies(packageLockRead.value, names);
    expect(
      unresolved,
      `ロックファイルで解決済みメタデータを引けない直接依存がある: ${unresolved.join(", ")}。` +
        "引けない依存は engines の照合から黙って外れるので、検査した気になったまま穴が空く (ロックファイルの形が変わったなら読み取りも直すこと)。",
    ).toEqual([]);
    // ロックファイルから engines.node を引く
    const engines = collectDependencyEngines(packageLockRead.value, names);
    // 1 つも読めない場合も「違反ゼロ＝緑」になってしまうので、前提崩れとして落とす。
    // (このリポジトリには engines を宣言する直接依存が現に複数ある)
    expect(
      engines.length,
      "直接依存の engines.node を 1 つも読み取れない。ロックファイルの形が変わったなら読み取りも直すこと (違反ゼロと区別がつかないため落とす)。",
    ).toBeGreaterThan(0);
    // ピン留めした Node を許していない依存を集める
    const unsupported = engines
      .filter((entry) => !allowsMajor(entry.range, runtimeMajor as number))
      .map((entry) => `${entry.name} (engines.node: ${entry.range})`);
    // 1 つでもあれば、CI が「その依存がサポートしない Node」で検証していることになる
    expect(
      unsupported,
      `ピン留めした Node ${runtimeMajor} をサポートしない直接依存がある: ${unsupported.join(", ")}。` +
        "npm は engines を既定で強制しないので、この状態でもインストールもテストも通ってしまう (緑は「動く」ことの証明にならない)。" +
        "ランタイムを上げるか、その依存の版を見直すこと。",
    ).toEqual([]);
  });

  it("dependabot.yml の読む場所に、読み飛ばされる要素が無い", () => {
    // 読み手 (collectIgnoreEntries) が黙って捨てる要素の数を数える。
    // **この検査をこのファイルにも置くのは、同じ数え手を持つ
    // tests/dependabot-eslint-guard.test.ts が「上流が ESLint 10 に対応したら
    // ファイルごと削除する」運用だから** — 消えた瞬間に npm ブロックの読み飛ばし検査が
    // 道連れになり、`@types/node` のエントリの隣に空要素 `-` が増えても
    // 件数が変わらないまま全検査が緑になる (実際にそうなる形を eslint 側のコメントが
    // fail-closed として扱っている)
    // npm ブロックと docker ブロックの両方を数える (保留を置いているのはこの 2 つ)
    const unreadableElementCount =
      countUnreadableElements(
        (dependabotRead.value ?? {}) as DependabotConfig,
        NPM_ECOSYSTEM,
        NPM_DIRECTORY,
      ) +
      countUnreadableElements(
        (dependabotRead.value ?? {}) as DependabotConfig,
        DOCKER_ECOSYSTEM,
        DOCKER_DIRECTORY,
      );
    // 1 つでもあれば、意図して書いた形ではないので落とす (fail-closed)
    expect(
      unreadableElementCount,
      "dependabot.yml に、この検査が黙って読み飛ばす形の要素がある (空のリスト要素 `-`、リストでない ignore / directories、文字列でない dependency-name など)。" +
        "件数が変わらないまま設定だけが壊れるので、書いた形のまま読めるように直すこと。",
    ).toBe(0);
  });

  it("@types/node の major 更新を止める ignore が、npm の対象ディレクトリに 1 件だけある", () => {
    // 1 件だけであることを確かめる (0 件 = 保留の消失 / 2 件以上 = 効きすぎ)
    expect(
      ignoreEntries,
      `${GUARDED_DEPENDENCY} の ignore は ${NPM_ECOSYSTEM} / ${NPM_DIRECTORY} のブロックに 1 件だけ置くこと。` +
        "Dependabot は同じパッケージの複数エントリをすべて適用するため、2 件目が足されると効き方が変わる。",
    ).toHaveLength(1);
  });

  it("その ignore が @types/node だけを名指ししている (ワイルドカードで他の @types/* を巻き込まない)", () => {
    // 件数・update-types・キー集合が想定どおりでも、名前が `@types/*` へ書き換えられると
    // 他の `@types/*` すべての major 追従まで止まる。名前そのものを完全一致で確かめる
    expect(
      ignoreEntries[0]?.["dependency-name"],
      `ignore の dependency-name は ${GUARDED_DEPENDENCY} と完全一致で書くこと。` +
        "`@types/*` のようなワイルドカードにすると @types/react など他の型定義まで major が止まり、" +
        "しかも件数・update-types・キー集合はすべて想定どおりのまま素通りする。",
    ).toBe(GUARDED_DEPENDENCY);
  });

  it("その ignore が major 更新だけを止めている (patch/minor は届く)", () => {
    // 想定外のキー (versions など) が増えていないことを確かめる
    expect(
      sortedKeysOf(ignoreEntries[0] ?? {}),
      "ignore エントリに想定外のキーがある。versions などを足すと現行系列の patch 更新まで止まる。",
    ).toEqual([...ALLOWED_IGNORE_KEYS].sort());
    // update-types が「major だけ」であることを確かめる
    expect(
      ignoreEntries[0]?.["update-types"],
      "update-types が major 限定でなくなっている。空にすると全バージョンが無視される。",
    ).toEqual([MAJOR_UPDATE_TYPE]);
  });

  it("Dockerfile のベースイメージ node の major 更新を止める ignore が、docker の対象ディレクトリに 1 件だけある", () => {
    // 1 件だけであることを確かめる (0 件 = 保留の消失 / 2 件以上 = 効きすぎ)。
    // 消えると Dockerfile だけが別 major へ進む PR が立ち、「26 で検証した成果物を
    // 別の Node で動かす」差分になる (ピンの食い違いとして毎週赤くなる)
    expect(
      baseImageIgnoreEntries,
      `${GUARDED_BASE_IMAGE} の ignore は ${DOCKER_ECOSYSTEM} / ${DOCKER_DIRECTORY} のブロックに 1 件だけ置くこと。` +
        "Dependabot は同じパッケージの複数エントリをすべて適用するため、2 件目が足されると効き方が変わる。",
    ).toHaveLength(1);
  });

  it("その ignore が node だけを名指ししている (ワイルドカードで他のベースイメージを巻き込まない)", () => {
    // `*` などに書き換えられると、将来足す別のベースイメージまで major 追従が止まる。
    // しかも件数・update-types・キー集合は想定どおりのまま素通りするので、名前を完全一致で見る
    expect(
      baseImageIgnoreEntries[0]?.["dependency-name"],
      `ignore の dependency-name は ${GUARDED_BASE_IMAGE} と完全一致で書くこと。`,
    ).toBe(GUARDED_BASE_IMAGE);
  });

  it("その ignore が major 更新だけを止めている (同タグの再ビルド・minor/patch は届く)", () => {
    // 想定外のキー (versions など) が増えていないことを確かめる。
    // ここを塞いでおかないと、node:26 のセキュリティ修正を含む更新まで止まりうる
    expect(
      sortedKeysOf(baseImageIgnoreEntries[0] ?? {}),
      "ignore エントリに想定外のキーがある。versions などを足すと現行系列の更新まで止まる。",
    ).toEqual([...ALLOWED_IGNORE_KEYS].sort());
    // update-types が「major だけ」であることを確かめる
    expect(
      baseImageIgnoreEntries[0]?.["update-types"],
      "update-types が major 限定でなくなっている。空にすると全バージョンが無視される。",
    ).toEqual([MAJOR_UPDATE_TYPE]);
  });
});

// この検出網は「実際の ci.yml が準拠している」ことしか確かめておらず、**判定そのものは
// どのテストも通っていなかった**。実測では `isUnconditionalSetupNode` の中身を
// `return true` に潰しても全件緑で、`isNodeImage` / `runsRepositoryCode` /
// `describeStepsProblem` / `SETUP_NODE_USES` の `i` も同じ。つまり「塞いだ」実測の証拠が
// コミットメッセージにしか無く、後の整理で口が静かに開いても CI は何も言わない
// (helpdesk-hub の Stripe ガードが「実行時チェックそのものの挙動」を固定している理由と
//  同じ形)。そこで合成したジョブ・ステップを直接渡し、**落とす側と通す側の両方**を固定する。
describe("CI の配線を見る検出網そのものの挙動", () => {
  // 合成した中身から、判定に渡せるジョブを組み立てる小さなヘルパー
  const jobOf = (definition: Record<string, unknown>): WorkflowJob => ({
    // 失敗文言に出るファイル名 (実在しなくてよい。判定は値だけを見る)
    file: "synthetic.yml",
    // ジョブ名
    name: "job",
    // 判定対象の中身
    definition,
  });

  it.each([
    // 素の setup-node は「必ず効く」
    { step: { uses: "actions/setup-node@v7" }, expected: true, label: "素の setup-node" },
    // GitHub は uses: の大文字小文字を無視して解決するので、この形も実際に動く
    { step: { uses: "Actions/Setup-Node@v7" }, expected: true, label: "大文字違い" },
    // if: が付くと実行されない可能性がある
    { step: { uses: "actions/setup-node@v7", if: "${{ false }}" }, expected: false, label: "if:" },
    // continue-on-error は失敗しても後続が走る = 効かなくても緑になる
    {
      step: { uses: "actions/setup-node@v7", "continue-on-error": true },
      expected: false,
      label: "continue-on-error: true",
    },
    // 明示的な false は「効かない書き方」ではないので通す
    {
      step: { uses: "actions/setup-node@v7", "continue-on-error": false },
      expected: true,
      label: "continue-on-error: false",
    },
    // 名前が前方一致するだけの別アクションは対象外 (直しようの無い要求を出さない)
    { step: { uses: "actions/setup-node-foo@v1" }, expected: false, label: "別アクション" },
    // run: だけのステップは setup-node ではない
    { step: { run: "npm ci" }, expected: false, label: "run: だけ" },
  ])("isUnconditionalSetupNode: $label → $expected", ({ step, expected }) => {
    // 合成したステップを判定へ渡し、期待どおりの真偽を返すことを固定する
    expect(isUnconditionalSetupNode(step)).toBe(expected);
  });

  it.each([
    // タグ付きの公式イメージ
    { image: "node:20", expected: true, label: "node:20" },
    // レジストリ・名前空間を付けた書き方
    { image: "docker.io/library/node:20", expected: true, label: "レジストリ付き" },
    // ダイジェスト指定
    { image: "node@sha256:abc", expected: true, label: "ダイジェスト" },
    // 名前が node で始まるだけの別物は巻き込まない (container: の判定に使うため)
    { image: "myorg/node-tools:1", expected: false, label: "別イメージ" },
    // 名前空間付きの別物 (ベンダー製)。中で setup-node を正しく使う形は正当なので拾わない
    { image: "ghcr.io/acme/node:1", expected: false, label: "ベンダー製の node" },
    // Node と無関係なイメージ (この中で setup-node を使う形は正当)
    { image: "ubuntu:24.04", expected: false, label: "ubuntu" },
  ])("isNodeImage: $label → $expected", ({ image, expected }) => {
    // イメージ名の判定が、公式の node イメージだけを拾うことを固定する
    expect(isNodeImage(image)).toBe(expected);
  });

  it.each([
    // run: はリポジトリのコードを走らせる口
    { step: { run: "npm ci" }, expected: true, label: "run:" },
    // 空白だけの run: は何も実行しない
    { step: { run: "   " }, expected: false, label: "空白だけの run:" },
    // ローカルの composite action も中身はこのリポジトリのコード
    { step: { uses: "./.github/actions/test" }, expected: true, label: "ローカル action" },
    // 第三者アクションはランナー自身の Node で動くので数えない
    { step: { uses: "actions/checkout@v7" }, expected: false, label: "第三者アクション" },
  ])("runsRepositoryCode: $label → $expected", ({ step, expected }) => {
    // 「リポジトリのコードを実行するステップか」の判定を固定する
    expect(runsRepositoryCode(step)).toBe(expected);
  });

  it.each([
    // steps を持たないジョブ (再利用可能ワークフローの呼び出し) は正当
    { steps: undefined, readable: true, label: "steps なし" },
    // 空の steps も構造としては読める
    { steps: [], readable: true, label: "空の steps" },
    // 対応表の要素だけなら読める
    { steps: [{ run: "npm ci" }], readable: true, label: "正しい steps" },
    // 配列でない steps はステップを 1 つも読めない
    { steps: "npm ci && npm run test", readable: false, label: "文字列の steps" },
    // 要素が対応表でないと run: も uses: も読めない
    { steps: ["npm ci"], readable: false, label: "要素が文字列" },
  ])("describeStepsProblem: $label → 読める=$readable", ({ steps, readable }) => {
    // 読めない形だけが理由付きの文字列を返すことを固定する
    expect(describeStepsProblem(steps) === null).toBe(readable);
  });

  it("collectJobsMissingSetupNode が、置き方の誤りだけを名指しする", () => {
    // 期待どおりの置き方 (checkout → setup-node → npm) は名指ししない
    const compliant = jobOf({
      steps: [
        { uses: "actions/checkout@v7" },
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "npm ci" },
      ],
    });
    expect(collectJobsMissingSetupNode([compliant], new Set())).toEqual([]);
    // setup-node がリポジトリのコードより後ろにある形は名指しする
    const tooLate = jobOf({ steps: [{ run: "npm ci" }, { uses: "actions/setup-node@v7" }] });
    expect(collectJobsMissingSetupNode([tooLate], new Set())).toHaveLength(1);
    // setup-node が無い形も名指しする
    const missing = jobOf({ steps: [{ run: "npm ci" }] });
    expect(collectJobsMissingSetupNode([missing], new Set())).toHaveLength(1);
    // 第三者アクションだけのジョブは対象外 (誤検知を出さない)
    const actionsOnly = jobOf({ steps: [{ uses: "actions/labeler@v5" }] });
    expect(collectJobsMissingSetupNode([actionsOnly], new Set())).toEqual([]);
    // steps を持たないジョブ (再利用可能ワークフローの呼び出し) も対象外
    const reusable = jobOf({ uses: "other-org/repo/.github/workflows/x.yml@v1" });
    expect(collectJobsMissingSetupNode([reusable], new Set())).toEqual([]);
    // ジョブ単位の continue-on-error は、失敗しても CI が緑になるので名指しする
    const jobContinues = jobOf({
      "continue-on-error": true,
      steps: [{ uses: "actions/setup-node@v7" }, { run: "npm ci" }],
    });
    expect(collectJobsMissingSetupNode([jobContinues], new Set())).toHaveLength(1);
    // 明示的な false は「効かなくても進む書き方」ではないので通す
    const jobStops = jobOf({
      "continue-on-error": false,
      steps: [{ uses: "actions/setup-node@v7" }, { run: "npm ci" }],
    });
    expect(collectJobsMissingSetupNode([jobStops], new Set())).toEqual([]);
    // イメージ側の検査が名指ししたジョブは、そちらの文言に任せる (重複させない)
    const excluded = new Set([jobKey("synthetic.yml", "job")]);
    expect(collectJobsMissingSetupNode([missing], excluded)).toEqual([]);
  });

  it("collectImageOnlySteps が、docker:// のステップだけをイメージ名を問わず拾う", () => {
    // イメージ名が node でなくても、中の Node で repo のコードが走りうるので拾う
    const dockerStep = jobOf({ steps: [{ uses: "docker://ghcr.io/acme/ci-node:20" }] });
    expect(collectImageOnlySteps([dockerStep])).toHaveLength(1);
    // 公式の node イメージでも同じ扱い
    expect(collectImageOnlySteps([jobOf({ steps: [{ uses: "docker://node:20" }] })])).toHaveLength(
      1,
    );
    // **container: はこの検査の対象外** — その中でも setup-node は効くので、
    // 誤りは「setup-node が無いこと」のほうであり、別の検査が落とす
    expect(collectImageOnlySteps([jobOf({ container: "node:20" })])).toEqual([]);
    // 第三者アクションや run: だけのステップは対象外
    expect(collectImageOnlySteps([jobOf({ steps: [{ uses: "actions/checkout@v7" }] })])).toEqual([]);
    // 文言に使う場所の文字列は、YAML に現れるとおりで空白を挟まない
    expect(collectImageOnlySteps([dockerStep])[0]?.location).toBe("docker://ghcr.io/acme/ci-node:20");
  });

  it("除外表の腐りを見る判定が、実際に腐りだけを拾う", () => {
    // 実在するジョブのキー (合成)
    const existing = new Set(["ci.yml:lint-and-test"]);
    // 実在するキーだけの表は腐っていない
    expect(staleExclusions({ "ci.yml:lint-and-test": { setupNode: "理由" } }, existing)).toEqual([]);
    // 実在しないキーは名指しする (ジョブを改名・削除したあとの置き去り)
    expect(staleExclusions({ "ci.yml:gone": { setupNode: "理由" } }, existing)).toEqual([
      "ci.yml:gone",
    ]);
    // 空の表は腐りようが無い
    expect(staleExclusions({}, existing)).toEqual([]);
    // 理由が書かれていれば読める登録 (免除先ごとに書ける)
    expect(exclusionsWithoutReason({ "a:b": { setupNode: "理由あり" } })).toEqual([]);
    expect(exclusionsWithoutReason({ "a:b": { image: "理由あり" } })).toEqual([]);
    // 空白だけの理由は名指しする (値を読まないと空白で黙らせられる)
    expect(exclusionsWithoutReason({ "a:b": { setupNode: "   " } })).toEqual(["a:b"]);
    expect(exclusionsWithoutReason({ "a:b": { image: "" } })).toEqual(["a:b"]);
    // **免除先を 1 つも書いていない登録**も名指しする (何も免除しないのに
    // 「除外済み」に見えるうえ、実在チェックだけを通ってしまう)
    expect(exclusionsWithoutReason({ "a:b": {} })).toEqual(["a:b"]);
  });

  it("describeInputs が、循環参照を含む with: でも例外を投げない", () => {
    // YAML のアンカーで自己参照する with: を再現する
    const circular: Record<string, unknown> = { "node-version": "20" };
    circular.self = circular;
    // 例外ではなく、キー=値の形の説明が返ることを固定する (値は「形」だけ)
    expect(describeInputs(circular)).toBe("node-version=20, self=object");
    // 指定が無い場合も読み手に伝わる文言にする
    expect(describeInputs({})).toBe("with: の指定なし");
  });
});
