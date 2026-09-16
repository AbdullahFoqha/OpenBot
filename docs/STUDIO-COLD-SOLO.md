# Studio cold solo ≤15m (P2.5)

End-to-end unattended autonomy demo on any registered product.

## How to run

```bash
# Prereq: ./studio start, product selected, Cursor logged in
node studio-local/ui-test/p25-cold-solo-prove.mjs
```

Stopwatch starts at `POST /api/studio/tasks` (Lead-equivalent clear AC) and stops at terminal task evidence.

## Pass

- Duration ≤ 15 minutes
- `ownerBotId=react-native-engineer`
- Terminal `in_review` (or `evidence.ok=true`)
- Worktree + changed files for the requested flag
- Typecheck/tests green when verify runs

See `ULTRA_DEMO.md` for the chat paste variant and Maestro stretch paths.
