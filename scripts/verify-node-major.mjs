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
//       後続の `uses:` (`volta-cli/action` 等) のほうは、実行時には見えないが
//       **静的な検出網が落とす** (実測でこの形は素通りしていたため塞いだ)。
//   どちらも**残る境界**としてレビューで見るしかない。
//   静的な検出網は「新しいジョブが増えたことに気付く」ための網として残す。
// `.nvmrc` を読むため。**書き出しは writeSync を使う** — 理由は下の `fail` を参照
import { readFileSync, writeSync } from "node:fs";
// `file:` URL をこの OS のパス表記へ直すため (百分率エンコードを解く。理由は `fail` の下)
import { fileURLToPath } from "node:url";

// このスクリプトが置かれているリポジトリの root (末尾のスラッシュ込み)。
// 失敗文言から実行機の絶対パスを削るときの目印に使う
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * 理由を stderr へ出して、検証できないまま通さずに止める (fail-closed)。
 *
 * **`console.error` ではなく `writeSync` を使う。** `process.exit` は保留中の非同期
 * 書き込みを待たないので、stderr がパイプ (このスクリプトを別プロセスとして起動する
 * 検査や、CI のログ収集がまさにこれ) のときは `console.error` の内容が**丸ごと落ちうる**。
 * 落ちると、唯一の診断が消えて「終了コード 1 だが理由が分からない」状態になる。
 * 同期書き込みにすれば、どの OS でも文言が必ず残る。
 *
 * **実行機の絶対パスは載せない** — 検査側が describeReadError で畳んでいるのと
 * 同じ理由 (CI と手元で文言をそろえる)。削るのに `URL.pathname` を使わないこと:
 * あちらは百分率エンコードされた綴り (`/tmp/my%20app/`) を返すので、パスに空白・
 * 非 ASCII・`#` が含まれると目印が一致せず、**出さないと書いた絶対パスがそのまま漏れる**
 * (実測)。`fileURLToPath` はこの OS のパス表記へ直すので一致する。
 */
function fail(message) {
  // 目印 (リポジトリの絶対パス) を取り除いた、実際に出す 1 行
  const line = `${message.split(repoRoot).join("")}\n`;
  // 書き終えたバイト数 (catch が「残り」だけを出せるよう try の外で持つ)
  let written = 0;
  // 書き出すバイト列 (同上)
  let payload = Buffer.alloc(0);
  try {
    // **書けた分を数えて、全部書けるまで繰り返す。** stderr がノンブロッキングな
    // パイプ (CI のログ収集がこの形) でバッファに空きが足りないと、write(2) は
    // 例外ではなく**要求より小さいバイト数**を返す (部分書き込み)。戻り値を捨てると
    // 次の行の process.exit が残りを道連れにして、`CI が走っている Node (26.1.0) の
    // major が .nvm` のように文が途中で切れた状態で終了コード 1 になる —
    // この関数がまさに避けようとしている「終了コード 1 だが理由が分からない」状態。
    // バイト列にしてから進めるのは、文字数で数えるとマルチバイト (この文言は日本語)
    // で位置がずれるため
    payload = Buffer.from(line, "utf8");
    // 全部書けるまで、書けた分だけ先へ進める
    while (written < payload.length) {
      // 残りを書き、実際に書けたバイト数を受け取る
      const wrote = writeSync(2, payload, written, payload.length - written);
      // 1 バイトも進まないなら、これ以上待っても終わらないので抜ける (無限ループ防止)
      if (wrote <= 0) break;
      // 書けた分だけ位置を進める
      written += wrote;
    }
  } catch {
    // **書き込み自体が失敗しても文言を捨てない。** stderr がノンブロッキングな
    // パイプ (CI のログ収集がこの形) でバッファが満杯だと writeSync は EAGAIN を
    // 投げる。そのまま抜けると、丁寧に書いた理由の代わりに素のスタックトレースが
    // 残る — この関数がまさに避けようとしている「終了コード 1 だが理由が分からない」
    // 状態そのもの。最後の手段として console.error へ落とす (非同期なので届かない
    // ことはありうるが、握り潰すよりは残る見込みがある。§6 エラーを握り潰さない)。
    // **まだ書けていない分だけを出す。** 行を丸ごと出し直すと、部分書き込みで
    // 既に流れた先頭が二重になり (`…の majorCI が走っている Node …`)、
    // この関数がまさに避けようとしている「読めない診断」を自分で作ることになる
    console.error(payload.subarray(written).toString("utf8").trimEnd());
  }
  // 比較の土台が無い / 食い違っている状態で通さない
  process.exit(1);
}

// `.nvmrc` の場所 (このスクリプトからの相対で決めるので、実行時の cwd に依存しない)
const nvmrcUrl = new URL("../.nvmrc", import.meta.url);

// 読み取りの失敗 (削除・改名・権限) を素の例外にしない。
// **例外のまま落とすと、丁寧に書いたメッセージの代わりにスタックトレースだけが残る**
// (この repo が readParsed で避けている形)。終了コードは同じく 1 で fail-closed
let declared;
try {
  // ファイルの中身を読み、前後の空白だけを落とす
  declared = readFileSync(nvmrcUrl, "utf8").trim();
} catch (error) {
  // 何が起きたかを 1 行で伝える。**実行機の絶対パスは載せない** —
  // 検査側が describeReadError で畳んでいるのと同じ理由 (CI と手元で文言をそろえる)
  const detail = error instanceof Error ? error.message : String(error);
  // 絶対パスの除去と終了は `fail` に任せる (3 か所で同じ扱いにそろえる)
  fail(`.nvmrc を読めない: ${detail}`);
}
// **このリポジトリの `.nvmrc` は「major だけ」を書く運用**なので、`v26` / `26` だけを許す。
// `26.1.0` や `26 # LTS` を許さないのは、テスト側の readNvmrcMajor と**まったく同じ規則**に
// そろえるため — 2 つの読み手が別々の書式を許すと、片方が緑でもう片方が赤という
// 食い違いが起きる (この repo が写しを嫌う理由そのもの。実測で `26.1.0` が割れていた)
const matched = declared.match(/^v?(\d+)$/);
// 形が合わなければ、比較の土台が無いので落とす (fail-closed)
if (matched === null) {
  // 何が入っていたかを添えて、直す先が分かるようにする
  // 検証できない状態で通すと、この検査があること自体が誤った安心になる
  fail(`.nvmrc は major だけを書くこと (v26 / 26)。実際の中身: ${JSON.stringify(declared)}`);
}
// ここから先は major を取り出せている。
// **数値として比べる。** 文字列のまま比べると、`.nvmrc` が `026` のような 0 埋めの
// ときに検査側 (`parseNvmrcMajor` は `Number()` を通す) と答えが割れ、
// **静的な検査は全件緑なのに CI のこのステップだけが落ちる**という、
// 2 つの読み手を持つことで起きる一番たちの悪い食い違いになる (実測)
const wantedMajor = Number(matched[1]);
// いま動いている Node の major (`process.versions.node` は "26.1.0" の形)
const actualMajor = Number(process.versions.node.split(".")[0]);

// major が食い違っていれば、どちらがどうずれているかを出して落とす
if (wantedMajor !== actualMajor) {
  // 「どの Node で走っているか」と「どの Node を指定したか」を両方出す
  // 検証していない Node でスイートを走らせないため、ここで止める
  fail(
    `CI が走っている Node (${process.versions.node}) の major が .nvmrc (${declared}) と違う。` +
      "setup-node に node-version-file: '.nvmrc' を渡しているか、run: の中で Node を" +
      "入れ替えていないかを確認すること。",
  );
}

// 一致していることを記録に残す (ログを見た人が「検証されている」と分かるように)
console.log(`Node ${process.versions.node} は .nvmrc (${declared}) と同じ major です`);
