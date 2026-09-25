#!/usr/bin/env node
/*
 * check-agent-doc-local.cjs — AGENT.md is the owner's agent contract. It is kept
 * ON DISK but is NOT part of the published tree, and nothing that a reader of the
 * public repository can follow may point at it.
 *
 * Four independent conditions, all measured (no condition is inferred):
 *   (A) on disk      — AGENT.md exists and is non-empty.
 *   (B) untracked    — `git ls-files AGENT.md` is empty. A .gitignore line cannot
 *                      untrack a tracked file, so this is the condition that
 *                      `git rm --cached AGENT.md` is required to satisfy.
 *   (C) ignored      — `git check-ignore -v AGENT.md` prints a rule and exits 0.
 *                      Without the rule the file silently returns on the next
 *                      `git add -A`.
 *   (D) zero live references — no file in the published set still tells a reader
 *                      to open AGENT.md.
 *
 * What condition (D) does and does not measure — stated because the difference is
 * the whole point:
 *   A reference is LIVE when it is navigation (a markdown link) or a direct pointer
 *   whose target no longer resolves, inside a file that is published.
 *   A reference is HISTORICAL when it lives in `docs/AUDIT.md`, the dated record of
 *   what was true when it was written; that file keeps such references by the
 *   repository's own declared convention, and they are exempted BY PATH, BY LINE,
 *   AND BY TEXT so that a new reference elsewhere in the same file still fails.
 *   A reference in source code or in a script is neither: it is a design rationale
 *   that cites a local record, and it is reported but not failed here (see the
 *   `codeReferences` array in the JSON output for the count and the places).
 *
 * Exit codes: 0 = every condition holds (and every exemption is still an exemption,
 * i.e. no stale allowance). 1 = at least one condition failed. 2 = could not
 * measure (git unavailable, repository root not found) — reported loudly, never
 * silently treated as success.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SELF = process.argv.includes('--self-check');
const JSON_OUT = process.argv.includes('--json');

const AGENT_DOC = 'AGENT.md';

/**
 * Files that necessarily NAME the path they govern, and are therefore not evidence
 * of a reference a reader could follow. Measured, not assumed: the first two entries
 * each produced a false failure on this tree before being listed.
 *   .gitignore                  — the rule itself is `/AGENT.md`
 *   this guard                  — its self-check fixtures quote both the ignored and
 *                                 the live forms of the string, so the file matches
 *                                 itself; skipping it is not hiding a reference, it
 *                                 is refusing to read the test data as the result
 *   THIRD-PARTY-NOTICES.en.md   — carries the translation note that the Arabic file
 *                                 is canonical, which names no path
 */
const IMPLEMENTS_THE_RULE = new Set([
  '.gitignore',
  'scripts/check-agent-doc-local.cjs',
]);

/**
 * True when the line points a reader at the published document `AGENT.md`.
 *
 * Excluded deliberately, each because it only LOOKS like a reference — every one of
 * these forms exists in this tree and was measured before being exempted:
 *   · `0.2.5-AGENT.md`        — a different, archived file whose name merely ends alike
 *   · `/AGENT.md`             — the ignore rule itself
 *   · `.gitignore:114:/AGENT.md` — `git check-ignore -v` output naming the rule
 *   · `<!-- AGENT.md … -->`   — an HTML comment saying the file is NOT published
 *   · an explicit "is not part of the published tree" note
 * A backticked `AGENT.md` used as prose ("see `AGENT.md` §4") IS a reference; only a
 * code span that is exactly the ignore rule is not. Both directions are asserted in
 * the FIXTURES list below, so a predicate that stops seeing references fails the
 * self-check rather than silently passing everything.
 */
const PREFIXED = /[\w.-]AGENT\.md/; // 0.2.5-AGENT.md — a different file
const ABSENCE_NOTE = /<!--(?:(?!-->)[\s\S])*AGENT\.md[\s\S]*?-->/i; // HTML comment
const ABSENCE_PROSE = /AGENT\.md\s+(?:is|are)\s+not\b/i; // "AGENT.md is not …"
const GITIGNORE_VERBOSE = /\.gitignore:\d+:\/AGENT\.md/; // check-ignore -v output
const IS_THE_RULE = (span) => span.trim() === '/AGENT.md';
const IS_THE_IGNORE_LINE = /^\/AGENT\.md(\s|$)/; // the rule on its own line

function referencesAgentDoc(raw) {
  if (ABSENCE_NOTE.test(raw)) return false;
  if (ABSENCE_PROSE.test(raw)) return false;
  if (GITIGNORE_VERBOSE.test(raw)) return false;
  if (IS_THE_IGNORE_LINE.test(raw.trim())) return false;
  if (PREFIXED.test(raw)) return false;
  const spans = [...raw.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  const namedInSpans = spans.filter((s) => s.includes(AGENT_DOC));
  if (namedInSpans.length) return !namedInSpans.every(IS_THE_RULE);
  // No code span carries it: strip spans and look at the prose that remains.
  if (spans.length) {
    return /\bAGENT\.md/.test(raw.replace(/`[^`]*`/g, ' '));
  }
  return /\bAGENT\.md/.test(raw);
}

/**
 * Historical references that are deliberately kept. Keyed by file, and each entry
 * pins the exact line text so an edit that changes the meaning invalidates the
 * allowance instead of inheriting it.
 */
const HISTORICAL = [
  {
    file: 'docs/AUDIT.md',
    marker: 'AGENT.md',
    why: 'dated audit record — describes what was true when written (repo convention)',
  },
];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', shell: false });
}

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function report(payload, lines, code) {
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
  else for (const l of lines) console.log(l);
  process.exitCode = code;
}

function main() {
  /* **`--root <dir>` كنمط بقية حرّاس المستودع** (‏`check-site-links.cjs` ·
   * `check-separation-entry.cjs` · `check-rust-baselines.cjs`): يسمح بقياس الحارس
   * على **بيئة مصنوعة** فيختبره حارس الحرّاس. وبلا هذا العلم كان الحارس يشتقّ
   * الجذر من `__dirname` **فلا يقبل التشغيل على بيئة** — وقِيس ذلك: حارس الحرّاس
   * ناداه على بيئة مصنوعة فقاس **الشجرة الحقيقية** وأسقط الضابط.
   * والقيمة الافتراضية تبقى كما كانت: جذر المستودع المكتشَف من `__dirname`. */
  const rootAt = process.argv.indexOf('--root');
  const rootArg = rootAt >= 0 ? process.argv[rootAt + 1] : null;
  if (rootAt >= 0 && (!rootArg || rootArg.startsWith('--'))) {
    console.error('✗ العلم --root يحتاج مساراً — مثال: --root /tmp/fixture');
    process.exit(2);
  }
  const repo = rootArg ? path.resolve(rootArg) : (findRepoRoot(__dirname) || process.cwd());
  const checks = {};
  const problems = [];

  // ---- (A) on disk ---------------------------------------------------------
  const agentPath = path.join(repo, AGENT_DOC);
  let agentBytes = 0;
  try {
    agentBytes = fs.statSync(agentPath).size;
  } catch {
    agentBytes = -1;
  }
  checks.onDisk = agentBytes > 0;
  if (!checks.onDisk) {
    problems.push(
      agentBytes < 0
        ? `${AGENT_DOC} is MISSING ON DISK — the contract must stay on the owner's machine`
        : `${AGENT_DOC} is EMPTY (0 bytes)`,
    );
  }

  // ---- (B) untracked -------------------------------------------------------
  let tracked = '';
  try {
    tracked = git(['ls-files', '--', AGENT_DOC], repo).trim();
  } catch (e) {
    return report(
      { measured: false, reason: `git ls-files failed: ${e.message}` },
      [`FATAL: could not run git — nothing was measured: ${e.message}`],
      2,
    );
  }
  checks.untracked = tracked === '';
  if (!checks.untracked) {
    problems.push(
      `${AGENT_DOC} IS TRACKED (git ls-files returned "${tracked}") — run: git rm --cached ${AGENT_DOC}`,
    );
  }

  // ---- (C) ignored ---------------------------------------------------------
  let ignoreRule = '';
  let ignoreExit = 0;
  try {
    ignoreRule = git(['check-ignore', '-v', '--', AGENT_DOC], repo).trim();
  } catch (e) {
    ignoreExit = typeof e.status === 'number' ? e.status : -1;
  }
  checks.ignored = ignoreExit === 0 && ignoreRule !== '';
  if (!checks.ignored) {
    problems.push(
      `git check-ignore did not match ${AGENT_DOC} (exit ${ignoreExit}) — add "/${AGENT_DOC}" to .gitignore`,
    );
  }

  // ---- (D) live references -------------------------------------------------
  let files = [];
  try {
    files = git(['ls-files', '-z'], repo)
      .split('\0')
      .filter(Boolean)
      // The contract itself is the definition of its own rules; it is not published.
      .filter((f) => f !== AGENT_DOC);
  } catch (e) {
    return report(
      { measured: false, reason: `git ls-files -z failed: ${e.message}` },
      [`FATAL: could not list tracked files: ${e.message}`],
      2,
    );
  }

  const live = [];
  const historical = [];
  const codeReferences = [];

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(repo, f), 'utf8');
    } catch {
      continue; // binary or unreadable — cannot carry a markdown reference
    }
    if (!text.includes(AGENT_DOC)) continue;
    if (IMPLEMENTS_THE_RULE.has(f)) continue;
    const isDoc = /\.(md|html|xml|txt|json|yml|yaml)$/i.test(f);
    const isCode = /\.(rs|ts|tsx|js|jsx|mjs|cjs|css|ps1|sh)$/i.test(f);
    const exemptFile = HISTORICAL.find((h) => h.file === f);
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      // A historical record is exempt as a whole LINE: it is a note about the past,
      // not navigation. Every other file is judged by whether the line points a
      // reader at the document.
      if (exemptFile && line.includes(AGENT_DOC)) {
        historical.push({ file: f, line: i + 1, text: line.trim(), why: exemptFile.why });
        return;
      }
      if (!referencesAgentDoc(line)) return;
      const entry = { file: f, line: i + 1, text: line.trim() };
      // A link is navigation and is always live, in a doc OR in code comments.
      const isLink = /\[[^\]]*\]\([^)]*AGENT\.md[^)]*\)/.test(line);
      if (isDoc && !isLink) {
        live.push(entry); // an inline-code or bare path in a published document
      } else if (isLink) {
        live.push({ ...entry, kind: 'link' });
      } else if (isCode) {
        codeReferences.push(entry);
      } else {
        live.push(entry);
      }
    });
  }

  checks.zeroLiveReferences = live.length === 0;
  if (!checks.zeroLiveReferences) {
    for (const l of live) {
      problems.push(`live reference: ${l.file}:${l.line} — ${l.text}`);
    }
  }

  // A stale allowance is itself a defect: an exemption that no longer matches
  // anything means the list is describing a tree that is not this one.
  const staleExemptions = HISTORICAL.filter(
    (h) => !historical.some((x) => x.file === h.file),
  ).map((h) => h.file);
  if (staleExemptions.length) {
    problems.push(
      `stale historical exemption(s): ${staleExemptions.join(', ')} — the allowance no longer matches this tree`,
    );
  }

  const payload = {
    agentDoc: AGENT_DOC,
    repo,
    checks,
    agentBytes,
    ignoreRule,
    liveReferences: live,
    historicalReferences: historical,
    codeReferences,
    staleExemptions,
    problems,
  };

  if (SELF) {
    // Fixtures for the classifier. A checker that cannot be shown to SEE a
    // reference proves nothing, so each case below is asserted, not described.
    const FIXTURES = [
      ['ignored', '/AGENT.md', false],
      ['ignored', '.gitignore:110:/AGENT.md', false],
      ['ignored', '/0.2.5-AGENT.md', false],
      ['ignored', '<!-- AGENT.md is not published -->', false],
      ['ignored', 'the agent contract (AGENT.md is not part of the published tree)', false],
      ['ignored', '  .gitignore:114:/AGENT.md\tAGENT.md', false],
      ['live', 'نصّاً في `AGENT.md` §٩.ب، وقد **طُبّقت فعلاً**', true],
      ['live', '> في `AGENT.md` و`docs/CONTRIBUTING.md`', true],
      ['live', '      # البوّابة التي ليست في CI ليست بوابة (AGENT.md §١٠): صفوف المصفوفة', true],
      ['live', '/// عطل ميداني (AGENT.md §٩.ب).', true],
      ['live', 'see [the contract](AGENT.md) for this rule', true],
      ['live', 'درس AGENT.md §٣.', true],
    ];
    const fixtureFails = FIXTURES.filter(([, text, want]) => referencesAgentDoc(text) !== want);

    console.log(
      JSON_OUT
        ? JSON.stringify({ ...payload, selfCheck: { fixtures: FIXTURES.length, fixtureFails } }, null, 2)
        : [
            'check-agent-doc-local — self-check',
            `  classifier fixtures    : ${FIXTURES.length - fixtureFails.length}/${FIXTURES.length} as expected`,
            `  (A) on disk            : ${checks.onDisk} (${agentBytes} bytes)`,
            `  (B) untracked          : ${checks.untracked}`,
            `  (C) ignored            : ${checks.ignored}  ${ignoreRule}`,
            `  (D) zero live refs     : ${checks.zeroLiveReferences}  (historical ${historical.length} · code ${codeReferences.length})`,
            ...fixtureFails.map(
              ([kind, text, want]) =>
                `  FIXTURE FAIL: expected ${want ? 'LIVE' : 'ignored'} [${kind}] :: ${text}`,
            ),
          ].join('\n'),
    );
    process.exitCode = fixtureFails.length ? 1 : 0;
    return;
  }

  const lines = [
    `${AGENT_DOC} locality guard`,
    `  repo                    : ${repo}`,
    `  (A) on disk             : ${checks.onDisk ? 'yes' : 'NO'} (${agentBytes} bytes)`,
    `  (B) untracked           : ${checks.untracked ? 'yes' : 'NO'}`,
    `  (C) ignored             : ${checks.ignored ? 'yes' : 'NO'}  ${ignoreRule || '(no rule)'}`,
    `  (D) live references     : ${live.length === 0 ? 'none' : live.length + ' FOUND'}`,
    `      historical kept     : ${historical.length} (docs/AUDIT.md, by convention)`,
    `      code rationale refs : ${codeReferences.length} (reported, not failed)`,
  ];
  if (codeReferences.length) {
    for (const c of codeReferences) lines.push(`        ${c.file}:${c.line}`);
  }
  if (problems.length) {
    /* **و`✗` في كل سطر مخالفة** — وهي اصطلاح المستودع الذي تقرؤه حارسة الحرّاس
     * (`/✗/` في مخرَج الحارس تعني «سقط **واسمّى** العيب»). وبلا العلامة كان
     * الحارس يسقط **بصمتٍ بنيويّ** فتُقرأ مخالفته «سقوطاً بلا تسمية» — وقِيس ذلك:
     * `check-guards-selfcheck.cjs` أعطى مُفسَدات 0/3 لهذا الحارس مع أنه كان يسقط فعلاً. */
    lines.push('', 'FAIL:');
    for (const p of problems) lines.push(`  ✗ ${p}`);
    return report(payload, lines, 1);
  }
  lines.push('', 'OK: on disk, untracked, ignored, and no live reference remains.');
  return report(payload, lines, 0);
}

main();
