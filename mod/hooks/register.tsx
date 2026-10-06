// The snyvi mod (#90): loaded only in a snyvi desk's panels, through the
// CLAUDE_CODE_PLUGIN_DIRS the daemon sets on the panel it starts, and the
// same version as the snyvi that wrote it (src/claude_mod.rs).
//
// It talks to one place, the local daemon, with the pane's own token, about
// the pane it runs in. It never starts a turn ($.prompt.submit), never
// approves or blocks a tool, and never changes what Claude asked or ran.
// When the daemon is away every call fails quietly to one status line, and
// Claude goes on as if there were no mod.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const band = atom({ plugin: 'snyvi', key: 'band' } as const, '')

/** Where the daemon is and the pane this session runs in; null outside a
 *  snyvi panel, where every hook passes straight through. */
type Link = { url: string; token: string; pane: string }
let link: Link | null = null
/** The pane's thread, as the band last read it: what the CI timer watches. */
let thread: { pr?: string; merged?: string; stage?: string } | null = null
let away = false

async function connect($: EngineInterface): Promise<Link | null> {
  const pane = await $.env.get('SNYVI_SESSION')
  if (!pane || !/^[0-9a-f]{32}$/.test(pane)) return null
  try {
    const cfg = JSON.parse(await $.fs.read(`${$.plugin.root}/snyvi.json`))
    const token = (await $.fs.read(cfg.token_file)).trim()
    return { url: cfg.url, token, pane }
  } catch {
    return null
  }
}

/** One call to the pane's own routes. Null when the daemon is away or said
 *  no; the status line says so once, and clears when it answers again. */
async function call(
  $: EngineInterface,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any } | null> {
  if (!link) return null
  try {
    const r = await $.http.fetch(`${link.url}/api/panes/${link.pane}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${link.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (away) {
      away = false
      $.ui.status(undefined)
    }
    let json: any = null
    try {
      json = r.text ? JSON.parse(r.text) : null
    } catch {}
    return { status: r.status, json }
  } catch {
    if (!away) {
      away = true
      $.ui.status('snyvi not reachable')
    }
    return null
  }
}

async function refresh($: EngineInterface) {
  const r = await call($, 'band')
  if (!r || r.status !== 200) return
  thread = r.json.thread
  const line: string = r.json.line || ''
  if (line !== (await read($, band))) await update($, band, () => line)
}

/** What a `git`/`gh` command did, read from the command and its output. */
export function sawIn(command: string, stdout: string): Record<string, unknown> | null {
  const c = command.replace(/\s+/g, ' ')
  const made = /\bgit (?:switch -c|checkout -b|worktree add(?: [^|;&]*)? -b) ([^\s;&|]+)/.exec(c)
  if (made) return { branch: made[1] }
  if (/\bgit commit\b/.test(c) && !/--dry-run/.test(c)) {
    const m = /^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\]/m.exec(stdout)
    if (m) return { branch: m[1], commits: 1 }
    return null
  }
  if (/\bgh pr create\b/.test(c)) {
    const m = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/.exec(stdout)
    if (m) return { pr: m[1] }
  }
  return null
}

/** The checks as one word: `9/13` while running, `passing`, `failing`. */
export function ciOf(rollup: Array<{ conclusion?: string; status?: string; state?: string }>): string {
  if (!rollup.length) return ''
  const done = rollup.filter(r => (r.status || 'COMPLETED') === 'COMPLETED' || r.state)
  const bad = rollup.some(r => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(r.conclusion || r.state || ''))
  if (bad) return 'failing'
  if (done.length < rollup.length) return `${done.length}/${rollup.length}`
  return 'passing'
}

async function watchPr($: EngineInterface) {
  if (!thread || !thread.pr || thread.merged) return
  let out
  try {
    out = await $.process.run(['gh', 'pr', 'view', thread.pr, '--json', 'state,statusCheckRollup,mergeCommit'])
  } catch {
    return
  }
  if (out.exitCode !== 0) return
  try {
    const j = JSON.parse(out.stdout)
    const seen: Record<string, unknown> = { ci: ciOf(j.statusCheckRollup || []) }
    if (j.state === 'MERGED' && j.mergeCommit?.oid) seen.merged = j.mergeCommit.oid
    await call($, 'seen', seen)
    await refresh($)
  } catch {}
}

/** Wait for the reader's answer in snyvi, a long-poll at a time, until there
 *  is one, the question is put away, or the hook is abandoned. */
async function answered($: EngineInterface, turn: number, signal: AbortSignal): Promise<string | null> {
  while (!signal.aborted) {
    const r = await call($, `turns/${turn}`)
    if (!r) return null
    if (r.status === 200 && r.json?.answer) return r.json.answer
    if (r.status !== 204) return null
  }
  return null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    link = await connect($)
    if (link) {
      await $.command.register({ name: 'note', description: 'Add a line to this desk’s notes, with no turn spent', argumentHint: '[text]', immediate: true })
      await $.command.register({ name: 'turn', description: 'What is waiting on you on this desk', immediate: true })
      await $.command.register({ name: 'park', description: 'Park this panel’s thread, with the next step', argumentHint: '[next step]', immediate: true })
      await $.command.register({ name: 'thread', description: 'This panel’s thread, in a few lines', immediate: true })
      await refresh($)
      $.clock.every(5_000, () => refresh($))
      $.clock.every(60_000, () => watchPr($))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = await read($, band)
    if (!link || !line) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{line}</Text>
      </Box>
    )
  })

  // Claude's own question, mirrored to Your turn in snyvi and answered from
  // either side: whichever answer comes first is the tool's result, and the
  // other side is told and closes. One question with single choice only; a
  // form of several is the terminal's.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const qs = e.questions || []
    if (!link || qs.length !== 1 || qs[0].multiSelect) return next(e)
    const q = qs[0]
    const asked = await call($, 'ask', {
      kind: 'decide',
      via: 'dialog',
      text: q.question,
      options: q.options.map(o => o.label),
    })
    if (!asked || asked.status !== 201) return next(e)
    const turn: number = asked.json.turn.id
    const native = next(e).then(r => ({ from: 'panel' as const, r }))
    const snyvi = answered($, turn, next.signal).then(a => ({ from: 'snyvi' as const, a }))
    // snyvi with no answer (put away, or the daemon gone) leaves the dialog
    // to settle it.
    const first = await Promise.race([native, snyvi.then(s => (s.a ? s : native))])
    if (first.from === 'snyvi') {
      $.ui.toast('Answered in snyvi')
      void refresh($)
      return { result: { questions: e.questions, answers: { [q.question]: first.a } } } as any
    }
    const a = (first.r as any)?.result?.answers?.[q.question]
    await call($, `turns/${turn}`, a ? { answer: String(a) } : { drop: true })
    void refresh($)
    return first.r
  }).catch(($, e, next) => next(e))

  // What git and gh did in the panel, seen after the command ran: a branch,
  // a commit, a PR. Observe only: the call and its result go on unchanged.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (!link) return r
    const command = String((e as any).command || '')
    if (!/\b(git|gh)\b/.test(command)) return r
    const seen = sawIn(command, String((r as any)?.result?.stdout || ''))
    if (seen) {
      await call($, 'seen', seen)
      void refresh($)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'note' }, async ($, e) => {
    const text = String(e.args || '').trim()
    if (!text) return { text: 'Usage: /note what to remember' }
    const r = await call($, 'note', { text })
    if (r?.status === 201) $.ui.toast(`Note #${r.json.note.id} added to the desk`)
    else $.ui.toast(r?.json?.error ? `Not added: ${r.json.error}` : 'snyvi is not reachable')
    return {}
  })

  on('command.run', { command: 'turn' }, async $ => {
    const r = await call($, 'band')
    const waiting: Array<{ kind: string; text: string }> = r?.json?.turns || []
    if (!waiting.length) $.ui.log('Nothing is waiting on you on this desk.')
    for (const w of waiting) $.ui.log(`your turn · ${w.kind} · ${w.text}`)
    return {}
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    const r = await call($, 'thread/move', { stage: 'parked', next: String(e.args || '').trim(), reader: true })
    if (r?.status === 200) $.ui.toast(`Parked: ${r.json.thread.name}`)
    else $.ui.toast(r?.json?.error || 'snyvi is not reachable')
    void refresh($)
    return {}
  })

  on('command.run', { command: 'thread' }, async $ => {
    const r = await call($, 'band')
    const t = r?.json?.thread
    if (!t) {
      $.ui.log('This panel has no thread yet. Claude starts one with start_thread.')
      return {}
    }
    $.ui.log(`${t.name} · ${t.stage}${t.notes?.length ? ` · ${t.notes.map((n: number) => `#${n}`).join(' ')}` : ''}`)
    if (t.folder || t.branch) $.ui.log(`${t.folder || ''}${t.folder && t.branch ? ' · ' : ''}${t.branch || ''}${t.commits ? ` · ${t.commits} commits` : ''}`)
    if (t.pr) $.ui.log(`PR ${t.pr}${t.ci ? ` · CI ${t.ci}` : ''}${t.merged ? ` · merged ${t.merged.slice(0, 7)}` : ''}`)
    if (t.next) $.ui.log(`next: ${t.next}`)
    return {}
  })
}
