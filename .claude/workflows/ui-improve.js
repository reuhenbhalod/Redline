export const meta = {
  name: 'ui-improve',
  description: 'Audit the Marswalk web app from several angles, pick the best improvements, build them in parallel by file, then verify and review',
  whenToUse: 'Improve the web app UI. Pass args.request to focus on something specific (e.g. "make the HUD readable on a phone"); with no request it does a general polish pass.',
  phases: [
    { title: 'Audit', detail: 'layout, demo story and data clarity, accessibility' },
    { title: 'Plan', detail: 'merge, rank, assign by file' },
    { title: 'Build', detail: 'one agent per file group, in parallel' },
    { title: 'Verify', detail: 'tests, walkthrough, before/after screenshots' },
    { title: 'Review', detail: 'did it actually get better' },
  ],
}

// ---------------------------------------------------------------- arguments
// args: { request?: string, max?: number, root?: string, shots?: string }
const A = (args && typeof args === 'object') ? args : (typeof args === 'string' ? { request: args } : {})
const ROOT = A.root || '/Users/reuhenbhalod/Documents/Redline'
const SHOTS = A.shots || `${ROOT}/.ui-shots`
const MAX = A.max || 8
const REQUEST = A.request || ''

const CONTEXT = `
You are improving the Marswalk Planner web app in ${ROOT}/web/.
Your role and rules are in ${ROOT}/.claude/agents/ui-engineer.md: read it first and follow it (web/ only, no build step,
Leaflet 1.9.4 only, no git commits, no edits outside web/). Then read ${ROOT}/web/INTERFACES.md and ${ROOT}/web/README.md.
The app is a NASA Space Apps demo: a habitat planner (map + side panel) and a helmet HUD that guide two astronauts on a
walk from the habitat to a delta outcrop and the Three Forks sample depot, with replans and fallback demos. It is judged
from a 30-second video and a public link, so clarity at a glance matters most.
Serve with: python3 -m http.server <port> from ${ROOT}, open /web/index.html. Playwright Chromium is cached in
~/Library/Caches/ms-playwright (use npx -y playwright@1.49.1 from a scratch folder under ${SHOTS}).
${REQUEST ? `\nTHE USER'S REQUEST FOR THIS RUN (this takes priority over everything else): ${REQUEST}\n` : ''}`

const ITEMS = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          problem: { type: 'string' },
          evidence: { type: 'string', description: 'screenshot path, selector, or file:line' },
          change: { type: 'string', description: 'the concrete change to make' },
          files: { type: 'array', items: { type: 'string' }, description: 'web/ files that must change' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          effort: { type: 'string', enum: ['small', 'medium', 'large'] },
        },
        required: ['title', 'problem', 'evidence', 'change', 'files', 'impact', 'effort'],
      },
    },
  },
  required: ['items'],
}

// ---------------------------------------------------------------- 1. audit
phase('Audit')
log(REQUEST ? `Focus: ${REQUEST}` : 'General polish pass')
const LENSES = [
  { key: 'layout', port: 8901, task: 'VISUAL LAYOUT: take screenshots of the planner, every side-panel card, and the HUD at 1280x800, 1440x900, 1920x1080 and 390x844 (phone). Look for overlap, clipping, cramped or wasted space, inconsistent spacing, type sizes and colors, weak visual hierarchy, and anything that looks unfinished.' },
  { key: 'story', port: 8902, task: 'DEMO STORY AND DATA CLARITY: walk through the demo as a judge would in 30 seconds (plan -> preview a stop -> safety check -> HUD -> replan -> a fallback). Where is it slow, confusing, or not obvious what just happened and why? Is the replan moment clear and dramatic enough? Are labels plain English? Are units, sources, assumptions and caveats (estimate, stand-in, demo setting) clear without clutter, and numbers formatted consistently? Screenshot each step.' },
  { key: 'access', port: 8903, task: 'ACCESSIBILITY AND READABILITY: color contrast (WCAG AA) in both planner and HUD, font sizes, keyboard use (tab order, focus rings, shortcuts), screen-reader labels on controls and map markers, color-only signals, motion. Measure, do not guess (compute contrast ratios from the CSS).' },
]
const audits = await parallel(LENSES.map((l) => () => agent(`${CONTEXT}
You are an auditor. Do NOT edit any files. Serve on port ${l.port}; screenshots go in ${SHOTS}/before/${l.key}-*.png.
${l.task}
${REQUEST ? 'Weight your findings toward the user request above; skip unrelated nits.' : ''}
Return up to 10 concrete, verified improvements with evidence. Each must name the web/ files to change.`, { label: `audit:${l.key}`, phase: 'Audit', schema: ITEMS })))

const candidates = audits.filter(Boolean).flatMap((a, i) => a.items.map((it) => ({ ...it, lens: LENSES[i].key })))
log(`${candidates.length} candidate improvements`)
if (!candidates.length) return { note: 'Audit found nothing to improve.' }

// ---------------------------------------------------------------- 2. plan
phase('Plan')
const PLAN = {
  type: 'object',
  properties: {
    chosen: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          change: { type: 'string' },
          acceptance: { type: 'string', description: 'how to check it is done' },
          owner: { type: 'string', enum: ['map', 'panels', 'hud', 'shell'], description: 'shell = app.js, index.html, style.css, util.js' },
        },
        required: ['id', 'title', 'change', 'acceptance', 'owner'],
      },
    },
    deferred: { type: 'array', items: { type: 'string' } },
  },
  required: ['chosen', 'deferred'],
}
const plan = await agent(`${CONTEXT}
Auditors proposed these improvements:
${JSON.stringify(candidates, null, 1)}
Merge duplicates, then choose at most ${MAX} by impact on the demo per unit of effort${REQUEST ? ' (the user request comes first)' : ''}.
Assign each to exactly one owner so builders never edit the same file:
  map = map.js + map.css; panels = panels.js + panels.css; hud = hud.js + hud.css; shell = app.js, index.html, style.css, util.js.
If an item needs two owners, split it into two items with a clear interface between them, and say it in both.
Do not choose items that change sim.js behaviour or the data contracts. List everything you did not choose in deferred (one line each).
Do NOT edit files.`, { label: 'plan', phase: 'Plan', schema: PLAN })

const groups = {}
for (const it of plan.chosen) (groups[it.owner] ||= []).push(it)
const owners = Object.keys(groups)
log(`Chosen ${plan.chosen.length}: ${owners.map((o) => `${o} ${groups[o].length}`).join(', ')}; deferred ${plan.deferred.length}`)

// ---------------------------------------------------------------- 3. build
phase('Build')
const FILES = {
  map: 'web/map.js and web/map.css',
  panels: 'web/panels.js and web/panels.css',
  hud: 'web/hud.js and web/hud.css',
  shell: 'web/app.js, web/index.html, web/style.css and web/util.js',
}
const built = await parallel(owners.map((o, i) => () => agent(`${CONTEXT}
Implement these improvements. You may edit ONLY ${FILES[o]}; other agents are editing the other files right now.
${JSON.stringify(groups[o], null, 1)}
The full plan (for context on items other agents are doing): ${JSON.stringify(plan.chosen.map((c) => ({ id: c.id, owner: c.owner, title: c.title })))}
Keep every existing feature working. When done: serve on port ${8910 + i}, check each item's acceptance in headless Chromium,
no console errors, screenshots in ${SHOTS}/after/${o}-*.png (look at them). Run node --test web/tests.
Return per item: done / partial / not done, with one line each, plus anything another owner must change.`, { label: `build:${o}`, phase: 'Build' })))

// ---------------------------------------------------------------- 4. verify
phase('Verify')
const verify = await agent(`${CONTEXT}
Builders just implemented these improvements in parallel:
${owners.map((o, i) => `--- ${o} ---\n${built[i] || '(builder failed)'}`).join('\n')}
Plan: ${JSON.stringify(plan.chosen, null, 1)}
1. Apply any cross-owner follow-ups the builders listed, and fix anything they broke between them.
2. node --test web/tests must pass.
3. Run the full demo walkthrough headlessly (serve on port 8920): planner, stop preview, safety, HUD, slow-pace replan
   (with the demo budget if the app has one), rock field, storm, high air, link lost. No console errors.
4. Save after-screenshots matching the auditors' before-shots in ${SHOTS}/after/ and compare them with ${SHOTS}/before/.
5. Update web/README.md if controls or the demo changed.
Return: per plan item verified / not verified, regressions found and fixed, test results, screenshot paths.`, { label: 'verify', phase: 'Verify' })

// ---------------------------------------------------------------- 5. review
phase('Review')
const VERDICT = {
  type: 'object',
  properties: {
    better: { type: 'boolean' },
    regressions: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['problem', 'evidence', 'fix'] } },
    notes: { type: 'string' },
  },
  required: ['better', 'regressions', 'notes'],
}
const review = await agent(`${CONTEXT}
You are an independent reviewer with fresh eyes. Do NOT edit files. Compare ${SHOTS}/before/ with ${SHOTS}/after/ and run the
app yourself (port 8930). Was each chosen item actually achieved, and is the app better overall for a judge watching a
30-second demo? Report only verified regressions (things that got worse or broke), with evidence.
Chosen items: ${JSON.stringify(plan.chosen.map((c) => ({ id: c.id, title: c.title, acceptance: c.acceptance })))}
Verify report: ${verify}`, { label: 'review', phase: 'Review', schema: VERDICT })

let fixes = 'No regressions to fix.'
if (review && review.regressions.length) {
  fixes = await agent(`${CONTEXT}
A reviewer found these regressions after a UI improvement pass:
${JSON.stringify(review.regressions, null, 1)}
Fix each real one (say why if you skip one), rerun node --test web/tests and a headless load with no console errors
(port 8940), and refresh the affected screenshots in ${SHOTS}/after/.
Return one line per regression: fixed / skipped and why.`, { label: 'fix', phase: 'Review' })
}

return {
  request: REQUEST || '(general polish)',
  chosen: plan.chosen.map((c) => `${c.owner}: ${c.title}`),
  deferred: plan.deferred,
  verify,
  review,
  fixes,
  screenshots: SHOTS,
}
