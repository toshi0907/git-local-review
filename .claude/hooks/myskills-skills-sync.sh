#!/bin/bash
# Claude Code on the web のセッション開始時に、myskills submodule
# (.myskills) を最新のリモート内容へ更新し、`.claude/skills/` 配下に
# 各スキルディレクトリへのsymlinkを(未作成のものだけ)張るフック。
#
# 前提となるリポジトリ構成(対象リポジトリ側で事前に一度だけ設定):
#   .myskills/          ... myskills を submodule として追加した場所
#   .claude/skills/      ... 実ディレクトリ。myskills由来のスキルは
#                            スキルごとの symlink として個別に登録する
#                            (`.claude/skills` 自体をsymlinkにはしない)
#
# `.claude/skills/<skill名>` がまだ存在しない場合のみ symlink を作成する。
# 対象リポジトリ固有のローカルスキルなど、既に同名のファイル/ディレクトリが
# 存在する場合は上書きしない。
#
# 設置方法:
#   1. このファイルを対象リポジトリの
#      .claude/hooks/myskills-skills-sync.sh にコピー
#   2. chmod +x .claude/hooks/myskills-skills-sync.sh
#   3. .claude/settings.json に settings.snippet.json の内容をマージ
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

if [ ! -f .gitmodules ] || ! grep -q '\.myskills' .gitmodules 2>/dev/null; then
  echo "myskills-skills-sync: .myskills submodule が見つかりません。スキップします。" >&2
  exit 0
fi

# submoduleの更新はClaude Code on the web(使い捨て環境)でのみ自動実行する。
# ローカル(永続環境)は明示的な `git submodule update --init --remote` を想定しており、
# ここで更新される内容はコミットしない(次回セッションでは改めて最新を取得する)。
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  # --remote: myskills側の最新コミットを取得する
  # --init:   初回clone直後でsubmoduleが未初期化でも動くようにする
  git submodule update --init --remote -- .myskills
  echo "myskills-skills-sync: submodule synced to $(git -C .myskills rev-parse --short HEAD)" >&2
fi

# `.claude/skills/` 配下に、myskills側の各スキルへのsymlinkを
# (未作成のものだけ)張る。ローカル/web共通で毎回実行して問題ない
# (既存のsymlink・ローカルスキルは一切上書きしない)。
mkdir -p .claude/skills

added=0
for skill_dir in .myskills/claude-skills/*/; do
  [ -d "$skill_dir" ] || continue
  name="$(basename "$skill_dir")"
  target=".claude/skills/$name"

  # 同名のファイル/ディレクトリ/symlink(壊れているものも含む)が
  # 既に存在する場合は上書きしない。
  if [ -e "$target" ] || [ -L "$target" ]; then
    continue
  fi

  ln -s "../../.myskills/claude-skills/$name" "$target"
  added=$((added + 1))
done

if [ "$added" -gt 0 ]; then
  echo "myskills-skills-sync: ${added}件のスキルsymlinkを .claude/skills/ に追加しました" >&2
fi
