# Working on Tableloom

- README.md is the source of truth for project goals, the single work queue, and material current limitations. Read it first; update checklist status/scope in the same change as implementation. Keep it a normal, concise README (roughly 100–150 lines), not an implementation diary.
- Put detailed behavior/API/upgrade notes in docs/platform.md, usage/hosting details in docs/user-guide.md, and concise chronological changes/verification/limitations in docs/progress.md. Read only relevant reference sections; historical “next” steps are not the current queue.
- Choose the highest-priority actionable unchecked item. Complete a coherent, reviewable increment; do not mark partially implemented work complete.
- Use TypeScript with strict checks. Validate data at network and persistence boundaries.
- Keep core concepts system-neutral. Do not put HP, initiative, classes, turns, attacks, or a particular attribute model in core.
- Game systems are separately versioned trusted code packages. Browser UI, shared rules/data, and server-only code have separate entry points. Never import server-only modules into the browser.
- No rulebooks have been supplied yet. System packages are scaffolds, not implementations of their published rules. Do not invent mechanics or catalog content. Record source edition/page references when supplied.
- Prefer small explicit contracts to a visual rules builder. Distinguish content definitions from owned instances.
- Server decides persistent state and dice outcomes. Never transmit future GM-only content to unauthorized clients.
- Preserve user changes. No deployment, publishing, or destructive Git operations unless authorized.
- The user explicitly authorized GitHub pushes on 2026-11-04. Commit each coherent verified increment (including its README update), then push that commit to `origin` on the current branch. If a push fails, resolve or report it before creating another commit. Never force-push or overwrite user work.
- Run `npm run check` for cross-cutting changes; use targeted checks for isolated changes. Add meaningful tests for state transitions, permissions, persistence, migrations, and rules.
- Finish each increment by updating docs/progress.md with verification and remaining limitations, and the README task list when status or scope changes. Do not append progress logs, test inventories or implementation minutiae to the README. Do not create a second work queue.
