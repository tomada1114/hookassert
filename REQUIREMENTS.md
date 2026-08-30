# hookassert — 要件定義

## 1. 背景

Claude Code の hooks は `settings.json` に宣言され、tool call やセッションのライフサイクルイベントに応じて外部コマンドを起動する仕組みである。仕様は公開されているが、設定ミスの多くが**沈黙する**という性質を持つ。

**マージ意味論**: hooks は user (`~/.claude/settings.json`) / project (`.claude/settings.json`) / local (`.claude/settings.local.json`) の各層から読まれ、**上書きではなく連結**される (同一ハンドラは重複排除)。この点は他の設定キーと挙動が異なり、「local が project の hook を消した」という誤解の原因になる。

**matcher の三分岐**: matcher 文字列は、英数字・`_`・`-`・空白・`,`・`|` のみで構成される場合は**完全一致リスト**として、それ以外を含む場合は**非アンカーの JavaScript 正規表現**として評価される。この分岐のため `"Edit|Write"` は完全一致リストになるが `"Edit.*"` は非アンカー正規表現となり `NotebookEdit` にも一致する。加えて matcher の比較は**大文字小文字を区別**し、`"bash"` は `Bash` に一致しない。matcher を文字列ではなく配列で書くと schema エラーとなり、そのファイルの hooks が丸ごと無効化される。`FileChanged` や `StopFailure` など一部イベントでは matcher の対象集合がさらに狭い。

**バージョン依存**: カンマ区切りの matcher は v2.1.191 以降、ハイフンを含む完全一致は v2.1.195 以降でなければ期待通りに動かない。直近だけでも複数の挙動変更があり、仕様は動く的である。

**exit code の意味論**: hook の終了コードは結果に直結する。`exit 2` はブロック可能イベントでブロックを意味し、`exit 0` かつ有効な JSON 出力があれば `permissionDecision` が解釈される (ただし `exit 2` は `allow` の JSON を上書きする)。それ以外の非0終了は**非ブロッキングエラー**として扱われ、ツールはそのまま実行される。つまりポリシー判定を `exit 1` で書いた hook は「動いているのに何も止めていない」状態になる。`PostToolUse` はそもそもブロックできず、`PermissionRequest` は `exit 2` を honor しない、といったイベントごとの差もある。

**hook の実行契約**: hook は Claude Code の内部機構ではなく、**stdin で JSON を受け取り exit code と stdout で結果を返す外部プロセス**である。この契約が公開されていることが、Claude Code を起動せずに hook を検証できる根拠になる。

**公式の診断手段とその限界**: `claude doctor` (セッション非起動でのスキーマ検証)、`claude --debug` (どの matcher がチェックされ hook がどう終了したかのログ)、`/hooks` (登録済み hook の読み取り専用ブラウザ) がある。ただし `--debug` は**実セッションを起動して本物の tool call を発生させないと1ケースも観測できず、合成入力を注入する経路がない**。したがって「この設定変更で `PreToolUse` の `Bash` hook が意図通りブロックするか」を、Claude を起動せずに N ケース一括で検証する手段は 2026-08-29 時点で存在しない。

## 2. コンセプト

> hookassert tests your Claude Code hooks like code: it resolves your merged settings.json, replays recorded or synthetic tool events, actually runs the matching hooks, and fails CI when one doesn't fire, doesn't block, or exits in a way you didn't declare.

hookassert は hooks 設定の**テストランナー**である。診断レポートを出して終わるのではなく、フィクスチャに宣言した期待値 (発火するか / 判定は deny か / exit code / 出力) と実測を照合し、一致しなければ非0で終了する。CI に置くことを第一の使用場面とする。

CLI は4サブコマンドで構成する。

| コマンド | 役割 | hook を起動するか |
|---|---|---|
| `explain` | どの hook がどの層から発火するかの説明 | **しない** |
| `lint` | 実行を伴わない静的チェック | **しない** |
| `record` | 本物のイベントペイロードの捕獲 | 捕獲用の hook を仕込む (中身は stdin の保存のみ) |
| `test` | フィクスチャの実行とアサーション | **する** (対象を限定し、同意を得たうえで) |

## 3. 機能要件

### 3.1 settings の解決とマージ層の追跡 — `explain`

user / project / local / `--settings` で指定されたファイルを読み、hooks キーを**連結して**解決する。JSONC パーサで全ノードのオフセットを保持し、後段のレポーターに file / line を供給する。

`hookassert explain <event> [tool]` は、発火する hook の集合と順序、各 hook の出所ファイルと行番号、そして**マッチしなかった matcher についてはその理由**を出力する。

- 受け入れ条件: 3層のフィクスチャ 12 ケースで、発火する hook の集合・順序・出所ファイルの絶対パス・行番号が期待値と一致する。`settings.local.json` が `settings.json` の hook を消さない (連結される) ことを検証するケースを含む。
- 受け入れ条件: マッチしなかった matcher に対し、「完全一致リストとして評価され `Bash` に一致しなかった」「非アンカー正規表現として評価され一致しなかった」のいずれかを理由として出力する。

### 3.2 matcher engine と仕様の外部化 — `spec/claude-code-<range>.json`

matcher の三分岐、イベントごとの matcher 対象集合、exit code の効果、バージョン依存を実装する。**仕様はコードに埋め込まず spec JSON に全量を外出しし、単体テストをその JSON から生成する。**

対象は**公式に文書化されている全イベント**とする。イベントを絞らない代わりに、後述する「ペイロード形状の確度」でイベントごとの保証水準を区別する。

- 受け入れ条件: 公式 matcher 表の全行を machine-readable なケースとして spec JSON に転記し、そこから生成したテストが全通過する。
- 受け入れ条件: 公式の exit code 効果表 (`PreToolUse` はブロックする / `PermissionRequest` は `exit 2` を honor しない / `PostToolUse` は stderr を Claude に見せるだけ / `StopFailure` 等は出力を破棄する) の全行が、判定ロジックのテストとして通る。
- 受け入れ条件: `claude --version` を検出し、対象バージョンが spec の宣言レンジ外なら、全 matcher 判定を `unknown` に落として非0終了する。

### 3.3 本物のペイロードの捕獲 — `record`

合成したペイロードは、形状が実物と違っていても静かに通ってしまう。利用者の hook が `tool_input` の特定のキーを読んでいる場合、キー名が違えば「テストは緑なのに本番では動かない」が起きる。これを構造的に潰すため、**本物のペイロードを捕獲してフィクスチャの素材にする**。

`hookassert record` は、stdin を保存するだけの捕獲用 hook を一時的に設定へ追加し、通常の Claude Code 利用の中で実際に流れたペイロードを蓄積する。捕獲用 hook は副作用を持たない (受け取った JSON をファイルに書くだけで、判定も出力もしない)。`hookassert record --stop` で設定を元に戻す。

- 受け入れ条件: 捕獲用 hook が挿入された状態で、既存の hooks の発火が一切変化しない (捕獲用 hook は常に `exit 0` かつ stdout 無出力)。
- 受け入れ条件: `record --stop` が、挿入した設定を完全に除去し、元のファイルとの差分がゼロになる。
- 受け入れ条件: 捕獲したペイロードから `explain --emit-fixtures` でフィクスチャを生成でき、それがそのままロードできる。
- 受け入れ条件: 捕獲したペイロードには出所と捕獲日時を記録し、後述の確度表示に利用できる。

### 3.4 フィクスチャ形式とスキーマ

1ファイルに複数ケースを宣言する。各ケースは `event` / `tool` / `input` / `expect` を持ち、`expect` には `fires` / `decision` / `exitCode` / `stdoutContains` / `stderrContains` / `context` / `updatedInput` / `timedOut` を書ける。共通設定 (`settings` の指定、既定のタイムアウト、env の追加) はファイル単位で括り出せる。ケース単位で `dryRun` と `cwd` を上書きできる。

JSON Schema を同梱し、`$schema` 行でエディタ補完を効かせる。

- 受け入れ条件: ブロック不能なイベント (`PostToolUse` など) に `decision: deny` を書いた場合、**ロード時に**エラーで落ち、代替案を提示する (実行してから失敗させない)。
- 受け入れ条件: 各ケースがそのペイロードの出所 (捕獲した本物か、手で書いた合成か) を保持する。

### 3.5 テストダブル — `stub`

利用者の hook には、副作用を持つもの (フォーマッタ、通知、デプロイ、リモートへの push など) が含まれうる。それらについて「発火するかどうか」だけを検証したい場合があるため、ケース単位で hook のコマンドをテストダブルに差し替えられるようにする。

```yaml
- event: Stop
  expect: { fires: true }
  stub:
    "~/notify.sh": { exitCode: 0 }
```

`stub` を指定した hook は、宣言された結果を返す代わりに**実際には起動されない**。これにより、副作用を持つ hook を含む設定でも、発火の検証だけは安全に行える。

- 受け入れ条件: `stub` された hook のコマンドが1度も spawn されないことを、テストで機械的に保証する。

### 3.6 hook の実行 — executor

Claude Code の起動形態を**忠実に模倣する**。args 無しは shell form (`sh -c`)、args 有りは exec form (シェルを介さず直接 spawn)。挙動を「改良」しない。改良すると、テストは通るのに本番で違う結果になる。

実行対象は**フィクスチャがアサーションしているイベントの hook に限定する**。他のイベントの hook は、設定上は解決されていても起動しない。

- 受け入れ条件: `explain` と `lint` が子プロセスを1つも spawn しないことを、spawn を監視するテストダブルで機械的に保証する (呼び出し回数 0 を assert する)。
- 受け入れ条件: アサーション対象外のイベントの hook が spawn されないことを、同様に機械的に保証する。
- 受け入れ条件: env は allowlist 方式で構成し、`process.env` を素通ししない。
- 受け入れ条件: タイムアウトした hook は `timedOut` として区別し、「タイムアウトした `PreToolUse` hook はブロックしない」という仕様を判定に反映する。

### 3.7 判定の語彙 — decision resolver

生の exit code ではなく**結果**を語彙にする。

| 値 | 条件 |
|---|---|
| `deny` | `exit 2`、またはブロック可能イベントで `permissionDecision` が deny / block |
| `allow` | `permissionDecision` が allow かつ exit code が 2 以外 |
| `pass` | 判定なし。通常の権限フローに委ねられる |
| `error` | 2 以外の非0終了かつ有効な JSON 無し、または schema 検証失敗 |
| `unknown` | 断言できない (3.9 参照) |

`exitCode` は副次フィールドとして残す。`exit 2` が `allow` の JSON を上書きする点は罠であるため、その組み合わせを検出したら専用の警告を出す。

- 受け入れ条件: 「ポリシー判定を `exit 1` で書いた hook が `pass` と判定される」ケースをテストとして持ち、失敗メッセージがその意味 (何も止めていない) を説明する。

### 3.8 アサーションと差分表示 — `test`

フィクスチャの `expect` と実測を照合し、pass / fail を出す。

- 受け入れ条件: 失敗時に「期待 deny / 実際 pass — hook は発火したが exit 0 で終了した」の形で、期待と実測の差分を人間可読に出力する。
- 受け入れ条件: 「発火しなかった」失敗では、なぜ発火しなかったか (matcher が一致しない / そのイベントに hook が無い / 別の層の設定に埋もれている) を併記する。

### 3.9 `unknown` の一級扱いと確度の表示

断言できない状況では**断言しない**。`unknown` は失敗でも成功でもない第三の値として扱い、**理由を保持する**。

理由には少なくとも次を区別できること: spec の宣言レンジ外のバージョン、ペイロード形状が未検証のイベント、プラグイン由来 hooks の存在、managed settings が想定される環境。

さらに、ケースごとに**ペイロードの確度**を区別する。捕獲した本物のペイロードで通ったケースと、手で書いた合成ペイロードで通ったケースは、保証の強さが違う。レポートはこれを区別して表示する。

- 受け入れ条件: `--ci` は `unknown` を green にしない。
- 受け入れ条件: レポートのサマリが `asserted N cases (M from recorded payloads), K unknown` の形で、確度の内訳を数として示す。
- 受け入れ条件: `unknown` は必ず理由つきで出力され、**理由なしの `unknown` を作れない**型設計になっている。

### 3.10 静的チェック — `lint`

実行を伴わずに、設定そのものの欠陥を検出する。

- `matcher-is-array` — matcher を配列で書いた場合。schema エラーでそのファイルの hooks が丸ごと落ちるため、影響が最も大きい
- `matcher-case` — `"bash"` のような大文字小文字の不一致
- `matcher-comma-version` / `matcher-hyphen-version` — 使用中の Claude Code バージョンでは解釈されない記法
- `matcher-dead` — 既知のツール名のどれにも一致しない matcher (綴り誤り)
- `matcher-unanchored` — 非アンカー正規表現による過剰一致 (`Edit.*` が `NotebookEdit` にも当たる)。一致してしまうツール名を列挙する
- `command-not-found` / `missing-shebang` / `not-executable` — hook コマンドが起動できない状態
- `unquoted-var` — hook コマンド中の未クオートのシェル変数
- `exit-1-policy` — ポリシー分岐に見える `exit 1` (ブロックしていない)
- `exit-2-overrides-allow` — `allow` の JSON を出しながら `exit 2` で終了しうる構造

- 受け入れ条件: 各ルールが違反フィクスチャと非違反フィクスチャの対を持ち、非違反側で誤検知ゼロ。
- 受け入れ条件: 全ルールが file / line / rule-id / 修正案を出力する。
- 受け入れ条件: 公式トラブルシューティングの症状表の各行が、いずれかのルールで検出できることを対応表として文書化する。

### 3.11 CI 統合とレポーター — `--ci`

- `pretty` — 人間向け。既定
- `json` — スキーマを固定して同梱する
- `github` — `::error file=,line=,title=::` 形式の GitHub Actions annotations。settings ファイルの該当行に直接付ける

- 受け入れ条件: 失敗が1件でもあれば exit 1、全 pass なら exit 0。
- 受け入れ条件: 実際の GitHub Actions ジョブで、壊れた matcher を持つ設定ファイルの正しい行に注釈が表示される。
- 受け入れ条件: レポートのヘッダに、検出した `claude` のバージョン、spec の宣言レンジ、結果の不完全性 (プラグイン検出、managed settings 想定) を常時印字する。

### 3.12 仕様への追随の検証 — conformance

単体テストが保証するのは「hookassert が仕様書と一致していること」であって、「仕様書が実装と一致していること」ではない。後者を担保するため、**実際の `claude --debug` の挙動と hookassert の予測を突き合わせる検証**を、プロジェクト自身の検証手段として持つ。

これは利用者の CI で走らせるものではなく、hookassert 自身のリポジトリで実行する。

- 受け入れ条件: matcher 表の全行について、実測の発火集合と予測が一致する。
- 受け入れ条件: 不一致が見つかった場合、spec JSON かエンジンを修正し、不一致の履歴を文書として残す。
- 受け入れ条件: 捕獲したペイロード (3.3) の形状が spec の想定と一致するかを照合し、一致が確認できたイベントを「ペイロード形状が検証済み」として spec に記録する。

### 3.13 将来の拡張 (見込みであって約束ではない)

- プラグイン由来の hooks (`hooks/hooks.json`) の解決。変数展開を含む
- managed settings / エンタープライズ層の解決
- TypeScript / JavaScript によるフィクスチャ API
- Windows サポート

## 4. 非機能要件

- **ランタイム**: Node.js 20 以上。ESM。npm で配布し、`npx hookassert` で実行できる。
- **対応 OS**: macOS / Linux。**Windows は未検証**であり、その旨を明記する。shell form が Git Bash / PowerShell に分岐し、exec form が `.cmd` シムで壊れるため、検証していない環境でのサポートは主張しない。
- **依存方針**: 依存は最小に保つ。JSONC パーサ (オフセット保持のため必須) と YAML パーサ程度に留め、実行時に重いフレームワークを持ち込まない。`npx` の初回起動を体感で待たせない。
- **型付け**: TypeScript strict。spec JSON には JSON Schema を持たせ、読み込み時に検証する。
- **テスト**: matcher と decision resolver の単体テストは spec JSON から生成し、仕様変更時の追随コストを1ファイルに閉じる。全 lint ルールに違反 / 非違反のフィクスチャ対を持つ。
- **自身のテストスイートの安全性**: hookassert 自身のテストで使うフィクスチャの hook は、**exit code と stdout を返すだけの、副作用を持たないスクリプト**とする。検証対象は exit code と出力の組み合わせであり、副作用を持つコマンドを書く必要がない。
- **hook を実プロセスとして起動することの安全設計**: hookassert は利用者の hook を**本当に実行する**。以下を要件とする。
  - 実行は opt-in。`lint` と `explain` は一切コマンドを起動しない。
  - 実行対象はフィクスチャがアサーションしているイベントの hook に限定する。
  - `test` は TTY で初回に**起動予定のコマンド一覧を提示**し、明示的な同意を要求する。CI 環境でのみ無確認で実行する。
  - env は allowlist。`process.env` を素通ししない。認証情報にあたる環境変数は既定で遮断し、明示的な指定でのみ渡す。
  - cwd は解決済みのプロジェクトルートに固定する (ケース単位で上書き可)。
  - 既定のタイムアウトを本番既定より短く設定し、その差異をレポートヘッダに毎回印字する。
  - ケース単位の `dryRun` と `stub` を持つ。
  - ドキュメントの目立つ位置に「hookassert はあなたの hook を本当に実行する。隔離された環境で走らせること」を置く。

## 5. スコープ外

行わないこと。いずれも「未対応」として明記し、黙って落とさない。

1. **Claude Code 以外のエージェント**: 対象は Claude Code のみとする。他のエージェントの hooks 設定は読まない。
2. **サンドボックス実行**: 作らない。hook は本物のコマンドを本当に実行する。緩和策は実行対象の限定・opt-in・最小 env・cwd 固定・タイムアウト・`stub`・実行前の一覧提示であり、隔離そのものは提供しない。
3. **hook を新規に書くための SDK / テンプレート集**: 行わない。hookassert は既存設定を検証する側に徹する。
4. **hooks 設定の自動修正**: `lint` は修正案を文章として示すが、ファイルを書き換えない。設定の意図を機械が推測して書き換えることは、このカテゴリでは害が大きい。
5. **エディタ拡張 / LSP / watch モード**: 行わない。
6. **独立した `init` コマンド**: 作らない。`record` と `explain --emit-fixtures` の組み合わせでフィクスチャの雛形を得る形にし、コマンドの表面積を減らす。

## 6. 技術設計方針

### アーキテクチャ概要

パイプラインは単方向で構成する。

`settings loader` (3層 + `--settings` を JSONC パーサで読み、全ノードのオフセットを保持したまま連結解決) → `matcher engine` (spec JSON を唯一の仕様源として発火集合を決定) → `executor` (shell form / exec form、対象イベントの限定、env allowlist、cwd 固定、タイムアウト、`stub`) → `decision resolver` (exit code と JSON 出力を deny / allow / pass / error / unknown に写像) → `assert engine` (フィクスチャの `expect` と照合) → `reporter` (pretty / json / github)。

`lint` は loader と matcher engine のみを使い、executor に到達しない。`explain` は loader + matcher engine + reporter。`record` は loader と設定の書き戻しのみを使う。オフセット情報を loader からパイプラインの末端まで保持することが、GitHub annotations を該当行に付けられるかどうかを決める。

### 主要な技術課題

**(a) 仕様の外部化と、その正しさの裏取り**

matcher の三分岐、イベントごとの対象集合、exit code の効果、バージョン依存を正確に実装する必要がある。仕様は動く的なので、コードに埋め込まず spec JSON に全量を外出しし、単体テストをその JSON から生成する。さらに読解の正しさをドキュメント解釈だけに依存させないため、実際の `claude --debug` の挙動と突き合わせる (3.12)。仕様追随のコストを1ファイルの差し替えに閉じることが設計目標である。

**(b) 忠実な模倣と、実行の限定**

Claude Code の起動形態 (shell form / exec form の分岐、env の扱い) を改良せず忠実に模倣することが要件になる。同時に、実行は利用者の環境に副作用を及ぼしうるため、「起動しない経路」と「起動する経路」を構造として分離する。`lint` と `explain` が executor に到達しないことを、テストだけでなく型やモジュール境界でも表現できることが望ましい。

**(c) 不確実性を握り潰さない型設計**

未検証のペイロード形状、spec のレンジ外バージョン、プラグイン由来 hooks、managed settings — いずれも「分からない」を生む。判定語彙に `unknown` を一級の値として持ち、**理由なしの `unknown` を作れない**構造にする。「発火しません」と誤って断言することは、このカテゴリのツールにとって最も回復困難な失敗であるため、確度を落とす方向の誤りを常に優先する。

### 「safe」「secure」を製品の主張に使わない

hookassert は偽陰性を保証できない。未検証のペイロード形状、プラグイン由来 hooks、managed settings、バージョン差のいずれもが「検出できなかった」を生みうる以上、「安全」「セキュア」という語は技術的に裏付けられない主張になる。したがって出力と文書からこれらの語を排し、代わりに `asserted N cases (M from recorded payloads), K unknown` のように**数と確度で語る**。

## 7. パッケージ名

**`hookassert`** (unscoped)。

2026-08-28 時点で `registry.npmjs.org/hookassert` へ実アクセスし **404 = 未使用**であることを確認した。GitHub の `"hookassert in:name"` 検索も `total_count: 0` だった。名前は中核である「assert」をそのまま含む。

なお**この観測はその時点のスナップショットであり、公開前に再確認する必要がある**。
