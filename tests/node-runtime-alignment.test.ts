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
//       Node を持ち込まないイメージでも落ちるが、除外表は置いていない (理由は
//       `collectImageOnlySteps` の手前の注記)。その形が現れたら検査自体を直す。
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
//       ワークフローが成功で報告されるのに全件緑)。判定を `run:` の文言から当てる形は、
//       綴りが変わるだけで黙って外れた (実測)。**除外表は置いていない** — 空のまま
//       fail-open を 4 つ抱えていたため外した (理由は `runsRepositoryCode` の手前の注記)。
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
//   `actions/setup-node` の `with`、ステップを丸ごとイメージの中で走らせる形
//   (`uses: docker://`)、そして「リポジトリのコードを実行するのに、必ず効く
//   `setup-node` がその前に無い」形。ジョブの `container:` は**見ない** —
//   その中でも setup-node は効くので、誤りは 3 つ目の検査が落とす。
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
//   **宣言として見えない入れ替えの一部は、静的な検査ではなく CI の 1 ステップが持つ。**
//   `scripts/verify-node-major.mjs` が、その行を走らせる Node 自身に
//   「`.nvmrc` と同じ major か」を申告させる (綴りに依存しない)。
//   **覆えるのは「その行より前に行われた、ジョブ全体に効く入れ替え」まで** —
//   `setup-node` の指定、それ以前の `$GITHUB_PATH` への追記、ツールキャッシュの
//   差し替え、コンテナイメージ。**検証が申告できるのは自分が走った時点の Node だけ**
//   なので、次の 2 つは覆えない: (1) **同じ `run:` の中だけで完結する入れ替え**
//   (`. nvm.sh && nvm use 20 && npm test`。`run:` ごとにシェルが新しくなるため)、
//   (2) **この検証より後ろのステップが行う入れ替え**。(2) のうち**宣言として YAML に
//   現れるもの**は静的な検査が落とす — 後続の `uses:` (`volta-cli/action` 等) と、
//   ステップの `env: PATH:` (どちらも実測で素通りしていたため塞いだ)。
//   一方**後続の `run:` による `echo … >> $GITHUB_PATH` や `export PATH=…` は
//   中身を解釈しない限り区別できない**。ここが**残る境界**で、レビューで見るしかない
//   (実測)。**「ジョブがそもそも走らない」形も同じ結末を招く**ので別に見ている —
//   ジョブ単位の `if:` / `continue-on-error` に加えて、`needs:` の先が `if:` で
//   スキップされると依存先も連鎖でスキップされ、それでもワークフローは成功を報告する
//   (実測で全件緑のまま通った)。この検査は、**リポジトリのコードを実行するジョブすべてが**
//   それを無条件で、しかも `setup-node` より後ろで走らせていることまで見る
//   (「どこかの 1 ジョブが走らせていればよい」にすると、スイートを走らせる 2 本目の
//    ジョブで `run: nvm install 20` と書いても全件緑で通った。setup-node より前に
//    置くとランナー既定の Node を検証する空振りになる。パスを含むだけの
//    `echo 'skipping …'` も「実行した」と数えてしまう。いずれも実測)。
//   **判定そのものの挙動は、このファイル末尾のテーブル駆動テストが固定する。**
//   実際の `ci.yml` が準拠しているだけでは、判定を潰しても (`isUnconditionalSetupNode`
//   を `return true` にする等) 全件緑のまま通ってしまい、「塞いだ」証拠が
//   コミットメッセージにしか残らない (実測)。落とす側と通す側の両方を、合成した
//   ジョブ・ステップで固定してある (除外表は置いていない。理由は本文中の注記)。ここを広げたくなったら、まず実際にその形が現れてから、
//   正当なワークフローを巻き添えにしない判定を決めて足すこと。
//
// Node を上げるときの手順 (この検査が要求する形):
//   ピン留め 2 か所と `engines.node` / README / `@types/node` を**同じ PR で**
//   新しい major へ揃える。ignore は残したままでよい (major を上げる主導権を
//   Dependabot ではなく「ランタイムを上げる判断」の側に置くのが目的)。

// Vitest の DSL
import { describe, expect, it } from "vitest";
// ピン留めを書いた素のテキスト (.nvmrc / Dockerfile / README) と、
// ワークフローの一覧 (ファイル名を書き並べず、ディレクトリから列挙する) を読むため。
// 実行時検証スクリプトの挙動を見る検査は、使い捨ての作業場を作って本物を置くので
// ディレクトリ作成・複写・後片付けも要る
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
// 実行時検証スクリプトを**別プロセスとして実際に起動する**ため
// (終了コードで fail-closed を主張しているので、その終了コードごと固定する)
import { spawnSync } from "node:child_process";
// 使い捨ての作業場を OS の一時領域に作るため
import { tmpdir } from "node:os";
// 検査対象のパスを組み立てるため
import { join, resolve } from "node:path";
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
// 上のスクリプトを**実際に起動している** `run:` の 1 行。パスを含むだけの行
// (`echo 'skipping scripts/verify-node-major.mjs'`) と区別するために形で照合する。
// 組み立ては 1 度だけ (`SETUP_NODE_USES` と同じく module スコープの定数にそろえる)
const RUNTIME_VERIFIER_LINE = new RegExp(`^node\\s+${RUNTIME_VERIFIER.replace(/[.]/g, "\\.")}$`);
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
 * major だけを書く運用で、先頭の `v` だけを許す。
 *
 * **コメントを許さないのは、実際に読む側が許さないから。** `.nvmrc` を読むのは
 * `actions/setup-node` (`node-version-file`) と `nvm` で、どちらもファイルの中身を
 * trim するだけで `#` 以降を落とさない。ここだけ寛容にすると、`26 # LTS` のような
 * 内容を**この検査は「26」と読んで緑にするのに CI の Node 準備は壊れる**という、
 * 一番たちの悪い食い違いになる (同じ `.nvmrc` を読む
 * `scripts/verify-node-major.mjs` とも解釈が割れる。実測)。
 */
function readNvmrcMajor(): number | null {
  // ファイルを読む (読めなければ null)
  const text = readTextOrNull(NVMRC_PATH);
  if (text === null) return null;
  // 中身の解釈は純粋関数へ (同じ規則をスクリプト側と突き合わせるため)
  return parseNvmrcMajor(text);
}

/**
 * `.nvmrc` の**中身**から major を読み取る (ファイル入出力を伴わない純粋関数)。
 *
 * **読み取りから切り離してあるのは、同じ規則を守る読み手がもう 1 つあるから。**
 * `scripts/verify-node-major.mjs` も同じ `.nvmrc` を読むが、あちらは `npm ci` より前・
 * 依存ゼロで走る必要があるのでこのモジュールを import できず、規則が**構造上どうしても
 * 2 か所に現れる**。書き写しを消せない以上、せめて**食い違いを機械的に落とす**必要があり、
 * そのために「同じ文字列を両方へ食わせて答え合わせをする」検査が中身だけを渡せる形を要る
 * (下の「`.nvmrc` の書式解釈が、検査側と実行時検証で一致している」)。
 *
 * 規則そのものの根拠は `readNvmrcMajor` の docstring を参照 (実際に読む
 * `actions/setup-node` / `nvm` が trim しかしないので、コメントも小数点も許さない)。
 */
function parseNvmrcMajor(text: string): number | null {
  // 前後の空白だけを落として、先頭の `v` 付きの数字だけを受け取る。
  // **0 埋め (`026`) は受け取らない** — 実際に `.nvmrc` を読む `actions/setup-node`
  // は `026` を解決できず「Unable to find Node version」で落ちるので、
  // ここで通すと「2 つの読み手は一致しているのに、本物の読み手だけが落ちる」
  // という食い違いになる (この関数がそろえようとしているのは本物の読み手の規則)
  const matched = text.trim().match(/^v?(0|[1-9]\d*)$/);
  // 形が合わなければ読めなかった扱い (呼び出し側が fail-closed で落とす)
  return matched ? Number(matched[1]) : null;
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
  // そのジョブの定義 (steps / continue-on-error などを読む)
  definition: Record<string, unknown>;
  // ワークフロー全体の `env:` (トップレベル)。ジョブ単位の env と同じく
  // **宣言として YAML に現れる差し替え**なので、PATH の宣言をここからも読む。
  // 合成したジョブを渡すテストのために省略可
  workflowEnv?: unknown;
  // ワークフロー全体の `on:` (トップレベル)。**そのジョブがそもそも PR で走るか**を
  // 見るために運ぶ。`if:` / `needs:` / `continue-on-error` と同じ「走らない形」の
  // いちばん外側で、しかも他の 3 つと違って**ジョブ定義には現れない**。
  // 合成したジョブを渡すテストのために省略可
  workflowTriggers?: unknown;
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
 * 解釈できたワークフロー 1 本から、ジョブを平らに取り出す (読めない箇所は原因を返す)。
 *
 * **走査本体から切り出してあるのは、ここがテストから叩けないと退行が拾えないから。**
 * `scanWorkflows` は実在の `.github/workflows/` を読むので、合成した中身を
 * 食わせられない。実測でも、**ワークフロー全体の `env:` を運ぶのをやめる変異が
 * 全件緑のまま通った** (運ぶ先の判定はテストがあるのに、運ぶ配線だけ無検証だった)。
 *
 * 読めない形を 3 段すべてで落とすのは、1 段でも緩いとそのジョブだけが検査から
 * 静かに外れるため (実測で 1 段ずつ見つかった)。
 */
function jobsOfWorkflow(
  file: string,
  value: unknown,
): { jobs: WorkflowJob[]; problems: string[] } {
  // 取り出せたジョブ
  const jobs: WorkflowJob[] = [];
  // 読めなかった箇所の原因
  const problems: string[] = [];
  // **ワークフロー全体の `env:`** も一緒に運ぶ (ジョブ単位の env と同じく
  // そのジョブの全ステップに効くので、PATH の宣言をここからも読む)
  const workflowEnv = asRecord(value).env;
  // **ワークフロー全体の `on:`** も運ぶ (PR で実際に起動するかを見るため)。
  // **キーの綴りが 2 通りありうる。** YAML 1.1 のパーサは裸の `on` を真偽値として
  // 読むためキーが `true` になる (この repo が使う yaml v2 は YAML 1.2 の core schema
  // なので `"on"` のまま読めるが、パーサを差し替えたときに**黙って
  // 「`on:` が無い」と読まれる**のは避けたい。下の判定は fail-closed なので、
  // 取りこぼすと正当なワークフローが赤くなる = 見逃す側には倒れない)
  const workflowTriggers = asRecord(value).on ?? asRecord(value).true;
  // **`jobs` が対応表になっていることまで確かめる。**
  // `readParsed` が見るのはトップレベルだけなので、`jobs: "extra"` のような形は
  // 例外にならず `asRecord` が `{}` に潰す = そのワークフローが黙って検査から外れる
  // (トップレベルで塞いだのと同じ fail-open が 1 段下に残っていた。実測)
  const jobsValue = asRecord(value).jobs;
  if (!isPlainMapping(jobsValue)) {
    problems.push(`${file}: jobs が対応表ではありません (${describeShape(jobsValue)})`);
    return { jobs, problems };
  }
  // jobs 直下をジョブ名付きで平らに並べる
  for (const [name, definition] of Object.entries(jobsValue)) {
    // ジョブの中身も対応表でなければ、steps も continue-on-error も読めない = 見逃す側に倒れる
    if (!isPlainMapping(definition)) {
      problems.push(
        `${file}: ジョブ ${name} の定義が対応表ではありません (${describeShape(definition)})`,
      );
      continue;
    }
    // **`steps` の 1 段下も同じ扱いで見る。** `steps: "npm ci"` や
    // `steps: ["npm ci"]` は例外にならず、配列判定 / `asRecord` が黙って潰すため、
    // そのジョブが検査すべてから外れる (実測で全件緑のまま通った)
    const stepsProblem = describeStepsProblem(definition.steps);
    if (stepsProblem !== null) {
      problems.push(`${file}: ジョブ ${name} の ${stepsProblem}`);
      continue;
    }
    // 読めたジョブを、どのワークフローの何という名前か・全体の env と一緒に控える
    jobs.push({ file, name, definition, workflowEnv, workflowTriggers });
  }
  // 取り出せたジョブと、読めなかった箇所を返す
  return { jobs, problems };
}

/**
 * 置き場のワークフローすべてを読み、ジョブを平らに並べる。
 *
 * **走査を 1 か所に集めるのが目的。** Node の版が入り込む口は 3 つ
 * (`setup-node` の `with` / ステップの `uses: docker://` / `setup-node` の置き方) あり、
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
    // 解釈できた 1 本からジョブを取り出す (判定の中身は jobsOfWorkflow が持つ)
    const extracted = jobsOfWorkflow(file, read.value);
    // 読めたジョブを積み、読めなかった箇所は原因付きで控える
    jobs.push(...extracted.jobs);
    unreadable.push(...extracted.problems);
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
 * ステップの `with:` を、**キーを小文字にそろえた**対応表として読む。
 *
 * **GitHub はアクションの入力名を大文字小文字を無視して解決する。** ランナーは
 * `with: { Node-Version: '20' }` を `INPUT_NODE-VERSION=20` として渡し、
 * `core.getInput('node-version')` は名前を大文字化して引くので、**setup-node は
 * これを `node-version` の指定として受け取り Node 20 を入れる**。
 * キーをそのまま比べると、この綴りだけが検査から外れて版の直書きが通る (実測で全件緑)。
 * `uses:` の照合を `/i` にしたのとまったく同じ事情なので、同じ扱いにそろえる。
 *
 * 値は触らない — 見るのは「どのキーが書かれているか」と `node-version-file` の綴りだけ。
 */
function normalizeInputs(withValue: unknown): Record<string, unknown> {
  // with: が対応表でなければ空として扱う (指定なしと同じ)
  const raw = asRecord(withValue);
  // キーを小文字にそろえて詰め直す
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]));
}

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

/**
 * そのステップが `env:` で `PATH` を宣言しているか。
 *
 * **`uses:` と同じ「宣言として YAML に現れる差し替え」**なので、静的に読める。
 * ステップの `env.PATH` はそのステップのプロセスの探索パスを丸ごと置き換えるので、
 * `/opt/node20/bin` を先頭に置けば `npm` も `node` も別の major になる。
 * 読まないと、実行時検証の後ろに `env:` を添えるだけで**両方の網が緑のまま**
 * スイートが別の Node で走る (実測)。
 *
 * 大文字小文字を区別しないのは、ランナー (Linux) では `PATH` だが、
 * YAML のキーを `Path` と書いても GitHub は環境変数名としてそのまま渡すため
 * (Windows ランナーでは実際に効く)。拾いすぎても赤くなるだけで、見逃す側には倒れない。
 */
function declaresPathEnv(step: Record<string, unknown>): boolean {
  // env: が対応表でなければ、宣言として読める PATH は無い
  if (!isPlainMapping(step.env)) return false;
  // キーに PATH があるかを、大文字小文字を無視して見る
  return Object.keys(step.env).some((key) => key.toUpperCase() === "PATH");
}

/**
 * 差し替えうるステップを、失敗文言に出す 1 つの語句にする。
 *
 * `uses:` ならその参照を、`env: PATH:` ならその旨を出す (どちらを直せばよいか分かるように)。
 */
function describeSwapper(step: Record<string, unknown>): string {
  // uses: があるならそれを見せる (ワークフローを grep して見つけられる綴りのまま)
  const uses = usesOf(step);
  // 無ければ env: PATH: の指定であることを伝える
  return uses !== "" ? uses : "env: PATH: の指定";
}

/** そのステップが `actions/setup-node` を呼んでいるか。 */
function isSetupNodeStep(step: Record<string, unknown>): boolean {
  // uses を文字列として照合する (未指定なら空文字列 = 一致しない)
  return SETUP_NODE_USES.test(usesOf(step));
}

/**
 * その `setup-node` ステップが **必ず効く** 置き方かを判定する。
 *
 * 「置いてあること」だけでは足りない理由と、どの書き方を「効かない」とみなすかは
 * `isUnconditionalStep` が持つ (写しを置くと、規則を直したとき片方だけが残る)。
 */
function isUnconditionalSetupNode(step: Record<string, unknown>): boolean {
  // setup-node のステップでなければ対象外
  if (!isSetupNodeStep(step)) return false;
  // 「必ず効く置き方か」の判定は共有する (setup-node と実行時検証で同じ事情のため)
  return isUnconditionalStep(step);
}

/**
 * そのステップが**必ず効く**置き方かを判定する (`setup-node` 以外にも使う)。
 *
 * 効かなくても後続が走る書き方が 2 つある:
 *   - `if:` … 条件が偽なら実行されない (条件の中身は静的に決まらないので、
 *     「無条件でない」ことをもって落とす)。
 *   - `continue-on-error:` … 失敗してもジョブは成功で終わる。明示的な `false` だけは
 *     「効かない書き方」ではないので通す。
 */
function isUnconditionalStep(step: Record<string, unknown>): boolean {
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
      .map((step) => ({ file: job.file, job: job.name, inputs: normalizeInputs(step.with) }));
  });
}

/**
 * ステップを**丸ごとイメージの中で走らせている**箇所 1 つ分 (`uses: docker://<image>`)。
 *
 * **イメージ名は問わない。** 唯一の作り手である `collectImageOnlySteps` は
 * `docker://` のステップをすべて集める (名前を `node` に絞ると
 * `docker://ghcr.io/acme/ci-node:20` が素通りした = 実測)。
 *
 * **ジョブの `container:` はこの型に流れてこない。** その中でも `setup-node` は動くので
 * `container: node:26-alpine` + 正しい `setup-node` は正当な形で、誤りは
 * 「setup-node が無いこと」のほう = `collectJobsMissingSetupNode` が落とす。
 * 型の名前と説明を作り手の実態に合わせておかないと、読み手が `container:` の値も
 * ここを通ると誤解し、**一度実測して取り下げた**「正当な形に直しようの無い要求」を
 * 復活させかねない (§6 設計判断を残す)。
 */
interface ImageStepUse {
  // 失敗メッセージに出す、どのワークフローのどのジョブかを示す名前
  file: string;
  // ジョブ名 (jobs 直下のキー)
  job: string;
  // 書かれていた場所を、YAML に現れるとおりの 1 つの文字列で持つ
  // (`uses: docker://node:20`)。場所と値を別々に持って文言側で連結すると
  // `uses: docker:// node:20` のように実在しない空白が入り、
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
 * **名前空間は問わない。** 社内ミラー (`registry.corp.example/node:22-alpine`、
 * `harbor.corp/node:22`) は現実的な形で、そこに別 major の段が足されるのは
 * まさにこの判定が検出したいドリフトそのもの。公式 (`library`) に絞っていたときは
 * ミラーの段が**素通り**した (実測で全件緑)。
 *
 * 唯一の利用側は `readDockerfileNodeMajor`。ここで拾いすぎても「ピンが 2 つある」と
 * 赤くなるだけで、**見逃す側には倒れない** (ジョブの `container:` を一律に落として
 * いたときは正当な形に直しようの無い要求を出していたが、その利用側はもう無い)。
 */
function isNodeImage(image: string): boolean {
  // ダイジェスト指定 (`@sha256:...`) が付いていれば切り落とす
  const withoutDigest = image.split("@")[0];
  // レジストリ・名前空間を落として、最後のパス要素だけを取り出す
  const lastSegment = withoutDigest.split("/").pop() ?? "";
  // タグ (`:20-alpine`) を落として、リポジトリ名だけにする
  const repository = lastSegment.split(":")[0];
  // 名前が node のものだけを node イメージとして扱う (node-tools 等は拾わない)
  return repository === "node";
}

/**
 * **除外表は置かない (意図的)。**
 *
 * 以前はジョブ単位の `NODE_GUARD_EXEMPTIONS` (鍵 `setupNode` / `image` /
 * `runtimeVerifier`) を持っていたが、**一度も使われないまま fail-open を 4 つ抱えていた**:
 *   - `image` の免除がジョブ単位だったため、`docker://hadolint` を理由に登録したジョブへ
 *     後から `docker://node:20` を足すと、その step も一緒に免除された。しかもその形は
 *     `run:` を持たないので `collectJobsMissingSetupNode` も素通りし、**スイートが
 *     丸ごと別の Node で走るのに全件緑**になった (実測)。
 *   - `setupNode` の免除が steps を読む前に打ち切っていたため、ジョブ単位の `if:` /
 *     `continue-on-error` の検査も、実行時検証の要求も、まとめて外れた (実測)。
 *   - `runtimeVerifier` の 1 つの理由が「検証より前に `run:` が要る」と
 *     「検証より後ろの `uses:` は差し替えない」という**別々の主張**を同時に許していた。
 *
 * いずれも「1 つの理由が、その理由では正当化できない検査まで免除する」という同じ形で、
 * 鍵を分けるたびに次の組み合わせで再発した。**表そのものが空で、実在するジョブは
 * `ci.yml` の `lint-and-test` 1 つだけ**だったので、存在しない事情のために作った
 * 逃げ道が、守るはずの保証を黙って外す口になっていたことになる。
 *
 * そこで表ごと外し、検査はすべて無条件で掛ける。実在するワークフローの挙動は変わらない
 * (表は空だったので、もともと全ジョブが検査対象だった)。**本当に除外が要るジョブが
 * 現れたら、そのときの具体例に合わせて範囲を設計する** — この判断は、同じファイルが
 * `.github/actions/` の走査について書いているのと同じ考え方 (存在しない事情のために
 * 対象範囲を広げない。CLAUDE.md §6「将来を見越した過度な抽象化は避ける」)。
 * 逃げ道が無いぶん、例外が要るときは**この検査自体を直す差分**になり、レビューを必ず通る。
 */

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

/**
 * そのステップが**実行時検証を実際に起動している**かを判定する。
 *
 * パスを含むかどうかだけを見ると、`echo 'skipping scripts/verify-node-major.mjs'` や
 * 複数行 `run:` の中のコメント行でも満たせてしまう (スクリプトは 1 度も走らない)。
 * そこで `run:` を行に割り、**`node <パス>` そのものの行**があることを求める。
 */
function invokesRuntimeVerifier(step: Record<string, unknown>): boolean {
  // run: を行に割り、前後の空白を落としてから、起動の行そのものを探す
  return String(step.run ?? "")
    .split("\n")
    .map((line) => line.trim())
    .some((line) => RUNTIME_VERIFIER_LINE.test(line));
}

/**
 * そのワークフローが、**絞り込みの無い `pull_request`** で起動するか。
 *
 * **「そもそも走らない形」のいちばん外側。** ジョブ単位の `if:` / `continue-on-error` /
 * `needs:` の連鎖は `jobNeverRunsReason` が落とすが、`on:` はそれらの外側にあって
 * ジョブ定義には現れない。`on: { workflow_dispatch: }` に書き換えると、
 * **lint / typecheck / test / e2e と実行時検証がまるごと PR で走らなくなる**のに、
 * ジョブ側の検査はどれも「置き方は正しい」と言って全件緑になる (実測)。
 * 塞いだ `needs:` gate とまったく同じ結末に、別のキーで届く形。
 *
 * **絞り込みも許さない。** `paths-ignore` や `types:` を足した瞬間、
 * 「その条件に当たらない PR だけ検証されない」という、より見つけにくい同じ穴になる
 * (ドキュメントだけを変える PR で Node の検証が走らない、など)。
 * `pull_request` に値を書かない形だけを通す (= 現在の `ci.yml` の形)。
 *
 * **`on:` を読めない形は通さない (fail-closed)。** ここで拾いすぎても
 * 「PR で走る保証が読み取れない」と赤くなるだけで、しかも直し方は
 * 「`pull_request:` と書く」の 1 通りしかないので、**直しようの無い要求にはならない**。
 * 逆に読めない形を通すと、`on:` の書き方を変えた 1 本だけが黙って検査から外れる。
 */
function triggersOnEveryPullRequest(triggers: unknown): boolean {
  // `on: push` / `on: [push, pull_request]` のような形は、絞り込みの有無を
  // 対応表として読めない。イベント名の配列は絞り込みを書けない形なので
  // 本来は安全だが、**通すと「読めない形を通す」判断が 1 つ増える** — その緩みは
  // 次に別の書き方が現れたときの前例になるので、対応表だけを認める
  if (!isPlainMapping(triggers)) return false;
  // `pull_request` が無ければ、PR では 1 度も走らない
  if (!("pull_request" in triggers)) return false;
  // 値を書かない形 (`pull_request:`) が「絞り込み無し」。YAML では null になる
  const filter = triggers.pull_request;
  if (filter === null || filter === undefined) return true;
  // `pull_request: {}` と書いた形も同じ意味なので通す。
  // キーが 1 つでもあれば絞り込みなので通さない
  return isPlainMapping(filter) && Object.keys(filter).length === 0;
}

/**
 * ジョブの `needs:` を名前の配列として読む (未指定なら空配列)。
 *
 * `needs` は 1 本なら文字列、複数なら配列で書ける。どちらも同じ意味なので、
 * 読み方をここ 1 か所に置く。
 */
function needsOf(definition: Record<string, unknown>): string[] {
  // 文字列 1 本の形
  if (typeof definition.needs === "string") return [definition.needs];
  // 配列の形 (要素は文字列だけを採る)
  if (Array.isArray(definition.needs)) {
    return definition.needs.filter((name): name is string => typeof name === "string");
  }
  // 指定なし
  return [];
}

/**
 * `needs:` をたどって、**スキップが伝播してくるジョブ**の名前を返す (無ければ null)。
 *
 * **ジョブ自身の `if:` を見るだけでは足りない。** GitHub は `if:` が偽で
 * スキップされたジョブの**依存先も連鎖でスキップ**し、それでもワークフローは
 * 成功として報告する。つまり `if: ${{ false }}` のゲートジョブを 1 つ置き、
 * スイートのジョブに `needs: gate` と書くだけで、**lint / typecheck / test / e2e も
 * 実行時検証も 1 つも動かないまま CI が緑**になる (実測で全件緑のまま通った)。
 * これは隣の「ジョブ単位の `if:` / `continue-on-error`」の判定が塞いだのと
 * まったく同じ結末で、読む YAML のキーが違うだけ。
 *
 * **`continue-on-error` は伝播しない** ので見ない。付いたジョブは失敗しても
 * 「成功」として扱われ、依存先はそのまま走る (そのジョブ自身の問題は隣の判定が落とす)。
 *
 * 伝播は連鎖するので推移的にたどる。同じジョブを 2 度たどらないので、
 * `needs` が循環していても止まる (GitHub 側では構文エラーになる形)。
 */
function skipPropagatingNeed(
  definition: Record<string, unknown>,
  siblings: ReadonlyMap<string, Record<string, unknown>>,
): string | null {
  // これからたどる名前 (最初は直接の needs)
  const queue = needsOf(definition);
  // 一度たどった名前 (循環と重複を避ける)
  const seen = new Set<string>();
  // たどる先が無くなるまで繰り返す
  while (queue.length > 0) {
    // 次の名前を取り出す
    const name = queue.shift() as string;
    // 既に見たならたどらない
    if (seen.has(name)) continue;
    // 見たことにする
    seen.add(name);
    // 同じワークフローの中の定義を引く (無ければたどれないので飛ばす)
    const needed = siblings.get(name);
    if (needed === undefined) continue;
    // `if:` が付いていれば、そこからスキップが伝播してくる
    if ("if" in needed) return name;
    // さらに先の needs もたどる
    queue.push(...needsOf(needed));
  }
  // 伝播してくるジョブは無い
  return null;
}

/**
 * そのジョブが**そもそも走らない / 失敗しても緑になる**形かを調べ、理由を返す (無ければ null)。
 *
 * 3 つの形が同じ結末を招く。どれも lint / typecheck / test / e2e が 1 つも動かない、
 * あるいは失敗しても CI が緑になる (いずれも実測で素通りした):
 *   - ジョブの `if:` … 条件が偽ならスキップされ、ワークフローは成功を報告する。
 *   - ジョブの `continue-on-error` … 失敗しても成功として扱われる。
 *   - `needs:` の先が `if:` … スキップは依存先へ**連鎖**する (skipPropagatingNeed)。
 *
 * 条件の中身は静的に決まらないので、ステップ側と同じく「無条件でないこと」で落とす。
 */
function jobNeverRunsReason(
  definition: Record<string, unknown>,
  siblings: ReadonlyMap<string, Record<string, unknown>>,
): string | null {
  // ジョブ自身に条件が付いているか
  if (!isUnconditionalStep(definition)) {
    // どちらが付いているかを文言で分ける (直す先が違うため)
    return "if" in definition
      ? "ジョブに if: が付いている (スキップされても CI は緑になる)"
      : "ジョブに continue-on-error が付いている (失敗しても CI は緑になる)";
  }
  // needs: の先から伝播してくるスキップを探す
  const skippedNeed = skipPropagatingNeed(definition, siblings);
  // 見つかればそのジョブ名を添えて理由にする
  if (skippedNeed !== null) {
    return `needs: の先に if: 付きのジョブ (${skippedNeed}) がある (そのジョブがスキップされると、このジョブも走らないまま CI は緑になる)`;
  }
  // どれにも当てはまらない
  return null;
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
 * `setup-node` の `with` とイメージだけを見る検査はこれを**全件緑のまま通す** (実測)。
 *
 * 「置いてあるか」だけでは足りず、**位置と条件**まで見る (どちらも実測で素通りした):
 *   - `run: npm ci` の**後ろ**に `setup-node` … `npm ci` はランナー既定の Node で走り、
 *     そこで入る / ビルドされる node_modules は検証していない Node のもの。
 *   - `if:` 付きの `setup-node` … 実行されなければランナー既定の Node のまま。
 *     条件の中身は静的に決まらないので、「無条件でない」ことをもって落とす。
 *
 * 判定を `run:` の**文言**から当てないのは、綴りを変えるだけで黙って外れるから
 * (実測: `./node_modules/.bin/vitest run` も `/usr/local/bin/node server.js` も
 * 拾えなかった)。構造で見て、当てはまるジョブはすべて対象にする (fail-closed。
 * 例外の逃げ道を持たない理由は `runsRepositoryCode` の手前の注記)。
 *
 * **イメージ側の検査と重複しても、それぞれの理由で名指しする。** 以前は
 * `uses: docker://` で名指しされたジョブを丸ごと除いていたが、その抑止が
 * **効くのは抑止して困る場合だけ**だった: イメージだけのジョブ (`run:` も
 * ローカル action も無い) は `firstRepoCode === -1` でどのみちここを素通りするので
 * 抑止は要らず、逆に `docker://hadolint` と `run: npm ci` を両方持つジョブでは、
 * hadolint の 1 行が**同じジョブの setup-node / 実行時検証 / 差し替えの指摘を
 * まとめて伏せて**いた (CI は赤のままだが、docker の行を消すまで本当の問題が
 * 表に出ず、巡が 1 つ増える)。これは除外表を外した理由と同じ形
 * 「1 つの事情が、それでは正当化できない検査まで免除する」。
 */
function collectJobsMissingSetupNode(jobs: readonly WorkflowJob[]): MissingSetupNodeJob[] {
  // **ワークフローごとのジョブ索引は 1 度だけ作る。** `needs:` をたどるのに要るが、
  // 中身はジョブごとに変わらない (ループ不変) ので、各ジョブで作り直すと
  // ジョブ数の 2 乗の走査になる
  const byFile = new Map<string, Map<string, Record<string, unknown>>>();
  // 全ジョブを 1 度なめて、ファイルごとの「名前 → 定義」を組み立てる
  for (const job of jobs) {
    // そのファイルの索引を用意する (無ければ作る)
    const index = byFile.get(job.file) ?? new Map<string, Record<string, unknown>>();
    // ジョブ名で引けるようにする
    index.set(job.name, job.definition);
    // 作ったばかりなら入れておく
    byFile.set(job.file, index);
  }
  // 平らに並べたジョブを 1 つずつ見る
  return jobs.flatMap((job) => {
    // 同じワークフローのジョブだけを引く — ジョブ名はワークフローごとに独立している
    const siblings = byFile.get(job.file) ?? new Map<string, Record<string, unknown>>();
    // 「そもそも走らない」形の理由 (無ければ null)
    const neverRuns = jobNeverRunsReason(job.definition, siblings);
    // steps を持つか (持たないのは再利用可能ワークフローの呼び出し)
    const steps = stepRecordsOf(job);
    // **steps を持たないジョブでも、ローカルの再利用可能ワークフローを呼ぶなら
    // 「そもそも走らない」形は見る。** 呼ばれる側のジョブはこの走査に含まれるので
    // 置き方は別に検査されるが、**呼び出し側が gate されるとその全部が走らないまま
    // CI は緑**になる (`needs:` で塞いだのとまったく同じ結末に、別のキーで届く)。
    // 第三者の再利用可能ワークフロー (`other-org/...`) は走査対象外なので、
    // 条件を付けるなと求める筋が無く、対象にしない
    if (steps === null) {
      // ローカルの呼び出しでなければ対象外
      if (!usesOf(job.definition).startsWith("./")) return [];
      // gate されていればそれを名指しし、そうでなければ置き方は呼ばれる側で見る
      return neverRuns === null ? [] : [{ file: job.file, job: job.name, reason: neverRuns }];
    }
    // このリポジトリのコードを最初に実行するステップの位置
    const firstRepoCode = steps.findIndex(runsRepositoryCode);
    // 1 つも無ければ、第三者アクションだけのジョブなので対象外
    if (firstRepoCode === -1) return [];
    // 走らない形なら、置き方を見る前にそれを名指しする
    if (neverRuns !== null) return [{ file: job.file, job: job.name, reason: neverRuns }];
    // **ステップより広い場所で宣言された `env: PATH:` は、そのジョブの全ステップに効く。**
    // ステップ単位のものと同じく**宣言として YAML に現れる**のに読まないと、
    // 広い側で `/opt/node20/bin` を先頭に置き、実行時検証のステップだけ
    // step 単位の `env:` で正しい PATH に戻す、という 2 段構えで
    // **両方の網が緑のまま**スイートが別の Node で走る (実測)。
    // 位置に関係なく効くので、宣言があること自体を落とす (直し方は「宣言しない」)。
    // **`container:` の `env:` も同じ扱いにする** — これもコンテナの中で走る全ステップに
    // 効くので、ジョブ / ワークフロー単位だけを塞いでも同じ 2 段構えが `container.env`
    // 経由でそのまま通る (3 つのうち 1 つでも読み落とすと、その 1 つへ書き換えるだけで
    // 迂回できる = 塞いだつもりの穴が別のキーで開いたままになる)。
    // `container:` が文字列 (`container: node:20`) のときは `env:` を持ちようがなく、
    // `asRecord` が空の対応表に潰すので何も宣言していない扱いになる
    const scopedPathEnv = [
      { label: "ジョブ", holder: job.definition },
      { label: "ワークフロー", holder: { env: job.workflowEnv } },
      { label: "コンテナ", holder: asRecord(job.definition.container) },
    ]
      .filter((scope) => declaresPathEnv(scope.holder))
      .map((scope) => scope.label);
    if (scopedPathEnv.length > 0) {
      return [
        {
          file: job.file,
          job: job.name,
          reason: `${scopedPathEnv.join(" / ")}単位の env: で PATH を宣言している (そのジョブの全ステップの探索パスが変わる)`,
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
    // **実行時検証も同じジョブで、無条件・setup-node より後ろに置く。**
    // 「どこかの 1 ジョブが走らせていればよい」にすると、スイートを走らせる 2 本目の
    // ジョブで `run: nvm install 20` と書いても全件緑のまま通る (実測)。
    // setup-node より前に置くと、ランナー既定の Node を検証するだけの空振りになる
    const verifierIndex = steps.findIndex(
      (step) => invokesRuntimeVerifier(step) && isUnconditionalStep(step),
    );
    // 1 つも無ければ、そのジョブは「宣言として見えない形」を何も検証していない
    if (verifierIndex === -1) {
      // 実体が無いのか、条件付きなのかを文言で分ける
      const reason = steps.some(invokesRuntimeVerifier)
        ? `${RUNTIME_VERIFIER} に if: / continue-on-error が付いている`
        : `${RUNTIME_VERIFIER} を実行していない`;
      return [{ file: job.file, job: job.name, reason }];
    }
    // setup-node より前だと、用意した Node ではなくランナー既定の Node を見てしまう
    if (verifierIndex < setupIndex) {
      return [
        {
          file: job.file,
          job: job.name,
          reason: `${RUNTIME_VERIFIER} が setup-node より前にある (用意した Node を検証していない)`,
        },
      ];
    }
    // **リポジトリのコードより後ろでもいけない。** 先にスイートを走らせてから検証すると、
    // 検証は「そのステップの Node」を見るだけで、既に走り終えた検証 (lint / test / e2e) が
    // どの Node で動いたかは分からない。`$GITHUB_PATH` などジョブ全体に効く入れ替えを
    // 挟む形が、後置だと素通りした (実測)。検証自身も `run:` なので、期待どおりの
    // 並びでは検証が「最初のリポジトリのコード」になる
    if (verifierIndex > firstRepoCode) {
      return [
        {
          file: job.file,
          job: job.name,
          reason: `${RUNTIME_VERIFIER} がリポジトリのコードより後ろにある (先に走った検証の Node が分からない)`,
        },
      ];
    }
    // **実行時検証のステップ自身の `env: PATH:` を落とす。** 下の「検証より後ろ」の走査は
    // `verifierIndex + 1` から始まるので、**検証ステップに付けた `env: PATH:` だけが
    // どちらの網からも見えない**。これは上で塞いだ広い側の宣言と**対になる穴**で、
    // 向きが逆なだけの同じ 2 段構えになる: `setup-node` の後ろに
    // `volta-cli/action (node-version: '20')` を置いて PATH の先頭を Node 20 にし、
    // **検証ステップにだけ** `env: { PATH: <Node 26 の bin>:... }` を添えると、
    // 検証は「26 です」と申告して終了コード 0 で通り、続く `npm ci` / lint / test は
    // Node 20 で走る (実測で全件緑)。実行時検証は「宣言として見えない入れ替え」を
    // 引き受けている最後の砦なので、**その砦自身の探索パスを別に向ける宣言**は
    // 値に関わらず落とす (直し方は「検証ステップに PATH を宣言しない」)
    if (declaresPathEnv(steps[verifierIndex])) {
      return [
        {
          file: job.file,
          job: job.name,
          reason: `${RUNTIME_VERIFIER} のステップに env: で PATH が宣言されている (検証だけ別の Node を指せる)`,
        },
      ];
    }
    // **「setup-node がリポジトリのコードより後ろ」を別途見る必要は無い。**
    // ここまでの判定で `setupIndex <= verifierIndex <= firstRepoCode` が確定しており、
    // 実行時検証自身も `run:` (= リポジトリのコード) なので、setup-node は必ず
    // 最初のリポジトリのコードより前にある。**この不変条件は「どの判定も免除されない」
    // ことに依存する** — 除外表を持っていた頃は `runtimeVerifier` の免除が右側の
    // 不等号を外し、`[run: npm ci, setup-node, 検証, run: npm run test]` が
    // 名指しされないまま `npm ci` をランナー既定の Node で走らせていた (実測)。
    // 除外表を外したのでこの穴は閉じており、ここに分岐を置くと一度も出ない
    // 死んだコードになる (§6 デッドコードを残さない)。
    // **実行時検証の「後ろ」で Node を差し替える形を落とす。**
    // 上の並び順の要求により、実行時検証は必ず**最初のリポジトリのコード**になる。
    // つまり検証が見るのは「その時点」の Node で、**それより後ろで入れ替えられると
    // 静的な網からも実行時検証からも見えない**。実測で、正しい setup-node と検証の
    // 後ろに `uses: volta-cli/action@v4 (node-version: '20')` を足した形は
    // **全件緑のまま通り**、lint / test / e2e は実際には Node 20 で走る。
    // アクションの名前で絞らないのは、`docker://ghcr.io/acme/ci-node:20` が
    // 素通りしたのと同じ理由 (名前から Node を持ち込むかは判定できない)。
    // **最後のリポジトリのコードより後ろは見ない** — そこに置かれた
    // `actions/upload-artifact` はもう誰の Node にも影響しないので、
    // 落とすと正当な形に直しようの無い要求を出すことになる。
    // **`run:` による差し替え (`echo ... >> $GITHUB_PATH`) はここでも見えない** —
    // 中身を解釈しない限り区別できず、冒頭コメントに「残る境界」として書いてある。
    // 最後にリポジトリのコードを実行するステップの位置 (それより後ろは影響しない)
    const lastRepoCode = steps.map(runsRepositoryCode).lastIndexOf(true);
    // 検証より後ろ・最後のリポジトリのコードまでにある uses: のステップを集める。
    // **終端を含める (`+ 1`)。** 最後のリポジトリのコードが `run:` なら `usesOf` が
    // 空文字列なので下の絞り込みで落ち、含めても何も変わらない。一方それが
    // **ローカルの composite action (`uses: ./...`)** のときは、そのステップ自身が
    // 「中身を読めない uses:」と「スイートの実行」を兼ねる — 終端を除いていたときは
    // `[setup-node, 検証, uses: ./.github/actions/run-suite]` が**名指しされず**、
    // action.yml の中で Node を入れ替えてからスイートを走らせる形が
    // 静的な網からも実行時検証からも見えなかった (実測で空配列)。
    // 後ろにもう 1 つ `run:` を足すと同じ差し替えが捕まっていたので、
    // 見落としは純粋にこの境界だけが原因。
    // **ステップの `env: PATH:` も同じ扱いで見る。** これは `run:` の中身と違って
    // **宣言として YAML に現れる**ので、静的に読める — 読まないと
    // `run: npm ci && npm run test` に `env: { PATH: /opt/node20/bin:... }` を添えるだけで
    // スイートが別の Node で走り、**両方の網が緑のまま**になる (実測)。
    // `run:` の中の `export PATH=...` は中身を解釈しないと分からないので引き続き見えず、
    // そちらは冒頭コメントに「残る境界」として書いてある。
    const swappers = steps
      .slice(verifierIndex + 1, lastRepoCode + 1)
      .filter((step) => usesOf(step) !== "" || declaresPathEnv(step));
    // 1 つでもあれば、検証済みの Node で残りが走る保証が無い
    if (swappers.length > 0) {
      return [
        {
          file: job.file,
          job: job.name,
          reason:
            `${RUNTIME_VERIFIER} より後ろに Node を差し替えうるステップがある ` +
            `(${swappers.map(describeSwapper).join(" / ")})。検証した Node のまま走る保証が無い。` +
            // **直し方は 2 通りあり、ローカル action だけ別**。第三者アクションや
            // `env: PATH:` は位置を変えれば済むが、`uses: ./...` は**それ自身が
            // リポジトリのコード**なので、前へ出せば「検証より前」、後ろへ出そうにも
            // 自分が最後のリポジトリのコード — どちらの案内も成立しない。
            // 案内どおりに直せない要求は、いずれ検査ごと緩められる (この repo が
            // 繰り返し避けている形) ので、取れる手段だけを書く
            (swappers.some((step) => usesOf(step).startsWith("./"))
              ? "ローカル action の中身は読めないので、Node を使う処理はジョブ側の run: で行うこと"
              : "Node と無関係なステップ (actions/cache 等) なら、検証より前か、" +
                "最後にリポジトリのコードを実行するステップより後ろへ移すこと"),
        },
      ];
    }
    // ここまでのどの判定にも掛からなければ、置き方は満たされている
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
 * ものも落ちる (除外表は置いていない。理由は `runsRepositoryCode` の手前の注記)。
 *
 * **`container:` はここでは見ない。** `container: node:20` でも `setup-node` は
 * コンテナの中で動いて `.nvmrc` の Node を入れるので、それ自体は誤りではない。
 * 誤りなのは「リポジトリのコードを走らせるのに `setup-node` が無い」ことのほうで、
 * それは `collectJobsMissingSetupNode` が `container:` の有無に関係なく落とす。
 * ここで node イメージを一律に落としていたときは、`container: node:26-alpine` +
 * 正しい `setup-node` という**正当な形に直しようの無い要求**が出ていた (実測)。
 */
function collectImageOnlySteps(jobs: readonly WorkflowJob[]): ImageStepUse[] {
  // 共有の走査で平らに並べたジョブを受け取り、各ステップの uses: を見る
  return jobs.flatMap((job) => {
    // 見つけた箇所を溜める入れ物
    const found: ImageStepUse[] = [];
    // 各ステップを順に見る (steps が無いジョブは空で回す)
    for (const step of stepRecordsOf(job) ?? []) {
      // uses を文字列として取り出す
      const uses = usesOf(step);
      // docker:// で始まらないステップはイメージを直接走らせていない
      if (!uses.startsWith(DOCKER_USES_PREFIX)) continue;
      // どのワークフローのどのジョブが、どこでイメージを走らせているかを控える
      // (イメージ名は `location` にそのまま含まれるので、別フィールドは持たない —
      //  持つと文言を組み立て直す人が空白を挟む形へ戻しかねない)
      found.push({ file: job.file, job: job.name, location: uses });
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
  // 中身の解釈は純粋関数へ (合成した Dockerfile で挙動を固定できるようにするため。
  // ファイル入出力と混ぜたままだと、読めない段の扱いを変える変異が拾えない)
  return nodeMajorOfDockerfileText(text);
}

/**
 * Dockerfile の**中身**から node イメージの major を読み取る (ファイル入出力を伴わない)。
 *
 * 揃っていない / 読めない段があれば null を返し、呼び出し側が fail-closed で落とす。
 * 規則そのものの根拠は `readDockerfileNodeMajor` の docstring を参照。
 */
function nodeMajorOfDockerfileText(text: string): number | null {
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
    // **変数で書いた段は「読めない段」として落とす。** `ARG BASE=node:20-alpine` +
    // `FROM $BASE AS tools` は、名前が `node` と一致しないので「別イメージの段」に
    // 見えて黙って飛ばされていた — 残りの段だけで「揃っている」ことになり、
    // **まさに検出したい多段ビルドのドリフトが素通りする** (下の `node:lts-alpine` /
    // ダイジェスト指定を fail-closed にしているのと同じ事情。同じ class の
    // 「読めなさ」を、綴りが `node` で始まるかどうかで 2 通りに扱わない)
    if (image.includes("$")) return null;
    // 公式の node イメージでなければ対象外 (ビルドに使う別イメージの段は見ない)
    if (!isNodeImage(image)) continue;
    // タグから major を取り出す。**最後のパス要素だけを見る** —
    // 参照全体を `:` で割ると `registry.corp.example:5000/node:26` の
    // ポート番号 (5000) を major と読み違える (実測で「Dockerfile=5000」と報告された)
    const lastSegment = image.split("@")[0].split("/").pop() ?? "";
    const tag = lastSegment.split(":")[1] ?? "";
    const major = tag.match(/^(\d+)/);
    // **読めない段は黙って飛ばさない。** `node:lts-alpine` / `node@sha256:...` /
    // タグ無しの `FROM node` は major を取り出せないが、飛ばすと残りの段だけで
    // 「揃っている」ことになり、まさに検出したい多段ビルドのドリフトが素通りする
    // (実測で 3 形すべて全件緑)。読めない段があった時点で「読めなかった」に倒す
    if (!major) return null;
    // 数字で始まるタグだけを採用する
    majors.add(Number(major[1]));
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

/**
 * 走査の**前提**を fail-closed で確かめる (置き場が読める / 読めない 1 本が無い)。
 *
 * **どの検査より先に掛ける。** 前提が崩れたまま個別の検査へ進むと、
 * 置き場の改名・削除・権限や壊れた YAML という**入力側の事故**が、
 * 「setup-node が 1 つも無い」「PR で走るジョブが無い」といった
 * **ワークフローの書き方の問題**という別の顔で報告される (§6 握り潰さない)。
 * とくに読めない 1 本をジョブ 0 件で済ませると、他に正しい `ci.yml` があるかぎり
 * 以降の検査を通過し、**その 1 本だけが黙って検査から外れる** (fail-open)。
 *
 * 走査結果を見る `it` が複数あるので、判定はここ 1 か所に置く (§6 DRY) —
 * 書き写すと、前提の扱いを直したときに片方だけ取り残される。
 */
function expectWorkflowScanUsable(workflows: WorkflowScan): void {
  // 置き場そのものが読めないなら、原因 (errno) を添えて落とす
  expect(
    workflows.listError,
    `${displayPath(WORKFLOWS_DIR)} を読めない: ${String(workflows.listError)}。` +
      "置き場を改名・移動したなら、この検査の走査先も合わせて直すこと。",
  ).toBeNull();
  // 読めない・構造として解釈できないワークフローが 1 本でもあれば落とす
  expect(
    workflows.unreadable,
    `.github/workflows/ に読めない・構造として解釈できないワークフローがある: ${workflows.unreadable.join(" / ")}。` +
      "そのファイルは Node の版を直書きしていても検査をすり抜けるため、前提崩れとして落としている。",
  ).toEqual([]);
}

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
    // 走査の前提 (置き場が読める・読めない 1 本が無い) を先に確かめる
    expectWorkflowScanUsable(workflows);
    // 読めたジョブから Node 準備ステップを集める
    const setupSteps = collectSetupNodeSteps(workflows.jobs);
    // 1 つも無ければ、CI が Node を用意していない (= 検証していない) ので落とす。
    // **soft にする。** hard だとここで中断するので、setup-node を消して
    // `uses: docker://node:20` に置き換えた形 (まさに口が名指ししたい形) で、読み手には
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
    // **キーは大文字小文字を無視して読む** (normalizeInputs)。`Node-Version` と
    // 書いても GitHub は `node-version` として解決するので、区別すると
    // その綴りだけが検査から外れる (実測)。
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
    // (CI の巡が増える)。とくに `uses: docker://` と setup-node の置き方は
    // **同じジョブで同時に成り立つ** (`collectJobsMissingSetupNode` の docstring が
    // 書いているとおり、`docker://hadolint` と `run: npm ci` を併せ持つジョブは
    // 2 つの理由でそれぞれ名指しされる)。hard にすると片方を直すまでもう片方が
    // 表に出ず、docstring が約束している「それぞれの理由で名指しする」挙動が
    // 読み手には見えない
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
        "Node を持ち込まないイメージだと確認できている場合は、この検査自体を直すこと (除外表は置いていない)。",
    ).toEqual([]);
    // **版が入り込む 3 つ目の口**は「書き忘れ」で到達する。ランナーには Node が
    // 最初から入っているので、setup-node を置かないジョブで npm を叩くと
    // ランナー既定の major でスイートが丸ごと走る (上の 2 つは素通りする。実測)。
    // 置いてあっても「リポジトリのコードより後ろ」「if: / continue-on-error 付き」は
    // 同じ結果になるので、位置と効き方まで見る
    const missingSetup = collectJobsMissingSetupNode(workflows.jobs).map(
      (job) => `${job.file}: ${job.job} (${job.reason})`,
    );
    expect.soft(
      missingSetup,
      `このリポジトリのコードを実行するジョブ (run: / ローカル action の呼び出し) には、` +
        `無条件の actions/setup-node をそのコードより前に置くこと。足りていないジョブ: ${missingSetup.join(" / ")}。` +
        "ランナーに最初から入っている Node でそのまま走るため、.nvmrc とは無関係な major で検証している状態になる。" +
        "Node と無関係なジョブや、どうしても置き方に事情があるジョブが現れたら、" +
        "この検査自体を直すこと (除外表は置いていない — 空のまま fail-open を 4 つ抱えていたため外した)。",
    ).toEqual([]);
  });

  it("実行時検証が、絞り込みの無い pull_request で起動するワークフローで走る", () => {
    // 置き場のワークフローの走査結果 (module スコープで 1 度だけ読んだもの)
    const workflows = workflowScan;
    // 走査の前提 (置き場が読める・読めない 1 本が無い) を先に確かめる
    expectWorkflowScanUsable(workflows);
    // 実行時検証を**無条件で**走らせ、かつ**絞り込み無しの pull_request** で
    // 起動するワークフローにあるジョブを集める。
    // ジョブ側の gate (`if:` / `needs:` / `continue-on-error`) は
    // collectJobsMissingSetupNode が落とすので、ここでは見ない (§6 DRY)
    const verifiedOnPullRequest = workflows.jobs
      .filter(
        (job) =>
          triggersOnEveryPullRequest(job.workflowTriggers) &&
          (stepRecordsOf(job) ?? []).some(
            (step) => invokesRuntimeVerifier(step) && isUnconditionalStep(step),
          ),
      )
      .map((job) => `${job.file}: ${job.name}`);
    // 1 つも無ければ、綴りに依存しない最後の砦が**どの PR でも走らない**。
    // ジョブ側の置き方をいくら検査しても、走らなければ何も担保しない
    expect(
      verifiedOnPullRequest,
      `${RUNTIME_VERIFIER} を無条件で走らせるジョブが、絞り込みの無い on: pull_request で` +
        "起動するワークフローに 1 つも無い。" +
        "ジョブ単位の if: / needs: / continue-on-error は別の検査が落とすが、" +
        "その外側にある on: を絞ると、置き方が正しいまま検証がどの PR でも走らなくなる " +
        "(paths-ignore や types: を足した場合は「条件に当たらない PR だけ検証されない」" +
        "という、より見つけにくい同じ穴になる)。" +
        "検証を走らせるワークフローの on: には、値を書かない pull_request: を置くこと。",
    ).not.toEqual([]);
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
    // 名前が node で始まるだけの別物は巻き込まない (Dockerfile の FROM を読むため)
    { image: "myorg/node-tools:1", expected: false, label: "別イメージ" },
    // Node と無関係なイメージ
    { image: "ubuntu:24.04", expected: false, label: "ubuntu" },
    // 社内ミラー (名前空間付き) も node イメージとして拾う — Dockerfile の段に
    // 別 major のミラーを足す形は、まさに検出したいドリフトそのもの
    { image: "registry.corp.example/node:22-alpine", expected: true, label: "社内ミラー" },
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

  // 期待どおりの置き方のステップ列 (checkout → setup-node → 実行時検証 → npm)
  const compliantSteps = [
    { uses: "actions/checkout@v7" },
    { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
    { run: "node scripts/verify-node-major.mjs" },
    { run: "npm ci" },
  ];

  it("collectJobsMissingSetupNode が、置き方の誤りだけを名指しする", () => {
    // 期待どおりの置き方は名指ししない
    const compliant = jobOf({ steps: compliantSteps });
    expect(collectJobsMissingSetupNode([compliant])).toEqual([]);
    // setup-node がリポジトリのコードより後ろにある形は名指しする。
    // **件数だけでなく理由まで固定する** — 件数だけだと、どの判定が拾ったのかが
    // 分からず、「その形を名指しする」と読める一方で実際には別の理由 (この例なら
    // 実行時検証が無いこと) で落ちている、という食い違いに気付けない
    const tooLate = jobOf({ steps: [{ run: "npm ci" }, { uses: "actions/setup-node@v7" }] });
    expect(collectJobsMissingSetupNode([tooLate])).toEqual([
      { file: "synthetic.yml", job: "job", reason: `${RUNTIME_VERIFIER} を実行していない` },
    ]);
    // setup-node を前に出しても、実行時検証がリポジトリのコードより後ろなら名指しする
    const setupBeforeButVerifierLate = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "npm ci" },
        { run: "node scripts/verify-node-major.mjs" },
      ],
    });
    expect(collectJobsMissingSetupNode([setupBeforeButVerifierLate])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason: `${RUNTIME_VERIFIER} がリポジトリのコードより後ろにある (先に走った検証の Node が分からない)`,
      },
    ]);
    // setup-node が無い形も名指しする
    const missing = jobOf({ steps: [{ run: "npm ci" }] });
    expect(collectJobsMissingSetupNode([missing])).toHaveLength(1);
    // 第三者アクションだけのジョブは対象外 (誤検知を出さない)
    const actionsOnly = jobOf({ steps: [{ uses: "actions/labeler@v5" }] });
    expect(collectJobsMissingSetupNode([actionsOnly])).toEqual([]);
    // steps を持たないジョブ (第三者の再利用可能ワークフローの呼び出し) も対象外 —
    // 呼ばれる側はこの走査に含まれないので、条件を付けるなと求める筋が無い
    const reusable = jobOf({ uses: "other-org/repo/.github/workflows/x.yml@v1" });
    expect(collectJobsMissingSetupNode([reusable])).toEqual([]);
    // **ローカルの再利用可能ワークフローを gate 付きで呼ぶ形は名指しする。**
    // 呼ばれる側のジョブは別に検査されるが、呼び出し側がスキップされると
    // その全部が走らないまま CI は緑になる (`needs:` で塞いだのと同じ結末)
    const gatedLocalCall = jobOf({
      if: "${{ false }}",
      uses: "./.github/workflows/suite.yml",
    });
    expect(collectJobsMissingSetupNode([gatedLocalCall])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason: "ジョブに if: が付いている (スキップされても CI は緑になる)",
      },
    ]);
    // 条件の無いローカル呼び出しは通す (置き方は呼ばれる側で見る)
    expect(
      collectJobsMissingSetupNode([jobOf({ uses: "./.github/workflows/suite.yml" })]),
    ).toEqual([]);
    // ジョブ単位の continue-on-error は、失敗しても CI が緑になるので名指しする
    const jobContinues = jobOf({ "continue-on-error": true, steps: compliantSteps });
    expect(collectJobsMissingSetupNode([jobContinues])).toHaveLength(1);
    // 明示的な false は「効かなくても進む書き方」ではないので通す
    const jobStops = jobOf({ "continue-on-error": false, steps: compliantSteps });
    expect(collectJobsMissingSetupNode([jobStops])).toEqual([]);
    // **ジョブ単位の if: も同じ結末**（スキップされてもワークフローは成功で報告される）
    const jobConditional = jobOf({ if: "github.event_name == 'push'", steps: compliantSteps });
    expect(collectJobsMissingSetupNode([jobConditional])).toHaveLength(1);
    // 実行時検証を置いていないジョブも名指しする (宣言として見えない形を何も検証していない)
    const noVerifier = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "npm ci" },
      ],
    });
    expect(collectJobsMissingSetupNode([noVerifier])).toHaveLength(1);
    // **実行時検証より後ろで Node を差し替えうる uses: は名指しする。**
    // 検証はもう終わっているので実行時には見えず、ここで落とさないと
    // lint / test / e2e が別の Node で走ったまま CI が緑になる (実測)
    const swappedAfterVerifier = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "node scripts/verify-node-major.mjs" },
        { uses: "volta-cli/action@v4", with: { "node-version": "20" } },
        { run: "npm ci && npm run test" },
      ],
    });
    expect(collectJobsMissingSetupNode([swappedAfterVerifier])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason:
          `${RUNTIME_VERIFIER} より後ろに Node を差し替えうるステップがある ` +
          "(volta-cli/action@v4)。検証した Node のまま走る保証が無い。" +
          "Node と無関係なステップ (actions/cache 等) なら、検証より前か、" +
          "最後にリポジトリのコードを実行するステップより後ろへ移すこと",
      },
    ]);
    // **最後のリポジトリのコードより後ろの uses: は通す (誤検知を出さない)。**
    // そこに置かれた成果物のアップロード等は、もう誰の Node にも影響しない
    const uploadAfterSuite = jobOf({
      steps: [...compliantSteps, { uses: "actions/upload-artifact@v4" }],
    });
    expect(collectJobsMissingSetupNode([uploadAfterSuite])).toEqual([]);
    // **検証より前に `run:` を置いた形**は「リポジトリのコードより後ろ」として名指しする。
    // 逃げ道 (除外表) は持たないので、この形が要るジョブが現れたらこの検査自体を
    // 直す差分になる — 除外表を置いていた頃は、その鍵が別の検査まで一緒に外していた
    const setupBeforeVerifier = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "corepack enable" },
        { run: "node scripts/verify-node-major.mjs" },
        { run: "npm ci" },
      ],
    });
    expect(collectJobsMissingSetupNode([setupBeforeVerifier])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason: `${RUNTIME_VERIFIER} がリポジトリのコードより後ろにある (先に走った検証の Node が分からない)`,
      },
    ]);
    // **最後のリポジトリのコードがローカル action のときも、差し替えとして見る。**
    // そのステップは「中身を読めない uses:」と「スイートの実行」を兼ねるので、
    // 走査の終端を除いていたときは action.yml の中で Node を入れ替える形が
    // 両方の網から見えなかった (実測で空配列)
    const localActionRunsSuite = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "node scripts/verify-node-major.mjs" },
        { uses: "./.github/actions/run-suite" },
      ],
    });
    expect(collectJobsMissingSetupNode([localActionRunsSuite])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason:
          `${RUNTIME_VERIFIER} より後ろに Node を差し替えうるステップがある ` +
          "(./.github/actions/run-suite)。検証した Node のまま走る保証が無い。" +
          "ローカル action の中身は読めないので、Node を使う処理はジョブ側の run: で行うこと",
      },
    ]);
    // **`needs:` の先から伝播してくるスキップも名指しする。** ゲートジョブが
    // `if:` でスキップされると依存先も連鎖でスキップされ、それでもワークフローは
    // 成功として報告される — 隣の「ジョブ単位の if:」と同じ結末に、別のキーで届く
    // (実測で全件緑のまま通った)
    const gate = { file: "synthetic.yml", name: "gate", definition: { if: "${{ false }}" } };
    const gated = {
      file: "synthetic.yml",
      name: "suite",
      definition: { needs: "gate", steps: compliantSteps },
    };
    expect(collectJobsMissingSetupNode([gate, gated])).toEqual([
      {
        file: "synthetic.yml",
        job: "suite",
        reason:
          "needs: の先に if: 付きのジョブ (gate) がある (そのジョブがスキップされると、このジョブも走らないまま CI は緑になる)",
      },
    ]);
    // 連鎖でもたどる (gate → mid → suite)
    const mid = { file: "synthetic.yml", name: "mid", definition: { needs: ["gate"] } };
    const chained = {
      file: "synthetic.yml",
      name: "suite",
      definition: { needs: ["mid"], steps: compliantSteps },
    };
    expect(collectJobsMissingSetupNode([gate, mid, chained])).toHaveLength(1);
    // 条件の無いジョブへの needs: は伝播しないので通す (誤検知を出さない)
    const plain = { file: "synthetic.yml", name: "build", definition: { steps: compliantSteps } };
    const dependsOnPlain = {
      file: "synthetic.yml",
      name: "suite",
      definition: { needs: "build", steps: compliantSteps },
    };
    expect(collectJobsMissingSetupNode([plain, dependsOnPlain])).toEqual([]);
    // 別のワークフローに同名のジョブがあっても取り違えない
    const otherFileGate = { file: "other.yml", name: "gate", definition: { if: "${{ false }}" } };
    expect(collectJobsMissingSetupNode([otherFileGate, dependsOnPlain, plain])).toEqual(
      [],
    );
    // **ジョブ単位 / ワークフロー単位の `env: PATH:` も名指しする。** そのジョブの
    // 全ステップに効くので、実行時検証のステップだけ step 単位で正しい PATH に
    // 戻す 2 段構えにすると、両方の網が緑のままスイートが別の Node で走る (実測)
    const jobPathEnv = jobOf({ env: { PATH: "/opt/node20/bin:/usr/bin" }, steps: compliantSteps });
    expect(collectJobsMissingSetupNode([jobPathEnv])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason: "ジョブ単位の env: で PATH を宣言している (そのジョブの全ステップの探索パスが変わる)",
      },
    ]);
    // ワークフロー全体の env: も同じ扱い
    const workflowPathEnv = {
      file: "synthetic.yml",
      name: "job",
      definition: { steps: compliantSteps },
      workflowEnv: { PATH: "/opt/node20/bin:/usr/bin" },
    };
    expect(collectJobsMissingSetupNode([workflowPathEnv])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason:
          "ワークフロー単位の env: で PATH を宣言している (そのジョブの全ステップの探索パスが変わる)",
      },
    ]);
    // PATH 以外の env: は通す (誤検知を出さない)
    expect(
      collectJobsMissingSetupNode([jobOf({ env: { CI: "true" }, steps: compliantSteps })]),
    ).toEqual([]);
    // **ステップの `env: PATH:` も差し替えとして名指しする。** `uses:` と同じく
    // 宣言として YAML に現れるので静的に読める — 読まないと、正しい setup-node と
    // 検証を置いたうえで `env:` を添えるだけでスイートが別の Node で走り、
    // 両方の網が緑のままになる (実測)
    const pathEnvAfterVerifier = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "node scripts/verify-node-major.mjs" },
        { run: "npm ci && npm run test", env: { PATH: "/opt/node20/bin:/usr/bin:/bin" } },
      ],
    });
    expect(collectJobsMissingSetupNode([pathEnvAfterVerifier])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason:
          `${RUNTIME_VERIFIER} より後ろに Node を差し替えうるステップがある ` +
          "(env: PATH: の指定)。検証した Node のまま走る保証が無い。" +
          "Node と無関係なステップ (actions/cache 等) なら、検証より前か、" +
          "最後にリポジトリのコードを実行するステップより後ろへ移すこと",
      },
    ]);
    // PATH 以外の env: は差し替えではないので通す (誤検知を出さない)
    const otherEnv = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "node scripts/verify-node-major.mjs" },
        { run: "npm ci", env: { CI: "true" } },
      ],
    });
    expect(collectJobsMissingSetupNode([otherEnv])).toEqual([]);
    // **実行時検証のステップ自身の `env: PATH:` も名指しする。** 差し替えの走査は
    // `verifierIndex + 1` から始まるので、ここを別に見ないと**検証ステップに付けた
    // `env: PATH:` だけがどちらの網からも見えない**。上の「ジョブ / ワークフロー単位」と
    // 向きが逆なだけの同じ 2 段構え: 検証の手前で PATH の先頭を Node 20 にし、
    // 検証ステップにだけ正しい Node を指し直すと、検証は「26 です」と申告して通り、
    // 続く npm ci / lint / test は Node 20 で走る (実測で全件緑)
    const verifierPathEnv = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { uses: "volta-cli/action@v4", with: { "node-version": "20" } },
        {
          run: "node scripts/verify-node-major.mjs",
          env: { PATH: "/opt/hostedtoolcache/node/26.0.0/x64/bin:/usr/bin:/bin" },
        },
        { run: "npm ci && npm run test" },
      ],
    });
    expect(collectJobsMissingSetupNode([verifierPathEnv])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason: `${RUNTIME_VERIFIER} のステップに env: で PATH が宣言されている (検証だけ別の Node を指せる)`,
      },
    ]);
    // 検証ステップの PATH 以外の env: は通す (誤検知を出さない)
    const verifierOtherEnv = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "node scripts/verify-node-major.mjs", env: { CI: "true" } },
        { run: "npm ci" },
      ],
    });
    expect(collectJobsMissingSetupNode([verifierOtherEnv])).toEqual([]);
    // **`container:` の `env: PATH:` も同じ扱い。** コンテナの中で走る全ステップに
    // 効くので、ジョブ / ワークフロー単位だけを塞いでも、同じ 2 段構えが
    // このキー経由でそのまま通る (塞いだつもりの穴が別のキーで開いたままになる)
    const containerPathEnv = jobOf({
      container: { image: "node:26-alpine", env: { PATH: "/opt/node20/bin:/usr/bin" } },
      steps: compliantSteps,
    });
    expect(collectJobsMissingSetupNode([containerPathEnv])).toEqual([
      {
        file: "synthetic.yml",
        job: "job",
        reason: "コンテナ単位の env: で PATH を宣言している (そのジョブの全ステップの探索パスが変わる)",
      },
    ]);
    // `container:` を文字列で書いた形 (`container: node:26-alpine`) は env: を持ちようが
    // 無いので通す。**正しい setup-node と併せた形は正当**なので、ここで落とすと
    // 直しようの無い要求になる (一度実測して取り下げた形)
    expect(
      collectJobsMissingSetupNode([jobOf({ container: "node:26-alpine", steps: compliantSteps })]),
    ).toEqual([]);
    // コンテナの PATH 以外の env: も通す (誤検知を出さない)
    expect(
      collectJobsMissingSetupNode([
        jobOf({ container: { image: "node:26-alpine", env: { CI: "true" } }, steps: compliantSteps }),
      ]),
    ).toEqual([]);
    // 実行時検証が setup-node より前だと、ランナー既定の Node を見る空振りになる
    const verifierTooEarly = jobOf({
      steps: [
        { run: "node scripts/verify-node-major.mjs" },
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "npm ci" },
      ],
    });
    expect(collectJobsMissingSetupNode([verifierTooEarly])).toHaveLength(1);
    // パスに触れているだけの run: は「実行している」と認めない
    const mentionsOnly = jobOf({
      steps: [
        { uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } },
        { run: "echo 'skipping scripts/verify-node-major.mjs for now'" },
        { run: "npm ci" },
      ],
    });
    expect(collectJobsMissingSetupNode([mentionsOnly])).toHaveLength(1);
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

  it.each([
    // 素のステップは必ず効く
    { step: { run: "node scripts/verify-node-major.mjs" }, expected: true, label: "素の run:" },
    // if: が付くと実行されない可能性がある
    { step: { run: "x", if: "${{ false }}" }, expected: false, label: "if: 付き" },
    // continue-on-error は失敗しても後続が走る
    { step: { run: "x", "continue-on-error": true }, expected: false, label: "continue-on-error" },
    // 明示的な false は「効かない書き方」ではない
    { step: { run: "x", "continue-on-error": false }, expected: true, label: "明示的な false" },
  ])("isUnconditionalStep: $label → $expected", ({ step, expected }) => {
    // 実行時検証のステップにも同じ判定を掛けているので、ここで中身を固定する
    expect(isUnconditionalStep(step)).toBe(expected);
  });

  it("docker:// と run: を両方持つジョブは、2 つの検査がそれぞれ名指しする", () => {
    // `docker://` のステップと `run: npm ci` を両方持つジョブ
    const mixed = jobOf({
      steps: [{ uses: "docker://hadolint/hadolint:latest" }, { run: "npm ci && npm run test" }],
    });
    // イメージ側は「ステップを丸ごとイメージの中で走らせている」ことを名指しする
    expect(collectImageOnlySteps([mixed])).toEqual([
      { file: "synthetic.yml", job: "job", location: "docker://hadolint/hadolint:latest" },
    ]);
    // setup-node 側も、重複除けを渡さなければ同じジョブを名指しする
    expect(collectJobsMissingSetupNode([mixed])).toEqual([
      { file: "synthetic.yml", job: "job", reason: "setup-node が無い" },
    ]);
    // **イメージだけのジョブは、setup-node 側が二重に名指しすることはない。**
    // `run:` もローカル action も無いので `firstRepoCode === -1` で素通りする —
    // 重複除けを持たなくても二重報告にならないのはこのため
    const imageOnly = jobOf({ steps: [{ uses: "docker://node:20" }] });
    expect(collectImageOnlySteps([imageOnly])).toHaveLength(1);
    expect(collectJobsMissingSetupNode([imageOnly])).toEqual([]);
  });

  it("collectSetupNodeSteps が、with: のキーを大文字小文字を無視して読む", () => {
    // GitHub はアクションの入力名を大文字小文字を無視して解決するので、
    // `Node-Version` と書いても setup-node は `node-version` として受け取り
    // Node 20 を入れる。区別するとこの綴りだけが検査から外れる (実測で全件緑)
    const cased = jobOf({
      steps: [
        {
          uses: "actions/setup-node@v7",
          with: { "Node-Version": "20", "NODE-VERSION-FILE": ".nvmrc" },
        },
      ],
    });
    // 取り出した with: は、キーが小文字にそろっている
    expect(collectSetupNodeSteps([cased])[0]?.inputs).toEqual({
      "node-version": "20",
      "node-version-file": ".nvmrc",
    });
    // 素の綴りはそのまま読める (誤検知を出さない)
    const plain = jobOf({
      steps: [{ uses: "actions/setup-node@v7", with: { "node-version-file": ".nvmrc" } }],
    });
    expect(collectSetupNodeSteps([plain])[0]?.inputs).toEqual({ "node-version-file": ".nvmrc" });
  });

  it("readDockerfileNodeMajor が、変数で書いた FROM を読めない段として落とす", () => {
    // 実在の Dockerfile は読める (誤検知を出さない)
    expect(readDockerfileNodeMajor()).not.toBeNull();
    // **変数の段は「別イメージ」ではなく「読めない段」**。黙って飛ばすと、
    // 残りの段だけで揃っていることになり多段ビルドのドリフトを見逃す
    expect(nodeMajorOfDockerfileText("FROM node:26-alpine\nFROM $BASE AS tools\n")).toBeNull();
    // 変数を使わない多段ビルドは、揃っていれば読める
    expect(nodeMajorOfDockerfileText("FROM node:26-alpine\nFROM node:26 AS tools\n")).toBe(26);
    // 段ごとに major が違えば読めない扱い (揃っていないことを呼び出し側が落とす)
    expect(nodeMajorOfDockerfileText("FROM node:26-alpine\nFROM node:20 AS tools\n")).toBeNull();
    // Node と無関係な段は飛ばす (誤検知を出さない)
    expect(nodeMajorOfDockerfileText("FROM golang:1.22 AS build\nFROM node:26-alpine\n")).toBe(26);
  });

  it.each([
    // 値を書かない `pull_request:` が「絞り込み無し」= 全 PR で走る
    { triggers: { pull_request: null }, expected: true, label: "pull_request: (値なし)" },
    // 空の対応表も同じ意味
    { triggers: { pull_request: {} }, expected: true, label: "pull_request: {}" },
    // push と併記していても、pull_request が絞り込み無しなら通す
    {
      triggers: { push: { branches: ["main"] }, pull_request: null },
      expected: true,
      label: "push と併記",
    },
    // pull_request が無ければ PR では 1 度も走らない
    { triggers: { workflow_dispatch: null }, expected: false, label: "workflow_dispatch だけ" },
    // paths-ignore は「その条件に当たらない PR だけ検証されない」という同じ穴になる
    {
      triggers: { pull_request: { "paths-ignore": ["**.md"] } },
      expected: false,
      label: "paths-ignore 付き",
    },
    // types: を絞ると、対象外のイベントで走らなくなる
    { triggers: { pull_request: { types: ["opened"] } }, expected: false, label: "types: 付き" },
    // branches で基底ブランチを絞る形も、外れた PR が検証されない
    {
      triggers: { pull_request: { branches: ["main"] } },
      expected: false,
      label: "branches 付き",
    },
    // 対応表として読めない形は通さない (fail-closed)
    { triggers: ["pull_request"], expected: false, label: "イベント名の配列" },
    { triggers: "pull_request", expected: false, label: "文字列" },
    { triggers: undefined, expected: false, label: "on: が無い" },
  ])("triggersOnEveryPullRequest: $label → $expected", ({ triggers, expected }) => {
    // 合成した on: を判定へ渡し、期待どおりの真偽を返すことを固定する
    expect(triggersOnEveryPullRequest(triggers)).toBe(expected);
  });

  it("jobsOfWorkflow が、ワークフロー全体の env: をジョブへ運ぶ", () => {
    // **運ぶ配線そのものを固定する。** 運び先の判定にはテストがあるのに、
    // 運ぶ側が無検証だと「全体の env を読まない」変異が全件緑で通る (実測)
    const extracted = jobsOfWorkflow("synthetic.yml", {
      env: { PATH: "/opt/node20/bin:/usr/bin" },
      jobs: { build: { steps: [{ run: "npm ci" }] } },
    });
    // 読めない箇所は無い
    expect(extracted.problems).toEqual([]);
    // ジョブ 1 つに、全体の env がそのまま付いている
    expect(extracted.jobs).toHaveLength(1);
    expect(extracted.jobs[0]?.workflowEnv).toEqual({ PATH: "/opt/node20/bin:/usr/bin" });
    // 全体の env が無いワークフローでは undefined のまま (誤検知を出さない)
    const noEnv = jobsOfWorkflow("synthetic.yml", { jobs: { build: { steps: [] } } });
    expect(noEnv.jobs[0]?.workflowEnv).toBeUndefined();
    // **`on:` も同じく運ぶ。** 運び先 (triggersOnEveryPullRequest) の判定には
    // テストがあるが、運ぶ配線が無検証だと「on: を読まない」変異が全件緑で通る —
    // env で実測した穴とまったく同じ形なので、同じ場所で固定する
    const withTriggers = jobsOfWorkflow("synthetic.yml", {
      on: { pull_request: null },
      jobs: { build: { steps: [{ run: "npm ci" }] } },
    });
    expect(withTriggers.jobs[0]?.workflowTriggers).toEqual({ pull_request: null });
    // YAML 1.1 のパーサが裸の `on` を真偽値として読んだ場合 (キーが `true`) も拾う
    const booleanKey = jobsOfWorkflow("synthetic.yml", {
      true: { pull_request: null },
      jobs: { build: { steps: [{ run: "npm ci" }] } },
    });
    expect(booleanKey.jobs[0]?.workflowTriggers).toEqual({ pull_request: null });
    // 読めない形は 3 段それぞれで原因を返す
    expect(jobsOfWorkflow("x.yml", { jobs: "extra" }).problems).toHaveLength(1);
    expect(jobsOfWorkflow("x.yml", { jobs: { a: [] } }).problems).toHaveLength(1);
    expect(jobsOfWorkflow("x.yml", { jobs: { a: { steps: "npm ci" } } }).problems).toHaveLength(1);
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

// **実行時検証スクリプトそのものの挙動を固定する。**
//
// なぜ要るか: この PR は「宣言として YAML に現れる Node しか静的には見えない」という
// 理由で、担保の中心を静的解析から `scripts/verify-node-major.mjs` の 1 ステップへ
// 移している。ところが上の検出網が照合しているのは **`run:` にその起動行があるか**
// (`invokesRuntimeVerifier`) という**配線だけ**で、スクリプトの中身は一度も走らない。
// つまり中身を `console.log("ok")` だけに潰しても**全件緑のまま通り、CI も緑になる**
// (実測。235 件すべて成功・`node scripts/verify-node-major.mjs` の終了コードも 0)。
// 担保の置き場所を移した先が無検証だと、検出網の中心が空洞になる。
//
// これは新しい教訓ではなく、このリポジトリが Stripe の API 版ガードで既に踏んで
// 学んでいる形そのもの (CLAUDE.md: 静的な検査は「呼び出しが配線されているか」を
// 名前で照合するだけなので、実行時チェックの挙動を別途固定しないと
// **中身を空にしても全テストが緑のまま通る**)。同じ対処をここにも置く。
//
// 判定は**本物のスクリプトを別プロセスで起動して**行う。中身を読んで真似ると、
// 「テストの中の写し」が緑になるだけでスクリプト本体の退行を拾えない。
describe("実行時検証スクリプトそのものの挙動", () => {
  // スクリプト本体の絶対パス (起動するのは常にこの**実物**)
  const verifierPath = resolve(REPO_ROOT, RUNTIME_VERIFIER);
  // 「`.nvmrc` の形が読めない」ときにスクリプトが出す文言の目印。
  // 「major が違う」との**理由の違い**を区別するために使う (下の書式一致の検査)
  const FORMAT_ERROR_MARKER = ".nvmrc は major だけを書くこと";

  /** スクリプトを 1 回起動した結果 (終了コードと、人向けの出力)。 */
  interface VerifierRun {
    // 終了コード (シグナルで落ちた場合は null)
    status: number | null;
    // 成功時の記録と失敗時の理由を、まとめて 1 つの文字列として見る
    output: string;
  }

  /**
   * 使い捨ての作業場に**本物のスクリプトを複写**し、`.nvmrc` を差し替えて起動する。
   *
   * スクリプトは `.nvmrc` を**自分のファイル位置からの相対**で探す (実行時の cwd に
   * 依存させない設計) ので、中身を差し替えるには同じ配置の作業場が要る。
   * 複写するのは実物のバイト列なので、本体を潰せばこの検査が落ちる。
   *
   * @param nvmrcContent 作業場に置く `.nvmrc` の中身。`null` ならファイルを置かない
   *                     (削除・改名の事故を再現する)
   */
  function runVerifier(nvmrcContent: string | null): VerifierRun {
    // OS の一時領域に、この検査専用の作業場を作る (名前が衝突しないよう mkdtemp)
    // **名前にわざと空白を入れる。** スクリプトは失敗文言から自分の絶対パスを削るが、
    // 目印の作り方を `URL.pathname` に戻すと百分率エンコード (`my%20app`) になって
    // 一致しなくなり、**出さないと書いた絶対パスがそのまま漏れる** (実測)。
    // 空白を含む作業場で走らせておけば、その退行を下の検査が捕まえる
    const sandbox = mkdtempSync(join(tmpdir(), "verify node major "));
    try {
      // 実物と同じ `scripts/` の下に置く (スクリプトは `../.nvmrc` を見るため)
      mkdirSync(join(sandbox, "scripts"));
      // 本物のスクリプトをそのまま複写する (中身を真似ない = 退行を拾える)
      copyFileSync(verifierPath, join(sandbox, "scripts", "verify-node-major.mjs"));
      // 中身が指定されていれば `.nvmrc` を置く (null のときは置かない)
      if (nvmrcContent !== null) writeFileSync(join(sandbox, ".nvmrc"), nvmrcContent);
      // いま走っている Node と同じ実行ファイルで起動する
      // (テストを走らせている Node の major が、そのまま「実際に走っている Node」になる)
      const result = spawnSync(process.execPath, [join(sandbox, "scripts", "verify-node-major.mjs")], {
        // 出力を文字列として受け取る
        encoding: "utf8",
      });
      // **起動そのものに失敗した場合を握り潰さない (§6)。** spawnSync は EAGAIN /
      // ENOMEM / EACCES のとき `{status: null, error, stdout: null}` を返すので、
      // そのまま返すと「出力が空のまま落ちた」= スクリプトの不具合という
      // 別の顔で報告され、本当の原因 (errno) が消える
      if (result.error !== undefined) {
        return { status: result.status, output: `スクリプトを起動できない: ${result.error.message}` };
      }
      // 成否の理由は stdout / stderr のどちらにも出うるので、まとめて 1 つの文字列で見る
      return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    } finally {
      // 作業場は必ず片付ける (§8 リソースを確実に解放する)
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // いま走っている Node の major (文字列。`.nvmrc` に書く形にそろえる)
  const runningMajor = process.versions.node.split(".")[0];
  // わざと 1 つずらした major (「違えば落ちる」ことを確かめるため)
  const otherMajor = String(Number(runningMajor) + 1);

  it("走っている Node と同じ major なら成功する (v 付きも同じ扱い)", () => {
    // 素の数字で一致する場合
    const plain = runVerifier(runningMajor);
    // 終了コード 0 で通る
    expect(plain.status, `同じ major なのに落ちた: ${plain.output}`).toBe(0);
    // 「検証された」と分かる記録を残す設計なので、版が出ていることも見る
    expect(plain.output).toContain(process.versions.node);
    // `v26` の書き方も `.nvmrc` の慣習として許す
    expect(runVerifier(`v${runningMajor}`).status).toBe(0);
    // 前後の空白・末尾改行は落として読む (エディタが付けるため)
    expect(runVerifier(`  ${runningMajor}\n`).status).toBe(0);
  });

  it("major が違えば落ち、どちらがどうずれているかを出す", () => {
    // 走っている Node とは違う major を書いた場合
    const run = runVerifier(otherMajor);
    // **ここが担保の本体**: 食い違いは終了コード 1 で CI を止める
    expect(run.status, `major が違うのに通った: ${run.output}`).toBe(1);
    // 直す先が分かるよう、実際の Node と `.nvmrc` の値の両方を出す。
    // **`.nvmrc` 側は素の数字で照合しない** — 例えば Node 22.23.0 で走ると
    // otherMajor は "23" で、これは版の文字列 "22.23.0" の**部分文字列**なので、
    // `.nvmrc` の値を文言から落とす退行が起きても両方の検査が通ってしまう
    expect(run.output).toContain(process.versions.node);
    expect(run.output).toContain(`.nvmrc (${otherMajor})`);
  });

  it("`.nvmrc` の形が読めなければ、検証せずに落ちる (fail-closed)", () => {
    // 読めない書き方を並べる (小数点付き・コメント付き・空・数字でない)
    for (const content of [`${runningMajor}.1.0`, `${runningMajor} # LTS`, "", "lts/iron"]) {
      // 1 件ずつ起動して結果を見る
      const run = runVerifier(content);
      // 比較の土台が無いまま通すと、この検査があること自体が誤った安心になる
      expect(run.status, `読めない .nvmrc (${JSON.stringify(content)}) が通った`).toBe(1);
      // 何が入っていたかを添えているので、直す先が分かる
      expect(run.output).toContain(FORMAT_ERROR_MARKER);
    }
  });

  it("`.nvmrc` が無ければ落ち、実行機の絶対パスを出さない", () => {
    // ファイルを置かずに起動する (削除・改名・権限の事故を再現)
    const run = runVerifier(null);
    // 読めないまま通さない
    expect(run.status, `.nvmrc が無いのに通った: ${run.output}`).toBe(1);
    // 素の例外ではなく、こちらが書いた文言で落ちていること
    expect(run.output).toContain(".nvmrc");
    // **絶対パスを載せない** (CI と手元で文言をそろえる設計。検査側の
    // describeReadError と同じ扱いで、出力は相対の綴りだけになる)
    expect(run.output, `実行機の絶対パスが出力に混ざっている: ${run.output}`).not.toContain(
      tmpdir(),
    );
  });

  it("`.nvmrc` の書式解釈が、検査側と実行時検証で一致している", () => {
    // **同じ `.nvmrc` を読む手が 2 つある。** 検査側 (parseNvmrcMajor) と
    // スクリプト側で解釈が割れると、「片方が緑でもう片方が赤」という一番たちの悪い
    // 食い違いになる (例: `26 # LTS` を検査側だけが 26 と読むと、検査は緑なのに
    // CI の Node 準備が壊れる)。スクリプトは `npm ci` より前・依存ゼロで走るため
    // このモジュールを import できず、規則は構造上 2 か所に現れる。
    // 消せない写しなので、**答え合わせを機械的に固定する**
    const candidates = [
      runningMajor,
      `v${runningMajor}`,
      `  ${runningMajor}  `,
      `${runningMajor}.1.0`,
      `${runningMajor} # LTS`,
      "",
      "lts/iron",
      "v",
      `${runningMajor}abc`,
      // **0 埋め**。以前は両方とも「読める」と答えるのに値の解釈が割れていた (実測)。
      // いまは両方とも受け取らない — 本物の読み手 (`actions/setup-node`) が
      // `026` を解決できないため、そこにそろえてある
      `0${runningMajor}`,
    ];
    // 1 つずつ、両方の読み手に同じ文字列を食わせる
    for (const content of candidates) {
      // 検査側が取り出した major (読めなければ null)
      const parsedHere = parseNvmrcMajor(content);
      // スクリプトを実際に走らせた結果
      const run = runVerifier(content);
      // **「読めるか」だけでなく「取り出した値」まで突き合わせる。**
      // 読めるかだけを比べていたときは、`022` のような 0 埋めで
      // 検査側 (Number で 22) とスクリプト側 (文字列 "022") の答えが割れるのに
      // **両方とも「読める」なので検査が通った** (実測)。走っている Node と
      // 同じ major を指す内容なら、スクリプトは成功しなければならない
      const shouldPass = parsedHere === Number(runningMajor);
      // 書式が読めない場合は、スクリプト側も書式の文言で落ちること
      if (parsedHere === null) {
        expect(
          run.output,
          `.nvmrc の書式解釈が割れている (${JSON.stringify(content)}): ` +
            `検査側は読めないと判断したが、${RUNTIME_VERIFIER} は別の理由で扱った。`,
        ).toContain(FORMAT_ERROR_MARKER);
      }
      // 成否そのものを突き合わせる (値の割れはここで落ちる)
      expect(
        run.status === 0,
        `.nvmrc の解釈が割れている (${JSON.stringify(content)}): ` +
          `検査側は ${JSON.stringify(parsedHere)} と読み、走っている Node は ${runningMajor}。` +
          `よって ${shouldPass ? "成功" : "失敗"} のはずだが、${RUNTIME_VERIFIER} は ` +
          `${run.status === 0 ? "成功" : "失敗"} した: ${run.output.trim()}`,
      ).toBe(shouldPass);
    }
  });
});
