/**
 * Phase 0 Milkdown spike (throwaway).
 *
 * Goal: a decision gate for migrating the editor from BlockNote to Milkdown
 * (Crepe). It proves four things before we commit to the rewrite:
 *   1. esbuild bundles Crepe + its CSS into one webview IIFE.
 *   2. Crepe's theme can be mapped onto VS Code's light/dark theme.
 *   3. getMarkdown() wiring works (the future host<->webview protocol).
 *   4. A real note round-trips with zero drift (markdown in === markdown out),
 *      including the hard cases: a GFM table, a fenced code block with a bare
 *      URL (must NOT auto-link — the bug we just fixed in BlockNote), and
 *      intentional `<br/>` blank-line spacing.
 *
 * This file ships in NO release — it is only reachable via the
 * "Rich Notes: Open Milkdown spike (dev)" command on the feat/milkdown branch.
 */
import { Crepe } from "@milkdown/crepe";
import { canonicalizeMarkdown } from "../markdown";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./milkdown-spike.css";

// A note that exercises the round-trip's hard cases.
const SAMPLE = `# Distributed Systems — Study Notes

Quick reference on **consensus** and _replication_.

## Key topics

- Leader election and quorums
- Log replication and the commit index
- Handling network partitions gracefully

## A GFM table

| Term | Meaning |
| --- | --- |
| Quorum | Majority of nodes needed to commit |
| Raft | Leader-based consensus algorithm |

## Spacing (intentional blank line below)

<br/>

A paragraph after a deliberate blank line.

## Code — the URL must stay literal

\`\`\`bash
docker run -d --name mi -p 8290:8290 registry.wso2.com/wso2-integrator/mi:4.6.0.4
mkdir -p ~/Downloads/attacker-source
\`\`\`

> A blockquote to finish.
`;

// Build the spike's UI shell inside #root.
function buildShell(): void {
  const root = document.getElementById("root")!;
  root.innerHTML = `
    <div class="spike-bar">
      <strong>Milkdown Crepe — Phase 0 spike</strong>
      <button id="recheck" type="button">Re-check round-trip</button>
      <span class="spike-label">raw:</span><span id="statusRaw" class="spike-status"></span>
      <span class="spike-label">canonical:</span><span id="statusCanon" class="spike-status"></span>
    </div>
    <div class="spike-body">
      <div id="editor" class="spike-editor"></div>
      <div class="spike-out">
        <div class="spike-out-title">getMarkdown() output</div>
        <pre id="out"></pre>
      </div>
    </div>`;
}

// A minimal line-level drift report so we can see WHAT changed, not just that
// something did.
function firstDiff(a: string, b: string): string {
  const la = a.split("\n");
  const lb = b.split("\n");
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}:\n  in:  ${JSON.stringify(la[i] ?? "∅")}\n  out: ${JSON.stringify(lb[i] ?? "∅")}`;
    }
  }
  return "";
}

function setStatus(el: HTMLElement, ok: boolean): void {
  el.textContent = ok ? "✓ zero drift" : "✗ drift";
  el.className = "spike-status " + (ok ? "ok" : "bad");
}

async function main() {
  buildShell();
  const out = document.getElementById("out")!;
  const statusRaw = document.getElementById("statusRaw")!;
  const statusCanon = document.getElementById("statusCanon")!;
  const crepe = new Crepe({ root: document.getElementById("editor")!, defaultValue: SAMPLE });
  await crepe.create();

  const check = () => {
    const output = crepe.getMarkdown();

    // Raw: exact string round-trip (expected to drift on cosmetic formatting).
    const rawMatch = output.trim() === SAMPLE.trim();
    setStatus(statusRaw, rawMatch);

    // Canonical: the comparator our sync/change-detection actually uses. If these
    // match, the round-trip produces NO change our system would ever see — the
    // meaningful "zero drift" result.
    const canonIn = canonicalizeMarkdown(SAMPLE);
    const canonOut = canonicalizeMarkdown(output);
    const canonMatch = canonIn === canonOut;
    setStatus(statusCanon, canonMatch);

    let report = "getMarkdown() output:\n\n" + output;
    if (!rawMatch) {
      report += "\n\n---- first RAW diff (cosmetic) ----\n" + firstDiff(SAMPLE, output);
    }
    report += "\n\n---- CANONICAL comparison (what sync sees) ----\n";
    report += canonMatch
      ? "✓ identical after canonicalizeMarkdown() — zero effective drift"
      : "✗ first canonical diff:\n" + firstDiff(canonIn, canonOut);
    out.textContent = report;
  };

  document.getElementById("recheck")!.addEventListener("click", check);
  check(); // initial round-trip on load
}

void main();
