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

// `.nvmrc` を読む (リポジトリのルートから実行される前提。読めなければ下で落とす)
const declared = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
// `v26` のような書き方も許して、先頭の v を落とす
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
