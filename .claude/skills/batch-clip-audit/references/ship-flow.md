# Ship Flow — Phase D 详细步骤

阿杜审 REPORT.md 回「通过」后执行。

## 整体步骤

```
8.0 (前置): .gitignore 加 ".claude/<site>-batch-<listId>/" — Phase A 内已加
8.1 抢 ship lock
8.2 cd 回 main + rsync 代码 worktree → main
8.3 rsync audit artifacts → main 的 .claude/<site>-batch-<listId>/ (不进 git)
8.4 git add 代码 + .gitignore → git commit
8.5 sanity check (npm test + npm run test:e2e + npm run build:chrome)
    失败 → 回滚 commit + 回 Fix Loop
8.6 git push adu
8.7 释 ship lock
8.8 清 worktree
8.9 写 step-ship.md
8.10 报阿杜「ship 完毕」+ artifact 路径
```

## 命令样例（cbex 任务复用）

### 8.1 抢 ship lock

```bash
cd /Users/adu/Workspace/github/obsidian-clipper/obsidian-clipper-cn

node -e "
const fs = require('fs');
const path = '.ship-lock.json';
try {
  fs.writeFileSync(path, JSON.stringify({
    worktree: '<site>-batch-<listId>',
    startedAt: new Date().toISOString()
  }), { flag: 'wx' });
  console.log('LOCKED');
} catch (e) {
  console.error('ALREADY LOCKED:', fs.readFileSync(path, 'utf-8'));
  process.exit(1);
}
"
```

如已锁，按 [[feedback_ship_lock_mechanism]] FIFO 等待。

### 8.2 rsync 代码 worktree → main

按 site 改文件列表。cbex 案例：

```bash
WT=.claude/worktrees/cbex-batch-audit
for f in \
  src/utils/cbex-extractor.ts \
  src/utils/cbex-extractor.test.ts \
  src/utils/cbex-extractor.e2e.test.ts \
  src/utils/cbex-list-fetcher.test.ts \
  src/utils/cbex-audit-validator.test.ts \
  src/utils/cbex-audit-report.test.ts \
  src/utils/fixtures/cbex-prj_li-p1.html \
  src/content.ts \
  scripts/e2e-clip-runner.ts \
  scripts/cbex-list-fetcher.ts \
  scripts/cbex-audit-validator.ts \
  scripts/cbex-audit-report.ts \
  scripts/cbex-batch-audit.ts \
  tsconfig.json \
  .gitignore; do
  cp "${WT}/${f}" "${f}"
done
```

### 8.3 rsync artifacts → main `.gitignored` 目录

```bash
mkdir -p .claude/cbex-batch-<listId>
rsync -a --delete "${WT}/.claude/cbex-batch-<listId>/" .claude/cbex-batch-<listId>/

ls .claude/cbex-batch-<listId>/  # 验证 artifacts 同步
git status --short .claude/cbex-batch-<listId>/  # 应该为空（已 ignore）
```

### 8.4 git add + commit

```bash
git add \
  src/utils/cbex-extractor.ts \
  src/utils/cbex-extractor.test.ts \
  ... \
  .gitignore

git commit -m "$(cat <<'EOF'
feat(<site>): wire build<Site>Frontmatter + batch audit tool + <listId> audit N/N PASS

Phase A — Extractor wire:
- <详述 wire 改动>

Phase B — Batch audit tool:
- scripts/<site>-list-fetcher.ts: ...
- scripts/<site>-audit-validator.ts: N-point audit
- scripts/<site>-audit-report.ts: REPORT.md generator
- scripts/<site>-batch-audit.ts: CLI orchestrator

Phase C — <listId> audit run:
- audit artifacts (REPORT.md + N markdown + step-reports + ids.json) 保留在
  .claude/<site>-batch-<listId>/，不进 git (.gitignore 已加规则)
- Round 数: <N> / 自动修复 commit 数: <M> / 决策声明: 擅自降级 0 / 偷懒 0 / 妥协 0
- 阿杜审过 REPORT.md 后 ship

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### 8.5 Sanity check

```bash
npm test && npm run test:e2e -- src/utils/<site>-extractor.e2e.test.ts && npm run build:chrome
```

任一失败 → `git reset HEAD~1` + 回 Fix Loop。

### 8.6 git push adu

```bash
git push adu main
```

按 [[user_collab_norms]]：可主动 push adu。**禁** push origin。

### 8.7 释 ship lock

```bash
rm .ship-lock.json
```

### 8.8 清 worktree

```bash
git worktree remove .claude/worktrees/<site>-batch-<listId>
git branch -D <site>-batch-<listId>

ls .claude/worktrees/  # 应该不包含此 worktree
ls .claude/<site>-batch-<listId>/  # artifacts 保留（独立 filesystem path）
```

### 8.9 写 step-ship.md

按 step-report-template.md 格式。含 ship commit SHA + artifact 路径 + worktree 清理确认。

### 8.10 报阿杜

```
[ship 完毕]

代码同步到 main + push adu 成功：
- commit SHA: <git rev-parse main>
- remote: adu/main (https://github.com/RalphAdu/obsidian-clipper-cn)

Audit artifacts 持久保留（不进 git）：
- 路径: .claude/<site>-batch-<listId>/
- 含: REPORT.md, ids.json, markdown/ (N 张), step-reports/

Worktree 已清理:
- .claude/worktrees/<site>-batch-<listId>/ 已删
- 分支 <site>-batch-<listId> 已删

任务完毕。
```

## 注意事项

### worktree 内的临时 commits

worktree 跑期间可能产生临时 / fix commits（cbex 任务 17 个）。ship 时 **rsync 文件**而非 cherry-pick commits — 让 main 产生 1 个干净的 ship commit，保留完整改动但不污染 main history。

cbex 任务实测：worktree branch 有 17 个 commits（含 fix loop iterations + tests + regression fixes）；main 上 ship commit 是 1 个干净 commit。worktree 清理后这些临时 commits 自动 gc。

### sanity check 失败回滚

如 sanity check 失败：

```bash
git reset HEAD~1     # 撤掉 ship commit（但保留 working tree 改动以便诊断）
git status           # 看哪些文件改动
# 诊断问题（可能 main 跟 worktree 有不一致改动 / sanity check 触发 race condition）
# 修后回 Fix Loop (Phase C Task 18)
```

### artifacts 路径独立

main 的 `.claude/<site>-batch-<listId>/` 跟 worktree 内同名路径是**两个独立 filesystem 路径**（git worktree 机制下 working tree 物理分开）。清理 worktree 不影响 main 内的 artifact 拷贝。

### ship lock 机制

`.ship-lock.json` 是 main 仓库根目录的 atomic lock（O_EXCL 写入）。同时只一个 worktree 能 ship。详 [[feedback_ship_lock_mechanism]]。
