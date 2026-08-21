// `.github/dependabot.yml` の「ESLint major 更新を保留する ignore」と、`package.json` が
// 宣言している eslint のバージョン範囲が食い違っていないことを固定するテスト。
//
// なぜテストで縛るのか:
//   この ignore は「上流 (eslint-plugin-react) が ESLint 10 に未対応な間だけ」有効な
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
//
// YAML パーサを新たに依存へ足さないのは、検査対象が自分たちで書いた 1 ファイルだけで、
// 形も固定されているため (CLAUDE.md §9「新規依存は最小限に」)。代わりに、想定した形が
// 読み取れなかった場合は黙って緑にせず fail-closed で落とす。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// 設定ファイルを読むため (Node 標準の同期 API で十分)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// リポジトリのルート (このテストファイルは tests/ 直下にある)
const REPO_ROOT = resolve(__dirname, '..');
// 検査対象 1: Dependabot の設定ファイル
const DEPENDABOT_PATH = resolve(REPO_ROOT, '.github/dependabot.yml');
// 検査対象 2: eslint のバージョン範囲を宣言している場所
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');

// ignore の対象パッケージ名 (dependabot.yml の dependency-name と一致させる)
const GUARDED_DEPENDENCY = 'eslint';
// major 更新だけを止めるための update-types 値 (Dependabot の予約語)
const MAJOR_UPDATE_TYPE = 'version-update:semver-major';
// 上流 (eslint-plugin-react) が未対応で、保留を続ける必要がある最初の major。
// package.json がこの major 以上を許すようになったら ignore は用済み
const UNSUPPORTED_MAJOR = 10;

/**
 * dependabot.yml から「npm エコシステムの ignore に並ぶ dependency-name → update-types」を読み取る。
 *
 * 自前で読むのは最小限に留めたいので、YAML の一般形ではなくこのファイルが実際に取っている
 * 形 (2 段インデント・ダブルクォート・フロー配列) だけを解釈する。想定外の形に出会ったら
 * 空を返して呼び出し側の検査を落とす (誤って「ignore は無い」と読んで緑にしないため)。
 */
function readNpmIgnoreEntries(yaml: string): Map<string, string[]> {
  // 1 行ずつ見ていくので行配列にする
  const lines = yaml.split('\n');
  // 読み取った結果 (パッケージ名 → update-types の配列) を溜める
  const entries = new Map<string, string[]>();

  // いま npm エコシステムのブロックの中にいるか
  let inNpmBlock = false;
  // いまそのブロックの ignore: の中にいるか
  let inIgnoreList = false;
  // 直前に読んだ dependency-name (次に来る update-types の持ち主)
  let currentDependency: string | null = null;

  // すべての行を順に走査する
  for (const line of lines) {
    // エコシステムの切り替わり行 (`  - package-ecosystem: "npm"` 等) を検出する
    const ecosystem = line.match(/^ {2}- package-ecosystem:\s*"([^"]+)"/);
    if (ecosystem) {
      // npm のブロックに入ったかどうかを記録する
      inNpmBlock = ecosystem[1] === 'npm';
      // ブロックが変わったので ignore の入れ子状態はリセットする
      inIgnoreList = false;
      currentDependency = null;
      // この行自体は ignore の中身ではないので次の行へ
      continue;
    }
    // npm 以外のブロックの中身は見る必要がない
    if (!inNpmBlock) continue;

    // ブロック直下のキー (`    ignore:` / `    groups:` など) を検出する
    const blockKey = line.match(/^ {4}([a-z-]+):\s*$/);
    if (blockKey) {
      // ignore: に入ったときだけ、以降の行を ignore の中身として読む
      inIgnoreList = blockKey[1] === 'ignore';
      // 別のキーへ移ったので、読みかけの dependency-name は捨てる
      currentDependency = null;
      // この行自体は中身ではないので次の行へ
      continue;
    }
    // ignore: の外の行は対象外
    if (!inIgnoreList) continue;

    // ignore の 1 エントリの開始行 (`      - dependency-name: "eslint"`)
    const dependency = line.match(/^ {6}- dependency-name:\s*"([^"]+)"/);
    if (dependency) {
      // このエントリの持ち主を覚え、update-types 未指定の場合に備えて空配列で登録しておく
      currentDependency = dependency[1];
      entries.set(currentDependency, []);
      // 次の行以降で update-types を拾う
      continue;
    }

    // エントリに属する update-types 行 (`        update-types: ["version-update:semver-major"]`)
    const updateTypes = line.match(/^ {8}update-types:\s*\[(.*)\]\s*$/);
    // 持ち主が分かっているときだけ採用する (行の順序が想定と違えば拾わない = 検査は緩まない)
    if (updateTypes && currentDependency) {
      // フロー配列の中身をカンマで割り、両端のクォートと空白を落として値だけにする
      const values = updateTypes[1]
        .split(',')
        .map((value) => value.trim().replace(/^"|"$/g, ''))
        .filter((value) => value.length > 0);
      // 直前の dependency-name のものとして記録する
      entries.set(currentDependency, values);
    }
  }

  // 読み取れた分を返す (想定外の形なら空のまま返り、呼び出し側の検査が落ちる)
  return entries;
}

/**
 * `"^9.39.4"` のようなバージョン範囲から、許容される最小の major を取り出す。
 *
 * ここで扱うのは自分たちが書いた package.json の 1 エントリだけなので、`^` / `~` / 素の数値
 * という実際に使っている形しか解釈しない。判定できない書き方 (`>=9 <11` のような複合範囲) は
 * null を返し、呼び出し側で「読めなかった」として落とす — 読めない範囲を勝手に
 * 「9 系だろう」と決めつけると、10 系へ上げた日に検査が黙って素通りしてしまう。
 */
function parseAllowedMajor(range: string): number | null {
  // 先頭のレンジ記号 (^ または ~) を 1 つだけ許し、そのあとに major の数字が続く形に限定する
  const matched = range.trim().match(/^[\^~]?(\d+)(?:\.\d+)*$/);
  // 形が合わなければ「読めなかった」ことを呼び出し側へ伝える
  if (!matched) return null;
  // 取り出した major を数値にして返す
  return Number(matched[1]);
}

describe('dependabot.yml の ESLint major 保留', () => {
  // 設定ファイルの中身 (どのテストからも同じものを読む)
  const dependabotYaml = readFileSync(DEPENDABOT_PATH, 'utf8');
  // package.json は JSON なのでそのままパースできる
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  // devDependencies に書かれている eslint のバージョン範囲
  const declaredRange: unknown = packageJson.devDependencies?.[GUARDED_DEPENDENCY];
  // npm ブロックの ignore エントリ一覧
  const ignoreEntries = readNpmIgnoreEntries(dependabotYaml);
  // eslint に対する ignore が書かれているか (書かれていれば update-types の配列が取れる)
  const guardedUpdateTypes = ignoreEntries.get(GUARDED_DEPENDENCY);

  it('package.json の eslint バージョン範囲が、このテストで解釈できる形で書かれている', () => {
    // 範囲が文字列でなければ、そもそも devDependencies から eslint が消えている
    expect(typeof declaredRange).toBe('string');
    // 解釈できない書き方だと以降の判定が意味を失うので、ここで落として気付けるようにする
    expect(parseAllowedMajor(declaredRange as string)).not.toBeNull();
  });

  it('eslint 9 系に留まっている間は major 更新の ignore を維持している', () => {
    // 許容している最小 major を取り出す (上のテストで形は保証済み)
    const allowedMajor = parseAllowedMajor(declaredRange as string);
    // まだ上流未対応の major (10) へ上げていない = 保留が必要な状態
    if (allowedMajor !== null && allowedMajor < UNSUPPORTED_MAJOR) {
      // ignore エントリ自体が存在すること (消されていないこと)
      expect(guardedUpdateTypes).toBeDefined();
      // 止める対象は major だけ。minor / patch まで止めると 9 系の修正が届かなくなる
      expect(guardedUpdateTypes).toEqual([MAJOR_UPDATE_TYPE]);
    }
  });

  it('eslint 10 以上へ上げたら、用済みの ignore が残っていない', () => {
    // 許容している最小 major を取り出す
    const allowedMajor = parseAllowedMajor(declaredRange as string);
    // 上流が対応して 10 以上を許すようになった = 保留の理由が消えた状態
    if (allowedMajor !== null && allowedMajor >= UNSUPPORTED_MAJOR) {
      // ここで落ちたら dependabot.yml の ignore を削除する (以後の major を止めないため)
      expect(guardedUpdateTypes).toBeUndefined();
    }
  });
});
