// 実際に走っている Node の major が `.nvmrc` と同じかを、**その Node 自身に**確かめさせる。
//
// なぜ要るか:
//   `tests/node-runtime-alignment.test.ts` の (a') はワークフローの YAML を静的に読むので、
//   「宣言として書かれた Node」までしか見えない。`run:` の中で `volta` / `nvm` / `asdf` を
//   走らせる形、値が式のとき (`container: ${{ matrix.image }}`)、他リポジトリの再利用可能
//   ワークフロー、composite action の中身は原理的に見えず、綴りを 1 つ塞ぐたびに次の抜け道が
//   出てくる (この repo が CSP の静的解析と Stripe の API 版で 2 度踏んだ形)。
//   ここは**綴りに依存しない** — スイートを動かすその Node が自分の版を申告するので、
//   どう用意されたかに関係なく食い違いが分かる。静的な検出網は「新しいジョブが増えたことに
//   気付く」ための網として残し、**性質そのものの担保はこの 1 ステップが持つ**。
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
  // 何が起きたかを 1 行で伝える (パスは相対表記のまま出す)
  console.error(`.nvmrc を読めない: ${error instanceof Error ? error.message : String(error)}`);
  // 比較の土台が無いので、検証できないまま通さずに止める
  process.exit(1);
}
// `v26` のような書き方も許して、先頭の v を落とす。
// **`#` のコメントは許さない** — `.nvmrc` を実際に読む `actions/setup-node` と `nvm` が
// 中身を trim するだけで `#` 以降を落とさないため、ここだけ寛容にすると
// 「検査は通るのに CI の Node 準備が壊れる」食い違いになる
// (テスト側の readNvmrcMajor も同じ規則にそろえてある)
const wantedMajor = declared.replace(/^v/, "").split(".")[0];
// いま動いている Node の major (`process.versions.node` は "26.1.0" の形)
const actualMajor = process.versions.node.split(".")[0];

// `.nvmrc` が読めない・数字でない場合は、比較の土台が無いので落とす (fail-closed)
if (!/^\d+$/.test(wantedMajor)) {
  // 何が入っていたかを添えて、直す先が分かるようにする
  console.error(`.nvmrc から major を読めない (実際の中身: ${JSON.stringify(declared)})`);
  // 検証できない状態で通すと、この検査があること自体が誤った安心になる
  process.exit(1);
}

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
