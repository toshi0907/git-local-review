# CLAUDE.md — AI エージェント向けガイドライン

このファイルは AI エージェント（GitHub Copilot Coding Agent など）がこのリポジトリで作業する際の指針です。

---

## ドキュメント更新ルール

### `index.html` を修正するときは `docs/index.html.md` も更新すること

`index.html` に以下のような変更を加えた場合は、必ず [`docs/index.html.md`](docs/index.html.md) も同時に更新してください。

| `index.html` の変更内容 | `docs/index.html.md` で更新すべき箇所 |
|---|---|
| 新しいセクション（`// ──…──` 区切り）を追加・削除・改名 | 「JavaScript モジュール構成」の表を更新（出現順に追記・削除） |
| `app` オブジェクトにプロパティを追加・削除 | 「Application state」の説明を更新 |
| `localStorage` キーを追加・変更・削除 | 「Storage keys」および「状態管理の全体像」を更新 |
| IndexedDB のストア・キーを変更 | 「File System Access API」セクションおよび「状態管理の全体像」を更新 |
| `parseDiff()` / `splitLargeHunk()` / `computeLineRecords()` を変更 | 「Diff parser」「Large-hunk splitting」「Build a single hunk card」を更新 |
| ハンクハッシュの計算方法を変更 | 「ハンクの同一性判定」を更新 |
| エクスポート JSON 構造を変更 | 「Export / Import」を更新 |
| 新しい言語のシンタックスハイライトを追加 | 「Syntax highlighting helpers」の言語一覧を更新 |
| サイドバイサイド表示のロジックを変更 | 「サイドバイサイド表示の仕組み」を更新 |
| 全体的なデータフローが変わる変更 | 「データフロー」の図を更新 |
| `init()` の初期化手順を変更 | 「Initialise」を更新 |
| ファイル読み込みフローを変更 | 「ファイル読み込みの全フロー」の図を更新 |

> **軽微な変更**（バグ修正・変数名変更など、アーキテクチャや外部インターフェースに影響しないもの）については、ドキュメントの更新は任意です。

---

## コードスタイル

- `index.html` はビルドプロセスなしで動作するシングルファイルアプリです。外部モジュール・バンドラー・トランスパイラは使用しません。
- JavaScript は `'use strict';` モードで記述します。
- セクションの区切りは `// ─────────────────────────────────────────────────────────────────────────────` の罫線コメントを使用します。
- 新しい `localStorage` キーは必ず `SK_` プレフィックスの定数として `Storage keys` セクションに追加します。

---

## テスト

`test/` ディレクトリにテスト用の `.diff` サンプルファイルがあります。`index.html` の diff パーサーや表示ロジックを変更した際は、これらのサンプルで動作確認してください。
