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
//       **node イメージを走らせる形も同じ扱いで落とす。**
//       `container: node:20` と書くと steps はそのイメージの Node で走るので、
//       `actions/setup-node` を 1 つも置かずに別 major で検証できてしまう
//       (setup-node だけを見る検査はこれを緑のまま通す。実測)。
//       **ステップ単位の `uses: docker://node:20` も同じ口**で、こちらは
//       3 つ目の検査でも拾えない (`uses:` が `./` で始まらないので「リポジトリの
//       コードを実行するステップ」に数えられず、そのジョブが要求の対象から外れる。実測)。
//       **3 つ目の口は「setup-node を書き忘れる」形。** ランナーには Node が
//       最初から入っているため、`setup-node` の無いジョブで `npm ci && npm run test`
//       と書くとランナー既定の major でスイートが丸ごと走る。上の 2 つを塞いでも
//       これは緑のまま通る (実測) ので、**このリポジトリのコードを実行するジョブ**
//       (`run:` を持つ / ローカルの composite action を呼ぶ) には
//       **無条件の `setup-node` がそのコードより前にある**ことまで求める。
//       置いてあるかだけでは足りない — `run: npm ci` の後ろに置いた形と、
//       `if:` / `continue-on-error:` を付けた形はどれも実測で素通りした
//       (前半 / 全体がランナー既定の Node で走るのに全件緑。とくに
//        `continue-on-error: true` は setup-node が失敗してもジョブが成功で終わる)。Node と無関係なジョブは `NODE_UNRELATED_JOBS` へ
//       理由付きで登録する (判定を `run:` の文言から当てる形は、綴りが変わるだけで
//       黙って外れた。実測は同定数の docstring に記録した)。
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
//   と理解して使うこと。ここを広げたくなったら、まず実際にその形が現れてから、
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
  // 各ステップを対応表として読める形にそろえる
  return steps.map((step) => asRecord(step));
}

/** そのステップが `actions/setup-node` を呼んでいるか。 */
function isSetupNodeStep(step: Record<string, unknown>): boolean {
  // uses を文字列として照合する (未指定なら空文字列 = 一致しない)
  return SETUP_NODE_USES.test(String(step.uses ?? ""));
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
  // どこに書かれていたか (`container:` かステップの `uses: docker://`)。
  // 直す場所が 2 通りあるので、文言で区別できないと読み手が探し回ることになる
  where: string;
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
 */
function isNodeImage(image: string): boolean {
  // ダイジェスト指定 (`@sha256:...`) が付いていれば切り落とす
  const withoutDigest = image.split("@")[0];
  // レジストリ・名前空間を落として、最後のパス要素だけを取り出す
  const lastSegment = withoutDigest.split("/").pop() ?? "";
  // タグ (`:20-alpine`) を落として、リポジトリ名だけにする
  const repository = lastSegment.split(":")[0];
  // 公式の node イメージだけを対象にする (node-tools 等は別物なので拾わない)
  return repository === "node";
}

/**
 * Node と無関係なのに、このリポジトリのコードを実行するジョブの**理由付きの除外表**。
 *
 * キーは `jobKey` と同じ「ワークフローのファイル名 : ジョブ名」。
 *
 * **これがあるので下の検査を fail-closed にできる。** 「Node を使っているか」を
 * `run:` の文言から当てる形 (以前の `NODE_TOOLING_COMMAND`) は、綴りが変わるだけで
 * 黙って対象から外れた (実測: `./node_modules/.bin/vitest run` や
 * `/usr/local/bin/node server.js` はどれも拾えず、スイートがランナー既定の Node で
 * 丸ごと走る状態が全件緑のまま通った)。そこで判定を**構造**
 * (`run:` があるか / ローカル action を呼ぶか) に変え、当てはまらない例外だけを
 * ここへ 1 行ずつ登録する形にした。表に無いジョブは検査が拾って落ちるので、
 * **次に同じ形のジョブを足す人は「setup-node を置くか、除外するか」を必ず一度決める**
 * ことになる (incident-insight の除外表と同じ考え方)。
 *
 * **現在は空** — 除外の必要なジョブがまだ無い。エントリが増える差分は、
 * 理由の妥当性をレビューで必ず確認する (署名からは「Node と無関係か」を判定できない、
 * 人が判断するエスケープハッチ)。
 */
const NODE_UNRELATED_JOBS: Readonly<Record<string, string>> = {};

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
  return String(step.uses ?? "").startsWith("./");
}

/** 失敗文言に出す、ステップ 1 つの短い説明。 */
function describeStep(step: Record<string, unknown>): string {
  // run: なら最初の 1 行だけを出す (複数行をそのまま出すと文言が読めなくなる)
  const run = typeof step.run === "string" ? step.run.trim().split("\n")[0] : "";
  // run: に中身があれば、その 1 行を説明として使う
  if (run !== "") return `run: ${run}`;
  // run: が無ければローカル action の呼び出し
  return `uses: ${String(step.uses ?? "")}`;
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
 * (以前の形の実測は `NODE_UNRELATED_JOBS` の docstring に書いた)。構造で見て、
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
    // 理由付きで除外登録されたジョブは対象外 (表の健全性は専用の検査が見る)
    if (key in NODE_UNRELATED_JOBS) return [];
    // steps が無いジョブ (再利用可能ワークフローの呼び出し) は要求しても置く場所が無い
    const steps = stepRecordsOf(job);
    if (steps === null) return [];
    // このリポジトリのコードを最初に実行するステップの位置
    const firstRepoCode = steps.findIndex(runsRepositoryCode);
    // 1 つも無ければ、第三者アクションだけのジョブなので対象外
    if (firstRepoCode === -1) return [];
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
 * node イメージを据えている箇所を集める (ジョブの `container:` と、ステップの
 * `uses: docker://<image>`)。
 *
 * **`actions/setup-node` を見るだけでは足りない**のがここを足した理由。
 * ジョブに `container: node:20` と書くと steps はそのイメージの中で走るため、
 * setup-node を 1 本も置かないまま `.nvmrc` と別の major で `npm ci && npm run test`
 * を回せてしまう。setup-node だけを見る検査はこれを**全件緑のまま通す** (実測)。
 * これは版が入り込む 2 つ目の口で、3 つ目 (`setup-node` の置き方) と合わせて
 * すべて塞いで初めて「CI が入れる Node はピンそのもの」が保証になる。
 *
 * **ステップ単位の `uses: docker://node:20` も同じ口。** そのステップだけがイメージの
 * Node で走るので、ジョブに `container:` が無くても `.nvmrc` とは別の major で
 * リポジトリのコードを回せる。しかも `setup-node` の置き方を見る検査では拾えない
 * (`uses:` が `./` で始まらないため「リポジトリのコードを実行するステップ」に数えられず、
 *  そのジョブは要求の対象から外れる)。実測でこの形は全件緑のまま通っていた。
 * `container:` と同じく**宣言として YAML に現れる値**なので、塞げる口はここで塞ぐ。
 *
 * `container:` は文字列 (`container: node:20`) でも
 * マップ (`container: { image: node:20 }`) でも書けるので、両方の書き方を読む。
 * node 以外のイメージは対象外 — Node の版が入り込まないので、要求する内容が無い。
 */
function collectNodeImageUses(jobs: readonly WorkflowJob[]): NodeImageUse[] {
  // 共有の走査で平らに並べたジョブを受け取り、2 つの書き方を順に見る
  return jobs.flatMap((job) => {
    // 見つけた箇所を溜める入れ物 (1 ジョブに container: とステップの両方がありうる)
    const found: NodeImageUse[] = [];
    // container の値を取り出す (未指定ならこのジョブに container は無い)
    const container = job.definition.container;
    // 文字列ならそれ自体がイメージ名、マップなら image キーがイメージ名
    const containerImage =
      typeof container === "string" ? container : String(asRecord(container).image ?? "");
    // node イメージなら控える (ubuntu 等の中で setup-node を使う形は上の検査が見る)
    if (isNodeImage(containerImage)) {
      found.push({ file: job.file, job: job.name, image: containerImage, where: "container:" });
    }
    // 各ステップの uses: docker:// も同じ扱いで見る (steps が無いジョブは空で回す)
    for (const step of stepRecordsOf(job) ?? []) {
      // uses を文字列として取り出す
      const uses = String(step.uses ?? "");
      // docker:// で始まらないステップはイメージを直接走らせていない
      if (!uses.startsWith(DOCKER_USES_PREFIX)) continue;
      // 接頭辞を落としてイメージ名だけにする
      const image = uses.slice(DOCKER_USES_PREFIX.length);
      // node イメージなら、どのステップで据えているかを控える
      if (isNodeImage(image)) {
        found.push({
          file: job.file,
          job: job.name,
          image,
          where: `uses: ${DOCKER_USES_PREFIX}`,
        });
      }
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
 * まさに検出したいドリフトを見逃す。すべての `FROM node:<major>` を集め、
 * 揃っていなければ「読めなかった」として呼び出し側で落とす。
 */
function readDockerfileNodeMajor(): number | null {
  // Dockerfile を読む (読めなければ null)
  const text = readTextOrNull(DOCKERFILE_PATH);
  if (text === null) return null;
  // コメントを落としたうえで、すべての `FROM node:<major>` を集める
  const majors = new Set<number>();
  for (const line of stripComments(text)) {
    // 行頭の FROM 命令だけを対象にする (大文字小文字は Docker 側が区別しない)
    const matched = line.match(/^\s*FROM\s+node:(\d+)/i);
    if (matched) majors.add(Number(matched[1]));
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
    // 1 つも無ければ、CI が Node を用意していない (= 検証していない) ので落とす
    expect(
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
        (step) => step.inputs["node-version-file"] !== ".nvmrc" || "node-version" in step.inputs,
      )
      .map((step) => `${step.file}: ${step.job} (${JSON.stringify(step.inputs)})`);
    expect(
      misconfigured,
      `actions/setup-node の版は node-version-file: '.nvmrc' で指定し、node-version は書かないこと` +
        `(cache などの他の入力は付けてよい)。実際の指定: ${misconfigured.join(" / ")}。` +
        "版を直書きすると .nvmrc とずれても CI は緑のまま通り、出荷する Node を検証していない状態に戻る。",
    ).toEqual([]);
    // **版が入り込む 2 つ目の口**も塞ぐ。`container: node:20` を据えたジョブは
    // setup-node を 1 本も置かずにそのイメージの Node で steps を回せるため、
    // 上の検査だけでは素通りする (実測で全件緑のまま通った)。
    // ステップ単位の `uses: docker://node:20` も同じ口なので一緒に見る
    // (こちらは setup-node の置き方を見る検査でも拾えない。実測)
    const nodeImageUses = collectNodeImageUses(workflows.jobs);
    const nodeImages = nodeImageUses.map(
      (use) => `${use.file}: ${use.job} (${use.where} ${use.image})`,
    );
    expect(
      nodeImages,
      `node イメージを CI で走らせないこと (ジョブの container: / ステップの uses: docker://)。` +
        `実際の指定: ${nodeImages.join(" / ")}。` +
        "そのイメージの Node でステップが走るので、.nvmrc と別の major で検証している状態になる。" +
        "Node は actions/setup-node に node-version-file: '.nvmrc' を渡して用意すること。",
    ).toEqual([]);
    // **版が入り込む 3 つ目の口**は「書き忘れ」で到達する。ランナーには Node が
    // 最初から入っているので、setup-node を置かないジョブで npm を叩くと
    // ランナー既定の major でスイートが丸ごと走る (上の 2 つは素通りする。実測)。
    // 置いてあっても「リポジトリのコードより後ろ」「if: / continue-on-error 付き」は
    // 同じ結果になるので、位置と効き方まで見る
    const missingSetup = collectJobsMissingSetupNode(
      workflows.jobs,
      new Set(nodeImageUses.map((use) => jobKey(use.file, use.job))),
    ).map((job) => `${job.file}: ${job.job} (${job.reason})`);
    expect(
      missingSetup,
      `このリポジトリのコードを実行するジョブ (run: / ローカル action の呼び出し) には、` +
        `無条件の actions/setup-node をそのコードより前に置くこと。足りていないジョブ: ${missingSetup.join(" / ")}。` +
        "ランナーに最初から入っている Node でそのまま走るため、.nvmrc とは無関係な major で検証している状態になる。" +
        "Node と無関係なジョブは NODE_UNRELATED_JOBS へ理由付きで登録すること。",
    ).toEqual([]);
  });

  it("Node と無関係なジョブの除外表が、実在するジョブだけを理由付きで挙げている", () => {
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
    const stale = inputsBroken
      ? []
      : Object.keys(NODE_UNRELATED_JOBS).filter((key) => !existing.has(key));
    expect(
      stale,
      `NODE_UNRELATED_JOBS に実在しないジョブが登録されている: ${stale.join(" / ")}。` +
        "ジョブを消した・改名したなら、除外もこの差分で消すこと (残すと将来同じ名前のジョブへ黙って効く)。",
    ).toEqual([]);
    // **理由の空欄**を落とす。値を誰も読まないと、空白を入れて検査を黙らせられる
    const withoutReason = Object.entries(NODE_UNRELATED_JOBS)
      .filter(([, reason]) => reason.trim() === "")
      .map(([key]) => key);
    expect(
      withoutReason,
      `NODE_UNRELATED_JOBS の除外には理由を書くこと (空・空白は不可): ${withoutReason.join(" / ")}。`,
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
