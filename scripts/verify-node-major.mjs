// 実際に走っている Node の major が `.nvmrc` と同じかを、**その Node 自身に**確かめさせる。
//
// なぜ要るか:
//   `tests/node-runtime-alignment.test.ts` の (a') はワークフローの YAML を静的に読むので、
//   「宣言として書かれた Node」までしか見えない。`run:` の中で `volta` / `nvm` / `asdf` を
//   走らせる形、値が式のとき (`container: ${{ matrix.image }}`)、他リポジトリの再利用可能
//   ワークフロー、composite action の中身は原理的に見えず、綴りを 1 つ塞ぐたびに次の抜け道が
//   出てくる (この repo が CSP の静的解析と Stripe の API 版で 2 度踏んだ形)。
//   ここは**綴りに依存しない** — この行を走らせる Node が自分の版を申告するので、
//   どう用意されたかに関係なく食い違いが分かる。
//
// **覆える範囲を正確に書いておく (時間の向きが要点)。** この検証が申告できるのは
//   **自分が走った時点の** Node だけ。したがって覆えるのは「この行より**前**に
//   行われた、ジョブ全体に効く入れ替え」までで、具体的には `setup-node` の指定・
//   それ以前の `$GITHUB_PATH` への追記・ツールキャッシュの差し替え・コンテナイメージ。
//
//   **覆えないものが 2 つある。**
//   (1) **同じ `run:` の中だけで完結する入れ替え** (`. nvm.sh && nvm use 20 && npm test`)
//       — `run:` ごとにシェルが新しくなるので、別ステップのこの検証からは観測できない。
//   (2) **この検証より後ろのステップが行う入れ替え** — 検証はもう終わっているので
//       見えない。とくに後続の `run:` による `echo … >> $GITHUB_PATH` は、
//       静的な検出網からも中身を解釈しない限り区別できない (実測で全件緑)。
//       後続の `uses:` (`volta-cli/action` 等)・ステップの `env: PATH:`・独自の `shell:`
//       のほうは、実行時には見えないが**静的な検出網が落とす**
//       (実測でいずれも素通りしていたため塞いだ)。
//   どちらも**残る境界**としてレビューで見るしかない。
//   静的な検出網は「新しいジョブが増えたことに気付く」ための網として残す。

// `.nvmrc` を読むため
import { readFileSync } from "node:fs";
// `file:` URL をこの OS のパス表記へ直すため (百分率エンコードを解く。理由は下記)
import { fileURLToPath } from "node:url";

// このスクリプトが置かれているリポジトリの root (末尾のスラッシュ込み)。
// 失敗文言から実行機の絶対パスを削るときの目印に使う
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * 理由を stderr へ出し、終了コードを 1 にする (fail-closed)。
 *
 * **`process.exit` を呼ばない。** あれは保留中の非同期書き込みを待たないため、
 * stderr がパイプ (このスクリプトを別プロセスとして起動する検査や、CI のログ収集が
 * まさにこれ) のときは診断が丸ごと落ちうる — 「終了コード 1 だが理由が分からない」
 * という、この関数がいちばん避けたい状態になる。`process.exitCode` を立てて
 * 素直に処理を終えれば、Node が終了前に stderr を流し切るので同じ保証が得られる。
 * 以前はここで `process.exit` を呼んでいたため、部分書き込みの再試行ループ・
 * EAGAIN の退避・UTF-8 の継続バイトの読み飛ばしを自前で抱えていたが、
 * 呼ぶのをやめた時点でどれも要らなくなった (§6 デッドコードを残さない)。
 *
 * **実行機の絶対パスは載せない** — 検査側が describeReadError で畳んでいるのと
 * 同じ理由 (CI と手元で文言をそろえる)。削るのに `URL.pathname` を使わないこと:
 * あちらは百分率エンコードされた綴り (`/tmp/my%20app/`) を返すので、パスに空白・
 * 非 ASCII・`#` が含まれると目印が一致せず、**出さないと書いた絶対パスがそのまま漏れる**
 * (実測)。`fileURLToPath` はこの OS のパス表記へ直すので一致する。
 */
function fail(message) {
  // 目印 (リポジトリの絶対パス) を取り除いてから 1 行で出す
  console.error(message.split(repoRoot).join(""));
  // 比較の土台が無い / 食い違っている状態で通さない
  process.exitCode = 1;
}

/**
 * `.nvmrc` を読み、いま走っている Node の major と突き合わせる。
 *
 * **`fail` のあとは必ず `return` する。** `process.exit` に処理の中断を任せていた
 * 頃と違い、いまは呼び出しが戻ってくるので、読めなかった値をそのまま使わないよう
 * 自分で止める必要がある。
 */
function main() {
  // `.nvmrc` の場所 (このスクリプトからの相対で決めるので、実行時の cwd に依存しない)
  const nvmrcUrl = new URL("../.nvmrc", import.meta.url);
  // 読み取った中身 (前後の空白を落としたもの)
  let declared;
  // 読み取りの失敗 (削除・改名・権限) を素の例外にしない。
  // **例外のまま落とすと、丁寧に書いたメッセージの代わりにスタックトレースだけが残る**
  // (この repo が readParsed で避けている形)
  try {
    // ファイルの中身を読み、前後の空白だけを落とす
    declared = readFileSync(nvmrcUrl, "utf8").trim();
  } catch (error) {
    // 何が起きたかを 1 行で伝える (絶対パスの除去は `fail` に任せる)
    const detail = error instanceof Error ? error.message : String(error);
    // 理由を出して終える (読めていない値は使わない)
    fail(`.nvmrc を読めない: ${detail}`);
    return;
  }
  // **このリポジトリの `.nvmrc` は「major だけ」を書く運用**なので、`v26` / `26` だけを許す。
  // `26.1.0` や `26 # LTS` を許さないのは、テスト側の readNvmrcMajor と**まったく同じ規則**に
  // そろえるため — 2 つの読み手が別々の書式を許すと、片方が緑でもう片方が赤という
  // 食い違いが起きる (この repo が写しを嫌う理由そのもの。実測で `26.1.0` が割れていた)。
  // **0 埋め (`026`) は受け取らない** — `actions/setup-node` が解決できない綴りなので、
  // ここで通すと「2 つの読み手は一致しているのに本物の読み手だけが落ちる」形になる
  const matched = declared.match(/^v?(0|[1-9]\d*)$/);
  // 形が合わなければ、比較の土台が無いので落とす (fail-closed)
  if (matched === null) {
    // 何が入っていたかを添えて、直す先が分かるようにする
    fail(`.nvmrc は major だけを書くこと (v26 / 26)。実際の中身: ${JSON.stringify(declared)}`);
    return;
  }
  // **数値として比べる。** 上の正規表現が 0 埋め (`026`) を弾くので、いまは文字列で
  // 比べても同じ結果になる — つまり**この行の正しさは上のパターンに依存している**。
  // 0 埋めを許す向きにパターンを緩めると (あるいは `26.1.0` のような形を通すと)、
  // 文字列比較は検査側 (`parseNvmrcMajor` は `Number()` を通す) と答えが割れ、
  // **静的な検査は全件緑なのに CI のこのステップだけが落ちる**という、
  // 2 つの読み手を持つことで起きる一番たちの悪い食い違いになる (実測)。
  // 数値で比べておけば、パターンを緩めてもこの割れ方だけは起きない
  const wantedMajor = Number(matched[1]);
  // いま動いている Node の major (`process.versions.node` は "26.1.0" の形)
  const actualMajor = Number(process.versions.node.split(".")[0]);
  // major が食い違っていれば、どちらがどうずれているかを出して落とす
  if (wantedMajor !== actualMajor) {
    // **「CI が」と決め打ちしない。** このスクリプトは CLAUDE.md §2 で手元のコマンドとしても
    // 案内しており、手元で走らせた人に「CI が走っている Node」と言ったうえで setup-node を
    // 直せと案内すると、直す先そのものが間違っている (手元での直し方は `nvm use`)
    fail(
      `いま走っている Node (${process.versions.node}) の major が .nvmrc (${declared}) と違う。` +
        "手元なら nvm use などで .nvmrc の major に合わせること。CI なら setup-node に " +
        "node-version-file: '.nvmrc' を渡しているか、run: の中で Node を入れ替えていないかを確認すること。",
    );
    return;
  }
  // 一致していることを記録に残す (ログを見た人が「検証されている」と分かるように)
  console.log(`Node ${process.versions.node} は .nvmrc (${declared}) と同じ major です`);
}

// 検証を実行する (失敗は process.exitCode に現れる)
main();
