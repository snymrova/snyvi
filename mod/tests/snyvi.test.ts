import { test, expect } from 'claude-code/testing'
import { sawIn, ciOf } from '../hooks/register.tsx'

test('a new branch, a commit and a PR are seen from git and gh', () => {
  expect(sawIn('git switch -c claude/threads', '')).toEqual({ branch: 'claude/threads' })
  expect(sawIn('git worktree add ~/Projects/snyvi-threads -b claude/threads main', '')).toEqual({ branch: 'claude/threads' })
  expect(sawIn('git commit -m "x"', '[claude/threads 80fa98c] Threads in the store\n 3 files changed')).toEqual({ branch: 'claude/threads', commits: 1 })
  expect(sawIn('git commit -m "x"', 'nothing to commit, working tree clean')).toBe(null)
  expect(sawIn('gh pr create --fill', 'https://github.com/o/r/pull/57\n')).toEqual({ pr: '57' })
  expect(sawIn('git status', '')).toBe(null)
})

test('the checks are one word', () => {
  expect(ciOf([])).toBe('')
  expect(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }])).toBe('1/2')
  expect(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing')
  expect(ciOf([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])).toBe('failing')
})
