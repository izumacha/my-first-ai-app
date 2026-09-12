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
// **覆える範囲を正確に書いておく。** 効くのは「ジョブ全体に効く入れ替え」までで、
//   具体的には `setup-node` の指定・`$GITHUB_PATH` への追記・ツールキャッシュの差し替え・
//   コンテナイメージ。**同じ `run:` の中だけで入れ替える形 (`. nvm.sh && nvm use 20 &&
//   npm test` のように 1 ステップで完結する形) は覆えない** — `run:` ごとにシェルが
//   新しくなるので、別ステップのこの検証からは観測できない (実測)。
//   そこは静的な検出網でも見えず、**残る境界**としてレビューで見るしかない。
//   静的な検出網は「新しいジョブが増えたことに気付く」ための網として残す。
import { readFileSync } from "node:fs";

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
  console.error(`.nvmrc を読めない: ${detail.split(new URL("..", import.meta.url).pathname).join("")}`);
  // 比較の土台が無いので、検証できないまま通さずに止める
  process.exit(1);
}
// **このリポジトリの `.nvmrc` は「major だけ」を書く運用**なので、`v26` / `26` だけを許す。
// `26.1.0` や `26 # LTS` を許さないのは、テスト側の readNvmrcMajor と**まったく同じ規則**に
// そろえるため — 2 つの読み手が別々の書式を許すと、片方が緑でもう片方が赤という
// 食い違いが起きる (この repo が写しを嫌う理由そのもの。実測で `26.1.0` が割れていた)
const matched = declared.match(/^v?(\d+)$/);
// 形が合わなければ、比較の土台が無いので落とす (fail-closed)
if (matched === null) {
  // 何が入っていたかを添えて、直す先が分かるようにする
  console.error(
    `.nvmrc は major だけを書くこと (v26 / 26)。実際の中身: ${JSON.stringify(declared)}`,
  );
  // 検証できない状態で通すと、この検査があること自体が誤った安心になる
  process.exit(1);
}
// ここから先は major を取り出せている
const wantedMajor = matched[1];
// いま動いている Node の major (`process.versions.node` は "26.1.0" の形)
const actualMajor = process.versions.node.split(".")[0];

// major が食い違っていれば、どちらがどうずれているかを出して落とす
if (wantedMajor !== actualMajor) {
  // 「どの Node で走っているか」と「どの Node を指定したか」を両方出す
  console.error(
    `CI が走っている Node (${process.versions.node}) の major が .nvmrc (${declared}) と違う。` +
      "setup-node に node-version-file: '.nvmrc' を渡しているか、run: の中で Node を" +
      "入れ替えていないかを確認すること。",
  );
  // 検証していない Node でスイートを走らせないため、ここで止める
  process.exit(1);
}

// 一致していることを記録に残す (ログを見た人が「検証されている」と分かるように)
console.log(`Node ${process.versions.node} は .nvmrc (${declared}) と同じ major です`);
