import { test, expect, mock } from 'claude-code/testing'
import { sawIn, ciOf, prSighting, nextRoundIn } from '../hooks/register.tsx'

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

test('a PR sighting is filed only when the checks or the merge differ, and a closed PR settles the watch', () => {
  const running = { state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }] }
  expect(prSighting(running, {})).toEqual({ seen: { ci: '1/2' }, settled: false })
  expect(prSighting(running, { ci: '1/2' })).toEqual({ seen: null, settled: false })
  const merged = { state: 'MERGED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], mergeCommit: { oid: 'abc1234' } }
  expect(prSighting(merged, { ci: '1/2' })).toEqual({ seen: { ci: 'passing', merged: 'abc1234' }, settled: true })
  expect(prSighting(merged, { ci: 'passing', merged: 'abc1234' })).toEqual({ seen: null, settled: true })
  expect(prSighting({ state: 'CLOSED', statusCheckRollup: [] }, {})).toEqual({ seen: null, settled: true })
})

test('a round goes again at once on a band or a held call, and waits out a failure', () => {
  expect(nextRoundIn({ status: 200 })).toBe(0)
  expect(nextRoundIn({ status: 204 })).toBe(0)
  expect(nextRoundIn({ status: 500 })).toBe(30_000)
  expect(nextRoundIn(null)).toBe(30_000)
})

test('the band round sends the tag it has, and the next round the tag it was given', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { SNYVI_SESSION: 'a'.repeat(32) })
  on('fs.read', (_, e) => ({ value: e.path.endsWith('snyvi.json') ? JSON.stringify({ url: 'http://d', token_file: '/t' }) : 'tok\n' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const urls: string[] = []
  // A band, then a daemon that is away: the second round goes at once with
  // the tag the first was given, and the third waits half a minute. (A 204
  // chains at once too, as `nextRoundIn` says; two rounds answered at once
  // in a row do not settle under the mocked clock, so it is not staged here.)
  const answers = [
    { status: 200, text: JSON.stringify({ v: 'abc12345', line: '▸ A · working', thread: null, waiting: 0, turns: [] }) },
    { status: 500, text: '' },
  ]
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    const a = answers[Math.min(urls.length, answers.length) - 1]
    return { value: { status: a.status, ok: a.status < 300, headers: {}, text: a.text } }
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const band = `http://d/api/panes/${'a'.repeat(32)}/band?v=`
  expect(urls).toEqual([band, `${band}abc12345`])
  await clock.advance(29_000)
  expect(urls.length).toBe(2)
  await clock.advance(1_000)
  expect(urls).toEqual([band, `${band}abc12345`, `${band}abc12345`])
})
