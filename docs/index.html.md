# index.html 開発者ガイド

> **対象読者**: コードを修正・拡張する開発者向け。ユーザー向けの説明は [README.md](../README.md) を参照。

---

## 目次

1. [ファイル構成の概要](#ファイル構成の概要)
2. [HTML 構造](#html-構造)
3. [JavaScript モジュール構成](#javascript-モジュール構成)
4. [データフロー](#データフロー)
5. [主要モジュール詳解](#主要モジュール詳解)
   - [Storage keys](#storage-keys)
   - [Application state](#application-state)
   - [Character encoding detection](#character-encoding-detection)
   - [localStorage helpers](#localstorage-helpers)
   - [Diff parser](#diff-parser)
   - [Large-hunk splitting](#large-hunk-splitting)
   - [Syntax highlighting helpers](#syntax-highlighting-helpers)
   - [Hashing](#hashing)
   - [Render: sidebar project list](#render-sidebar-project-list)
   - [Render: full diff view](#render-full-diff-view)
   - [Build a single hunk card](#build-a-single-hunk-card)
   - [Keyboard navigation](#keyboard-navigation)
   - [Review memos](#review-memos)
   - [Export / Import](#export--import)
   - [File System Access API — file handles](#file-system-access-api--file-handles)
   - [File System Access API — directory handles & settings folder](#file-system-access-api--directory-handles--settings-folder)
   - [File loading](#file-loading)
   - [Initialise](#initialise)
6. [状態管理の全体像](#状態管理の全体像)
7. [ハンクの同一性判定 (hunk hash)](#ハンクの同一性判定-hunk-hash)
8. [サイドバイサイド表示の仕組み](#サイドバイサイド表示の仕組み)
9. [ファイル読み込みの全フロー](#ファイル読み込みの全フロー)
10. [よくある修正パターン](#よくある修正パターン)

---

## ファイル構成の概要

```
index.html           ← アプリ本体（CSS・JS・HTML がすべて inline）
docs/
  index.html.md      ← 本ドキュメント（開発者向け解説）
README.md            ← ユーザー向けドキュメント
test/                ← テスト用 .diff サンプルファイル
```

`index.html` は **4,000 行超のシングルファイルアプリ**です。ビルドプロセスは存在せず、ブラウザで直接開くだけで動作します。highlight.js (v11.9.0) の minified ソースも inline 同梱されており、外部リソースへの通信は一切ありません。

---

## HTML 構造

```
<html>
  <head>
    <style>                     ← highlight.js テーマ CSS (インライン)
    <style>                     ← アプリ全体の CSS
  <body>
    <div id="app">
      <aside id="sidebar">      ← 左サイドバー（ファイル読み込み・エクスポート/インポート・「設定を保存」ボタン（保存状態表示・
                                   外部変更通知「読み込む」導線を含む）・プロジェクト一覧。
                                   フォルダ選択等の設定項目は #61 で設定モーダルへ移動済み）
      <main id="main">
        <div id="top-bar">      ← ヘッダーバー（ビュー切替・フィルター・設定/メモボタン・進捗。実装では class="topbar"）
        <div class="autosave-warning-banner" id="autosave-warning-banner"> ← 自動保存失敗時の警告バナー（トップバー直下、通常は非表示。#60）
        <div id="diff-container"> ← diff 表示エリア（JS で動的生成）
        <div id="empty-state">  ← 未読み込み時の案内テキスト
      <aside class="memo-panel" id="memo-panel">   ← レビューメモパネル（狭い画面はスライドオーバーレイ、
                                   1200px以上は .layout 内の3カラム目として常時ドッキング表示。#57）
    <div id="conflict-modal">   ← ファイル名衝突ダイアログ
    <div class="modal-overlay" id="settings-modal-overlay"> ← 設定モーダル（既定のフォルダ・保存先フォルダ・
                                   文字コード・キーワードカテゴリをまとめて表示。#61。「設定を保存」ボタン自体は
                                   サイドバー（メイン画面）に配置）
    <script>                    ← highlight.js (minified, インライン)
    <script>                    ← アプリロジック本体
```

---

## JavaScript モジュール構成

`<script>` タグ内は `// ──…──` のセクション区切りで論理的に分割されています。

| セクション名 | 役割 |
|---|---|
| **Storage keys** | `localStorage` キー定数 |
| **Application state** | `app` オブジェクト（ランタイム状態） |
| **Character encoding detection / decoding** | UTF-8 / Shift_JIS / EUC-JP 自動判定 |
| **localStorage helpers** | プロジェクト・レビュー・メモ等の読み書き |
| **Diff view mode** | Unified / Side-by-side モード保存 |
| **Keyword highlight** | キーワードのカテゴリ別ハイライト機能（カテゴリごとに色を設定、カテゴリ単位で一致回数カウントのON/OFFも可能、カテゴリ単位でハイライト自体のON/OFFも可能、カテゴリ単位で全体設定／プロジェクト毎の設定を選択可能）。新規カテゴリの色は `pickUnusedKeywordColor()` が既存カテゴリと重複しない色（固定パレット→ゴールデンアングルで生成する追加色）を自動選定する |
| **File System Access API — file handles** | IndexedDB へのファイルハンドル保存 |
| **File System Access API — directory handles** | IndexedDB へのフォルダハンドル保存 |
| **Project ID generation** | `filename__proj_YYYYMMDD_NNN` 形式の ID 生成 |
| **Unified diff parser** | `parseDiff()` — diff テキスト → 構造化データ |
| **Large-hunk splitting** | 大きなハンクを分割して表示 |
| **Syntax highlighting helpers** | highlight.js ラッパー・言語検出 |
| **Hashing** | Web Crypto API / djb2 フォールバック |
| **HTML escaping** | `esc()` ユーティリティ |
| **Parse @@ header** | `parseHunkHeader()` — ハンクヘッダのパース |
| **Render: sidebar project list** | `renderProjectList()` |
| **Render: stat summary** | `renderStatSummary()` — `git diff --stat` 風サマリパネル |
| **Render: full diff view** | `renderDiff()` |
| **Build a single hunk card** | `buildHunkCard()` |
| **Set collapsed state** | ハンクの折りたたみ |
| **Review status change** | `setHunkReviewStatus()` — 承認/要修正/保留の切り替え処理 |
| **Refresh progress badges** | `refreshProgress()` — 再レンダリングなしで進捗更新 |
| **Review memos** | レビューメモ（スライドパネル、リサイズハンドル） |
| **Keyboard navigation** | `j` / `k` / `Space` / `1` / `2` / `3` ショートカット |
| **View mode toggle** | Unified ↔ Split ボタン処理 |
| **Empty state helpers** | 空状態メッセージ表示 |
| **Project actions** | プロジェクトの選択・削除・並び替え |
| **Export / Import** | JSON エクスポート / インポート |
| **Settings folder** | 設定フォルダへの自動保存・読み込み、自動保存失敗時のトップ警告表示 |
| **Conflict modal** | ファイル名衝突ダイアログ |
| **File loading** | ファイル選択・ドロップ時の読み込み処理 |
| **Event listeners** | UI イベントの登録（設定モーダルの開閉処理を含む。#61） |
| **Drag & drop** | ドラッグ&ドロップ対応 |
| **Keyword categories** | キーワードカテゴリの追加・編集・削除UI（各カテゴリは有効/無効チェック・色・キーワード・全体/プロジェクトの適用範囲・一致回数カウントのON/OFFとバッジ・削除ボタンを1行に横並び表示する省スペースなレイアウト）。「一括登録」ボタンから複数行のテキストボックスでキーワードをまとめて登録でき（1行＝1カテゴリとして分割登録、登録先を全体設定／このプロジェクトのみから選択可能）、その処理は `bulkAddKeywordCategories()` が担う |
| **Initialise** | `init()` — 起動時初期化 |

> セクションはファイル内で上記の順に出現します（正確な行番号はメンテナンスコストが高いため記載していません）。該当箇所を探す際は、セクション区切りコメント（`// ──…──`）の直後にあるセクション名でファイル内検索してください。

---

## データフロー

### diff ファイル読み込み時の全体フロー

```
ユーザーがファイルを選択 / D&D
          │
          ▼
    loadFile(file)
          │
          ├─ decodeAuto(buffer)        文字コード自動判定 → テキスト変換
          │
          ├─ parseDiff(text)           diff テキスト → 構造化配列
          │     │
          │     └─ splitLargeHunk()   巨大ハンクを分割
          │
          ├─ プロジェクト名衝突チェック
          │     └─ showConflictModal() (衝突時) → ユーザー選択待ち
          │
          ├─ generateProjectId()       新規 ID を生成
          │
          ├─ computeAllHashes(files)   各ハンクに SHA-256 ハッシュを付与
          │
          ├─ saveProjects() / saveFileContent()  localStorage に保存
          │
          ├─ app.currentProjectId = id  ランタイム状態を更新
          │
          └─ renderDiff()             画面を再描画
```

### レビュー状態変更時のフロー

```
レビュー状態ボタン クリック / Space / 数字キー (setHunkReviewStatus)
          │
          ├─ loadAllReviews()          既存レビュー状態を読み込み
          ├─ reviews[projectId][filePath][hunkHash] = 'approved' | 'needs_changes' | 'on_hold'
          │  （クリック済みの状態をもう一度選ぶとキーを削除 = 未レビューに戻す）
          ├─ saveAllReviews()          localStorage に保存
          ├─ カードの status-* クラス / ボタンの active・aria-pressed を更新
          ├─ collapsed は status === 'approved' のときだけ true に
          └─ isReviewFilterActive(app.reviewFilter) が false（全チェックON、または全チェックOFF）なら refreshProgress() のみ、
             それ以外はハンクの表示/非表示が変わるため renderDiff() 全体を再実行
```

---

## 主要モジュール詳解

### Storage keys

`localStorage` に使うキーをすべて定数として集中管理しています。

```javascript
const SK_PROJECTS        = 'gitLocalReview_projects';
const SK_REVIEWS         = 'gitLocalReview_reviews';
const SK_MEMOS           = 'gitLocalReview_memos';
const SK_CURRENT         = 'gitLocalReview_currentProject';
const SK_FILES           = 'gitLocalReview_files';
const SK_VIEW_MODE       = 'gitLocalReview_viewMode';
const SK_REVIEW_FILTER   = 'gitLocalReview_reviewFilter';
const SK_PROJECT_SORT    = 'gitLocalReview_projectSort';
const SK_KEYWORDS        = 'gitLocalReview_keywords';
const SK_PROJECT_KEYWORDS = 'gitLocalReview_projectKeywords';
```

`SK_KEYWORDS` は全体設定（どのプロジェクトでも適用される）キーワードカテゴリの JSON エンコードされた配列 `{ id, keywords, color, countEnabled, enabled }[]` を保持します（`loadGlobalKeywordCategories()` / `saveGlobalKeywordCategories()`）。#50 以前の値（単一のカンマ区切り文字列）は読み込み時に自動的に単一カテゴリへ移行されます。`countEnabled`（#59 で追加、真偽値）はこのカテゴリのキーワード一致回数をカウント・表示するかどうかで、`sanitizeKeywordCategories()` は未設定値を `false` として扱います（既存カテゴリ・新規カテゴリともデフォルトはカウント無効）。`enabled`（#71 で追加、真偽値）はこのカテゴリのキーワードを実際にハイライトするかどうかで、`sanitizeKeywordCategories()` は未設定値を `true` として扱います（既存カテゴリ・新規カテゴリともデフォルトはハイライト有効）。`getActiveKeywordGroups()` は `enabled: false` のカテゴリをハイライト対象から除外しますが、`countEnabled` による一致回数カウントには影響しません（無効化中のカテゴリも件数は表示され続けます）。設定UIではカテゴリ行の先頭チェックボックスでこの値を切り替えます（`buildKeywordCategoryRow()`）。

`SK_PROJECT_KEYWORDS`（#68 で追加）はプロジェクト毎のキーワードカテゴリを保持する JSON エンコードされたマップ `{ [projectId]: category[] }` で、各プロジェクトの配列は `SK_KEYWORDS` と同じカテゴリ形状です（`loadProjectKeywordCategories(projectId)` / `saveProjectKeywordCategories(projectId, categories)`）。カテゴリ1件ずつに「全体設定」か「このプロジェクトのみ」かの適用範囲（scope）があり、サイドバーのセレクトで切り替えると `moveKeywordCategoryScope()` が該当カテゴリを `SK_KEYWORDS` と `SK_PROJECT_KEYWORDS` の間で移動させます。`loadKeywordCategories()` は現在アクティブなプロジェクトの文脈で実際にハイライト・表示に使う「全体設定 + アクティブプロジェクト自身のカテゴリ」をマージした一覧を返し、各要素に `scope: 'global' | 'project'` を付与します（設定UIやカテゴリの移動先判定はこの `scope` を見て行います）。プロジェクトが削除されると、そのプロジェクト用のエントリは `deleteProjectKeywordCategories()` により `SK_PROJECT_KEYWORDS` から削除されます（全体設定のカテゴリは影響を受けません）。

`SK_REVIEWS` の各ハンクの値は #51 以降 `'approved' | 'needs_changes' | 'on_hold'` のいずれか（キー自体が無ければ未レビュー）です。#51 以前の値（真偽値 `true`）は `normalizeReviewStatus()` により読み込み時に自動的に `'approved'` へ変換されます（`sanitizeReviewsData()` 経由、ローカルの既存データ・インポートしたJSON両方に適用）。

`SK_REVIEW_FILTER` は #56 以降、JSON エンコードされた `{ unreviewed, approved, needs_changes, on_hold }` の真偽値マップ（`REVIEW_FILTER_KEYS`）です。キーに対応するチェックボックスがオンのステータスのハンクのみが表示対象になります（OR 条件）。全キーが `true`（初期値）のとき、および全キーが `false`（何もチェックしていない状態）のときは、いずれもフィルタなし＝すべて表示として扱われます（`isReviewFilterActive()`）。#51〜#55 時代の単一選択文字列値（`'all' | 'unreviewed' | 'needs_changes'`）、およびそれ以前の真偽値のみの `gitLocalReview_unreviewedOnly` キーは、初回読み込み時に新しいマップ形式へ自動移行されます（`loadReviewFilter()`）。

---

### Application state

`app` オブジェクトがランタイム状態を保持します。`localStorage` に保存されない揮発性データです。

```javascript
const app = {
  currentProjectId: null,   // 現在選択中のプロジェクト ID
  parsedDiff: null,          // parseDiff() の戻り値（構造化 diff データ）
  fileProgressEls: new Map(),// filePath → <span> 要素（進捗バッジ）
  viewMode: 'unified',       // 'unified' | 'split'
  reviewFilter: { unreviewed: true, approved: true, needs_changes: true, on_hold: true }, // 表示するハンクをステータス別に絞り込むチェックボックス群の状態
  focusedHunkIndex: -1,      // キーボードフォーカス中のハンクインデックス
};
```

---

### Character encoding detection

`decodeAuto(buffer: ArrayBuffer)` が中心的な関数です。

```
ArrayBuffer
     │
     ├─ UTF-8 BOM あり → UTF-8 確定
     ├─ TextDecoder('utf-8', {fatal:true}) 成功 → UTF-8 確定
     └─ 失敗 → scoreShiftJis(bytes) と scoreEucJp(bytes) を比較
               → スコアの高い方を採用 (Shift_JIS or EUC-JP)
```

スコアリングは、各文字コードで有効な多バイトシーケンスの出現頻度をバイト列から計算します。

---

### localStorage helpers

プロジェクト・レビュー状態・メモ・ファイル内容の読み書きを担います。

**主要関数:**

| 関数 | 説明 |
|---|---|
| `loadProjects()` | プロジェクト一覧を配列で返す |
| `saveProjects(projects)` | プロジェクト一覧を保存 |
| `loadAllReviews()` | `{ projectId: { filePath: { hunkHash: 'approved' \| 'needs_changes' \| 'on_hold' } } }` 形式で返す（キーが無ければ未レビュー） |
| `saveAllReviews(reviews)` | レビュー状態を保存 |
| `loadAllMemos()` | `{ projectId: MemoItem[] }` 形式で返す |
| `saveAllMemos(memos)` | メモを保存 |
| `loadFileContent(projectId)` | diff テキスト本文を返す |
| `saveFileContent(projectId, text)` | diff テキスト本文を保存 |
| `deleteFileContent(projectId)` | diff テキスト本文を削除 |

`sanitizeReviewsData()` / `sanitizeMemosData()` / `sanitizeFilesData()` は localStorage の値が不正なフォーマットだった場合に安全なデフォルト値に戻すガード関数です。

---

### Diff parser

```javascript
parseDiff(text: string): Array<{filePath, hunks}>
```

**パースの流れ:**

```
入力: unified diff テキスト
  "diff --git a/foo b/foo"  → 新しいファイルエントリを開始
  "+++ b/foo"               → filePath を確定（rename 対応）
  "@@ -1,5 +1,6 @@"        → 新しいハンクを開始
  " " / "+" / "-" / "\"    → ハンクに行を追加
  次の "diff --git" / EOF   → ハンクとファイルを確定 (commit)
```

各ハンクは `{ header: string, lines: string[] }` の形式です。ハンクの確定時に `splitLargeHunk()` が呼ばれ、行数が多いハンクは複数に分割されます。

---

### Large-hunk splitting

`splitLargeHunk(hunk)` は、1 ハンクの行数が多い場合に「変更なし行のまとまり」を境にサブハンクへ分割します。これにより UI 上で大量の unchanged 行を持つハンクが扱いやすくなります。

分割後の各サブハンクには、元のハンクヘッダ情報から正確な `@@ -oldStart,oldCount +newStart,newCount @@` が再計算されます（`splitLargeHunk()` 内のインラインロジックで処理されます）。

---

### Syntax highlighting helpers

**言語検出:**

```javascript
detectLanguage(filePath: string): string | null
```

`filePath` の拡張子から highlight.js の言語 ID を返します。対応していない拡張子は `null`（プレーンテキスト表示）。

**ハイライト処理:**

```javascript
highlightHunkLines(lines: string[], language: string, filePath: string): string[] | null
```

ハンク内の `+` / `-` / ` ` 行のテキスト部分をまとめて highlight.js でハイライトし、行ごとの HTML を返します。`<span>` タグが行をまたいで開いていた場合は `splitHighlightedLines()` が正しく閉じ/開きを挿入します。

---

### Hashing

各ハンクの同一性判定に使うハッシュは、**ハンクの内容行（`@@` ヘッダを除く）のテキスト**を入力として計算されます。

```javascript
async sha256hex(text: string): Promise<string>   // Web Crypto または djb2hex フォールバック
async computeAllHashes(files: Array): Promise<void>  // 全ハンクに hash を付与
```

- `sha256hex()` は Web Crypto API (`crypto.subtle`) が使える環境では SHA-256 を使用
- `file://` プロトコルなど Crypto API が使えない場合は `djb2hex()` にフォールバック
- `computeAllHashes(files)` が `parsedDiff` の全ファイル・全ハンクに対して `sha256hex()` を呼び出し、`hunk.hash` にセットします

同じ内容のハンクは行番号が変わっても同じハッシュになるため、diff が更新されてもレビュー済み状態が引き継がれます。

---

### Render: sidebar project list

```javascript
renderProjectList()
```

`loadProjects()` で取得したリストを `sortProjects()` でソートし、サイドバーの `#project-list` に DOM を構築します。現在アクティブなプロジェクト (`app.currentProjectId`) には `active` クラスが付与されます。File System Access API が利用可能なプロジェクトには「🔃 再読み込み」ボタンが表示されます。

---

### Render: full diff view

```javascript
renderDiff()
```

`app.parsedDiff` を元に `#diff-container` を再構築します。

```
renderDiff()
  │
  ├─ app.parsedDiff が null → 空状態表示して終了
  │
  ├─ for each file:
  │     ├─ isReviewFilterActive(filter) が true かつ、絞り込み条件に合うハンクが1つも無い → ファイルごとスキップ
  │     │  （表示フィルタのチェックボックス「未レビュー/承認/要修正/保留」で選ばれたステータスのみ表示）
  │     ├─ file-section > file-header を生成
  │     └─ for each hunk:
  │           ├─ hunkPassesReviewFilter(status, filter) が false → スキップ
  │           └─ buildHunkCard(filePath, hunk, status, language) → section に追加
  │
  ├─ setOverallProgress()   全体進捗バーを更新（承認/要修正/保留の内訳付き）
  └─ setFocusedHunk(0)      キーボードフォーカスをリセット
```

---

### Build a single hunk card

```javascript
buildHunkCard(filePath, hunk, status, language): HTMLElement
```

`status` は `'approved' | 'needs_changes' | 'on_hold' | null`（`null` = 未レビュー）。カードには `status-approved` 等のクラスが付き、`status === 'approved'` のときのみ初期状態で折りたたまれます。

1 つのハンクを表すカード要素を生成します。

**内部処理:**

1. `computeLineRecords(hunk)` — 行ごとに `{ type, content, oldLabel, newLabel }` を計算
2. `highlightHunkLines()` — syntax highlight HTML を生成（`language` が null の場合はスキップ）
3. `REVIEW_STATUSES` から承認/要修正/保留の3ボタン（`.review-status-group`）を生成。クリックで `setHunkReviewStatus()` を呼び出し、既にアクティブなボタンをもう一度押すと未レビューに戻る
4. Unified / Split の分岐で異なる `<table>` 構造を構築
5. キーワードハイライト (`applyKeywordHighlight()`) を適用

**Unified 表示の行構造:**

```html
<tr class="line-added | line-removed | line-context">
  <td class="line-num old">旧行番号</td>
  <td class="line-num new">新行番号</td>
  <td class="line-prefix">+/-/ </td>
  <td class="line-content">...</td>
</tr>
```

**Split（サイドバイサイド）表示の行構造:**

1 つの diff 行が `computeLineRecords` の結果から旧ファイル側と新ファイル側に分離されます。詳細は [サイドバイサイド表示の仕組み](#サイドバイサイド表示の仕組み) を参照。

---

### Keyboard navigation

```javascript
// j → 次のハンク、k → 前のハンク
// Space → レビュー状態を 未レビュー → 承認 → 要修正 → 保留 → 未レビュー… の順で循環
// 1 / 2 / 3 → 承認 / 要修正 / 保留 を直接設定（同じ状態をもう一度押すと未レビューに戻る）
getHunkCards(): NodeList     // 現在レンダリング中のハンクカード一覧
setFocusedHunk(index)        // フォーカスを index に移動してスクロール
cycleFocusedHunkStatus()     // Space の処理
setFocusedHunkStatus(value)  // 1/2/3 の処理
```

フォーカス中のハンクカードには `focused` クラスが付きます。フォーム入力中・モーダル表示中はイベントを無視します。キーとステータスの対応は `REVIEW_STATUSES`（Storage keys セクション付近）で一元管理されています。

---

### Review memos

`#memo-panel`（`.layout` 内、`.main` の右隣に配置）で管理されるプロジェクト単位のチェックリストメモです。

```
MemoItem: { id: string, text: string, done: boolean, createdAt: number, updatedAt: number }
```

`loadAllMemos()` / `saveAllMemos()` で `SK_MEMOS` キーに保存されます。メモは diff の特定ファイルやハンクには紐付いておらず、プロジェクト全体に対するフリーメモです。

メモ入力欄は複数行入力に対応した `<textarea>`（`maxlength="5000"`）で、長文やコードの貼り付けにも対応します。`Ctrl+Enter`（macOS では `Cmd+Enter`）でも「追加」ボタンと同じくメモを追加できます（`#memo-input` の `keydown` リスナーが `#memo-add-form` を `requestSubmit()`）。パネル左端の `#memo-panel-resizer` ハンドルをドラッグすると Pointer Events（`initMemoPanelResizer()`）でパネル幅を変更できます（幅は `localStorage` には保存されず、セッション内のみ有効）。

**メモの編集:** 各メモ項目の ✏ ボタン（`.memo-item-edit`）をクリックすると、そのメモだけがインライン編集フォーム（`.memo-edit-form`、`buildMemoEditForm()`）に切り替わります。編集中のメモ ID はモジュール変数 `editingMemoId` に保持され、`renderMemoList()` はこの ID を持つメモだけ通常表示の代わりに編集フォームを描画します（他のメモは通常どおり一覧表示のまま）。フォーム内の `<textarea>` は開くと自動的にフォーカスされ、カーソルは末尾に置かれます。追加フォームと同様に `Ctrl+Enter`（`Cmd+Enter`）で保存、`Escape` でそのメモの編集だけをキャンセルします（`stopPropagation()` により、パネル全体を閉じる `document` レベルの `Escape` ハンドラーへは伝播しません）。保存は `editMemo(memoId, text)` が行い、`text` をトリムして空でなければ `text` と `updatedAt` を更新し `saveAllMemos()` で永続化します（空文字列の場合は保存せず編集状態のまま）。`editingMemoId` はパネルを閉じたとき（`closeMemoPanel()`）とプロジェクト切替時・表示モード切替時（`refreshMemoUI()`）にリセットされ、別のメモや別プロジェクトの一覧を開いたときに編集フォームが残らないようにしています。

**表示モード（issue #57）:** ビューポート幅が `WIDE_LAYOUT_MEDIA_QUERY`（`(min-width: 1200px)`、CSS 側は同値の `@media (min-width: 1200px)`）以上のときはスライドオーバーレイではなく、`.layout` の3番目のflexカラムとして右側に常時ドッキング表示されます。この場合 `#memo-toggle-btn` と `#memo-panel-close` は CSS で常に非表示になります（`.open` クラスの有無に関わらず、パネル自体は常時ドッキング表示のため開閉トリガー・閉じるボタンが不要）。`isMemoPanelOpen()` は `WIDE_LAYOUT_MEDIA_QUERY.matches` を優先して true を返します。`#memo-toggle-btn` が非表示のため `openMemoPanel()` は呼ばれず、`aria-hidden` の同期は `refreshMemoUI()` が `isMemoPanelOpen()` の結果に基づいて行います（`init()` 完了時・プロジェクト切替時・ブレークポイントをまたいだ `WIDE_LAYOUT_MEDIA_QUERY` の `change` イベント時に呼ばれる）。ドッキング表示中は Escape キーでのクローズを無効化し（常時表示のため閉じる概念がない）、j/k/Space のハンク操作ショートカットは「フォーカスが `#memo-panel` 内にあるか」で判定するよう変更されています（`isMemoPanelOpen()` ではなく `document.getElementById('memo-panel').contains(e.target)`）。これは、ドッキング時は常時 `isMemoPanelOpen() === true` になるため、パネル外にフォーカスがあってもハンク操作を無効化してしまわないようにするためです。

---

### Export / Import

`exportAppData()` は `buildExportData()` で組み立てた以下の JSON 構造をファイルとしてダウンロードします。

```json
{
  "schemaVersion": 4,
  "exportedAt": "2026-08-12T00:00:00.000Z",
  "projects": [...],
  "reviews": {
    "projectId": { "filePath": { "hunkHash": "needs_changes" } }
  },
  "memos": { ... },
  "keywordCategories": [
    { "id": "kwcat_...", "keywords": "TODO,FIXME", "color": "#fff000" }
  ],
  "projectKeywordCategories": {
    "projectId": [
      { "id": "kwcat_...", "keywords": "HACK", "color": "#a0c4ff" }
    ]
  }
}
```

> **注意:** `gitLocalReview_files`（各プロジェクトの diff 本文）はエクスポートに含まれません。インポート後は元の diff ファイルを再度読み込む必要があります。

`importAppData(file)` はインポート時に同じ ID のプロジェクトを上書きし、それ以外の既存プロジェクトはそのまま保持します。`reviews` の値は `sanitizeReviewsData()` / `normalizeReviewStatus()` を経由するため、`schemaVersion: 1` 時代の古いエクスポート（値が真偽値 `true`）もインポート時に自動的に `'approved'` へ変換されます。`schemaVersion` 自体はインポート処理で参照されておらず、あくまで記録用の情報です。

`keywordCategories`（issue #58 で追加）は全体設定のキーワードハイライトのカテゴリ／色設定（`SK_KEYWORDS`、`loadGlobalKeywordCategories()`/`saveGlobalKeywordCategories()` 参照）です。`projectKeywordCategories`（issue #68 で追加、`schemaVersion: 4`）はプロジェクト毎のキーワードカテゴリ（`SK_PROJECT_KEYWORDS`）を `{ [projectId]: category[] }` の形でそのまま保持します。`mergeImportedKeywordCategories(rawGlobal, rawByProjectId)` は `keywordCategories` を同じ `id` のカテゴリで上書きし、`projectKeywordCategories` は各プロジェクトIDごとに同じ `id` のカテゴリを上書きします（いずれもそれ以外の既存カテゴリはそのまま保持、プロジェクトと同じマージ方針）。`schemaVersion: 2` 以前のエクスポートには `keywordCategories` が、`schemaVersion: 3` 以前には `projectKeywordCategories` が存在しませんが、`sanitizeKeywordCategories()` が非配列（`undefined` を含む）を空配列として扱うため、インポート時は何もマージされずスキップされるだけで安全です。

`mergeImportedData()` 自体はプロジェクト件数に依存せず `keywordCategories`/`projectKeywordCategories` を先にマージしますが、これが実際に効くのは `loadSettingsFromFolderOnStartup()` や `checkSettingsFileExternalChange()`（設定フォルダからの自動読み込み・外部変更検知）のように `mergeImportedData()` を直接呼ぶ経路のみです。手動インポートの `importAppData(file)` は、インポート対象のプロジェクトが0件の場合はキーワードカテゴリの有無に関わらず「インポート可能なプロジェクトが見つかりませんでした」で早期returnし `mergeImportedData()` 自体を呼ばないため、プロジェクトを1件も含まないJSONファイルをUIから手動インポートしてキーワードカテゴリだけ復元する、という使い方はできません。

---

### File System Access API — file handles

Chrome / Edge など `window.showOpenFilePicker` をサポートするブラウザ専用の機能です。

```javascript
const supportsFileSystemAccess = typeof window.showOpenFilePicker === 'function';
```

`FileSystemFileHandle` は JSON シリアライズ不可のため、`IndexedDB`（`gitLocalReview_handles` DB, `fileHandles` ストア）に保存します。

| 関数 | 説明 |
|---|---|
| `saveFileHandle(projectId, handle)` | IndexedDB に保存 |
| `loadFileHandle(projectId)` | IndexedDB から取得 |
| `deleteFileHandleRecord(projectId)` | IndexedDB から削除 |
| `refreshHandleIndex()` | `projectIdsWithHandles` Set を IndexedDB から再構築 |
| `verifyHandlePermission(handle, mode)` | パーミッション確認・要求 |

---

### File System Access API — directory handles & settings folder

フォルダハンドル（既定の開くフォルダ・設定保存先フォルダ）は同じ `gitLocalReview_handles` DB の `folderHandles` ストアに保存されます。

| キー定数 | 用途 |
|---|---|
| `FOLDER_KEY_OPEN` (`'defaultOpenFolder'`) | 「📂 Diff ファイルを開く」の既定フォルダ |
| `FOLDER_KEY_SETTINGS` (`'settingsFolder'`) | 設定の自動保存先フォルダ |

**設定フォルダの自動保存フロー:**

```
diff 読み込み / レビュー変更 / プロジェクト削除
          │
          └─ scheduleSettingsAutoSave()   (デバウンス)
                │
                └─ autoSaveSettingsToFolder()
                      │
                      ├─ 書き込み権限チェック（未許可） → showAutoSaveWarning() で警告表示、終了
                      ├─ 外部変更チェック（settingsFileKnownModified に保持している前回の mtime と比較）
                      │     └─ 変更あり → 上書きをスキップして通知（showSettingsExternalUpdateNotice()）
                      └─ buildExportData() → git-local-review-settings.json に書き込み
                            ├─ 成功 → hideAutoSaveWarning()
                            └─ 例外 → showAutoSaveWarning()
```

外部変更の検知は `startSettingsExternalChangeWatcher()` が 1 分ごとに行います。

**自動保存状態の警告（issue #60）:** `#autosave-warning-banner`（トップバー直下・画面上部に常時表示可能なバナー）は、保存先フォルダが設定されているにもかかわらず自動保存が実行できていない場合（書き込み権限が許可されていない、または書き込み時に例外が発生した場合）に表示されます。`showAutoSaveWarning(message)` / `hideAutoSaveWarning()` が表示・非表示とメッセージ文言を切り替え、バナーが占める高さ（`AUTOSAVE_WARNING_HEIGHT_PX`）は CSS カスタムプロパティ `--autosave-warning-height` 経由で `.layout` の高さ計算に反映されます。以下の経路で状態が更新されます。

- `autoSaveSettingsToFolder()`: 書き込み権限が無い、または書き込みが例外で失敗した場合に表示。成功時は非表示
- `saveSettingsToFolder()`（サイドバー（メイン画面）の「設定を保存」ボタンによる手動保存。#61 でサイドバーから設定モーダルへ一時移動していたが、その後サイドバーへ戻された）: 自動保存と同じ書き込み経路を使うため、失敗時は同様に表示（`alert()` に加えて表示）。成功時は非表示

**手動保存時の外部変更チェック（issue #70）:** `saveSettingsToFolder()` は書き込み直前に `statSettingsFile()` で現在の設定ファイルの `lastModified`（ファイルが無ければ `null`）を取得し、`settingsFileKnownModified`（前回このタブが保存/読込した時点の値。未読込なら `null`）と比較します。一致しなければ `confirm()` で上書きの可否をユーザーに確認します。この不一致は「他の環境で更新された」だけでなく、`currentModified === null` なら「他の環境で削除された」、`settingsFileKnownModified === null` なら「他の環境で新規作成された」ケースもあり得るため、ダイアログの文言は3パターンを判定して出し分けます。

- キャンセルした場合: 保存を中止し、`showSettingsExternalUpdateNotice()` を呼んでサイドバーの外部変更通知（「読み込む」導線）を表示する
- 続行した場合: 通常通り上書き保存する

`autoSaveSettingsToFolder()` も同じ比較を行いますが、そちらはユーザー操作を伴わない自動実行のため常に無言でスキップします。手動保存は明示的なユーザー操作であるため、`confirm()` でユーザーの最終判断に委ねる点が異なります。
- `refreshSettingsFolderUI()`: フォルダ選択・解除時、および `init()` 起動時に、実際の保存試行を待たずプロアクティブに書き込み権限を確認し、表示状態を同期

このバナーは「保存先フォルダが未設定」の場合や、外部変更検知による意図的なスキップ（`showSettingsExternalUpdateNotice()` が既に専用の通知とアクションを提供している）では表示されません。前者は警告対象外、後者は失敗ではなく想定内の一時停止のためです。

---

### File loading

```javascript
async loadDiffFiles(files: File[], encodingPref?: string, fileHandles?: FileSystemFileHandle[]): Promise<void>
async loadFile(file: File, fileHandle?: FileSystemFileHandle, encodingPref?: string): Promise<void>
```

各イベントリスナー（ファイル選択・ドロップ・再読み込みボタン）が個別に `loadDiffFiles()` を呼び出し、`loadDiffFiles()` がループで各ファイルに対して `loadFile()` を呼び出す構成です。設定ファイルからの復元など一部の経路は直接 `loadFile()` を呼び出します。

**同名ファイルの衝突検出:**

```javascript
projectsByFileName(fileName): Project[]
```

同じ `fileName` を持つ既存プロジェクトがある場合、`showConflictModal()` でユーザーに上書きか新規作成かを選択させます。

---

### Initialise

```javascript
(async function init() { ... })();
```

ページロード時に一度だけ実行されます。

```
init()
  │
  ├─ loadViewMode() → updateViewModeButtons()
  ├─ reviewFilter（表示フィルター）の復元
  ├─ refreshHandleIndex()
  ├─ [File System Access 対応ブラウザのみ]
  │     ├─ refreshOpenFolderUI()
  │     ├─ refreshSettingsFolderUI()
  │     ├─ loadSettingsFromFolderOnStartup()   設定ファイルがあれば自動読み込み
  │     └─ startSettingsExternalChangeWatcher()
  ├─ renderProjectList()
  └─ 最後に開いていたプロジェクトを復元 (SK_CURRENT → restoreProjectDiff)
```

---

## 状態管理の全体像

```
┌─────────────────────────────────────────────────────┐
│                    ブラウザメモリ                      │
│  app.currentProjectId                               │
│  app.parsedDiff                                     │
│  app.viewMode                                       │
│  app.reviewFilter                                   │
│  app.focusedHunkIndex                               │
│  app.fileProgressEls (DOM 参照キャッシュ)             │
└─────────────────────────────────────────────────────┘
          ↕ read/write
┌─────────────────────────────────────────────────────┐
│                  localStorage                        │
│  gitLocalReview_projects      プロジェクト一覧        │
│  gitLocalReview_reviews       レビュー状態（承認等）  │
│  gitLocalReview_memos         レビューメモ            │
│  gitLocalReview_files         diff テキスト本文       │
│  gitLocalReview_currentProject 最後に開いた ID        │
│  gitLocalReview_viewMode      表示モード              │
│  gitLocalReview_reviewFilter  表示フィルター設定       │
│  gitLocalReview_projectSort   並び順                 │
│  gitLocalReview_keywords      キーワードカテゴリ配列  │
│                                （全体設定）             │
│  gitLocalReview_projectKeywords キーワードカテゴリ    │
│                        （プロジェクトID → 配列）      │
└─────────────────────────────────────────────────────┘
          ↕ read/write（File System Access API 対応のみ）
┌─────────────────────────────────────────────────────┐
│               IndexedDB                              │
│  fileHandles   プロジェクトID → FileSystemFileHandle  │
│  folderHandles 'defaultOpenFolder' / 'settingsFolder' │
└─────────────────────────────────────────────────────┘
          ↕ read/write（File System Access API 対応のみ）
┌─────────────────────────────────────────────────────┐
│              ローカルファイルシステム                  │
│  git-local-review-settings.json  (設定自動保存先)     │
└─────────────────────────────────────────────────────┘
```

---

## ハンクの同一性判定 (hunk hash)

diff ファイルが更新されると行番号がずれることがありますが、ハンクの内容（`+`/`-`/` ` で始まる行のテキスト）が同じであれば「レビュー状態」が引き継がれます。

```
hunk.lines（例: ["-old line", "+new line", " context"]）
     │
     └─ sha256hex(text)  ← Web Crypto または djb2hex (フォールバック)
           │              ※ computeAllHashes(files) が全ハンクに適用
           └─ hex 文字列 → hunk.hash として保存

レビュー状態の保存形式:
  reviews[projectId][filePath][hunk.hash] = 'approved' | 'needs_changes' | 'on_hold'
  （キーが存在しなければ未レビュー）
```

この設計により、`git rebase` や `git merge` で行番号が変化しても、変更内容が同じハンクは正しく元のレビュー状態と紐付きます。

---

## サイドバイサイド表示の仕組み

`buildHunkCard()` 内で `app.viewMode === 'split'` のときに使われます。

`computeLineRecords(hunk)` の結果をいったん全行フラットな配列として持ち、その後以下のように旧ファイル側と新ファイル側のペアに組み立てます。

```
diff 行                旧ファイル列       新ファイル列
────────────────────  ─────────────────  ─────────────
" context"            行番号 + テキスト  行番号 + テキスト
"-removed"            行番号 + テキスト  （空）
"+added"              （空）             行番号 + テキスト
```

`-` 行と `+` 行が連続して現れる場合は同一行の変更とみなし、同じ `<tr>` の左右に並べます（`buildSplitTbody()` 内のペアリングロジック）。

---

## ファイル読み込みの全フロー

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ load-btn     │  │ drag & drop  │  │ reload-btn   │
│ (file input) │  │ (drop event) │  │ (handle)     │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │          filesFromDataTransfer()  │
       │                 │                 │
       └─────────────────┴─────────────────┘
                         │
                         ▼
               loadDiffFiles(files, encodingPref, handles)
                         │
                    for each file
                         │
                         ▼
                    loadFile(file, ...)
                         │
              ┌──────────┴──────────┐
              │                     │
         decodeAuto()          parseDiff()
         (文字コード判定)      (diff パース)
              │                     │
              └──────────┬──────────┘
                         │
              ├─ computeAllHashes()  ハンクハッシュ計算
              │
              projectsByFileName() で衝突確認
                         │
              ┌──────────┴──────────┐
              │                     │
         衝突なし                衝突あり
              │                     │
         新規プロジェクト      showConflictModal()
         として保存           (ユーザー選択待ち)
              │
              ▼
         renderDiff() / renderProjectList()
```

---

## よくある修正パターン

### 新しい localStorage キーを追加する

1. `Storage keys` セクションに `SK_XXX = 'gitLocalReview_xxx'` を追加
2. 対応する `loadXxx()` / `saveXxx()` 関数を `localStorage helpers` セクションに追加
3. `sanitize` 関数が必要な場合はあわせて追加

### 新しい言語のシンタックスハイライトを追加する

1. `detectLanguage()` の `extMap` オブジェクトに拡張子と highlight.js 言語 ID を追加
2. highlight.js 本体がその言語に対応しているか確認（inline 同梱のため、非対応の場合はバンドルを差し替える必要あり）

### diff パーサーを変更する

`parseDiff()` を変更する際は、`splitLargeHunk()` と `computeLineRecords()` も合わせて確認してください。これらは連携してハンクの構造を扱っています。

### レビュー状態の構造を変更する

`REVIEW_STATUSES` / `VALID_REVIEW_STATUS_VALUES`、`normalizeReviewStatus()`、`sanitizeReviewsData()` のバリデーションロジックを同時に変更してください。`setHunkReviewStatus()` / `buildHunkCard()`（ステータスボタン生成・カードの `status-*` クラス）、`renderDiff()` の `hunkPassesReviewFilter()`、`refreshProgress()` / `setOverallProgress()` の集計ロジックも合わせて確認が必要です。旧形式からの移行が必要な場合は `normalizeReviewStatus()` に変換ルールを追加し、`buildExportData()` の `schemaVersion` を上げて変更点をコメントに残すと良いでしょう（`schemaVersion` 自体はインポート時に参照されず記録用です）。

### 設定モーダルへ新しい設定項目を追加する（issue #61）

既定のフォルダ・保存先フォルダ・文字コード・キーワードカテゴリの設定 UI は `#settings-modal-overlay`（`.settings-modal-body` 内）にまとまっています。新しい設定項目を追加する場合:

1. 対象の要素（行）を `.settings-modal-body` 内に追加する。既存要素は `id` をそのまま維持しているため、対応するイベントリスナーは DOM 上の位置に関わらずそのまま動作する（`getElementById()` ベースのため）
2. モーダルの開閉自体は `openSettingsModal()` / `closeSettingsModal()` / `isSettingsModalOpen()` が管理しており、新しい設定項目側で個別に開閉処理を書く必要はない
3. モーダルを開いた状態でキーボードショートカット（j/k/Space 等）や Escape キーが正しく無効化/有効化されるかは、`isSettingsModalOpen()` を参照している箇所（`keydown` リスナー、ドラッグ&ドロップの読み込みガード）で担保されている。新しい設定項目の追加だけであれば、通常この部分の変更は不要

---

> このドキュメントは `index.html` を修正した際に合わせて更新してください（詳細は [CLAUDE.md](../CLAUDE.md) 参照）。
