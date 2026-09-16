# Wiki ↔ SAP Mapping

Auto-classifies every page of the AAAP Code Wiki against a closed three-level
SAP catalog (**L1 → L2 → L3**, 96 leaves) and **commits the rendered Markdown
reports into `AAAP_CodeWiki/General/` via an Agency-driven pull request** for human
review.

Hash-based incremental cache keeps re-runs cheap: pages whose content hasn't
changed are carried over from the previous successful build; only new or
modified pages are sent through the LLM.

---

## Table of contents

1. [How to trigger a refresh (daily op)](#1-how-to-trigger-a-refresh-daily-op)
2. [Architecture & data flow](#2-architecture--data-flow)
   - [2.1 End-to-end overview](#21-end-to-end-overview)
   - [2.2 Inside the pipeline run](#22-inside-the-pipeline-run)
3. [Configuration & tunables](#3-configuration--tunables)
   - [3.1 Manual overrides](#31-manual-overrides)
4. [Maintenance & troubleshooting](#4-maintenance--troubleshooting)
   - [4.1 Regular maintenance tasks](#41-regular-maintenance-tasks)

---

## 1. How to trigger a refresh (daily op)

The pipeline is **event-driven**: assigning a tagged work item to the Agency
identity triggers a build. Manual `Run pipeline` from the ADO UI does **not**
work (Agency pipelines require an ASA job context that manual runs lack).

### Steps

1. Open ADO → **Boards** → **AAAP_Code** → **New Work Item** → **Task**.
2. Fill in:
   - **Title**: `Refresh wiki SAP mapping <YYYY-MM-DD>`
   - **Tags**: `agency:pipelineTrialMode=true` &nbsp; *(required — without it, Agency falls through to the default Copilot Coding Agent and ignores this pipeline)*
   - **Assigned To**: `Agency` &nbsp; *(service principal, id starts `e329845e-a08b-…`)*
   - **Development pane** → **Add link** → **Branch** → `AAAP_Code / main`
3. **Save**.

### What happens next (no further action needed)

| ~Time after save | Event |
|---|---|
| 1–2 min | Agency picks up the assignment and posts the build link in the work-item Comments |
| 5–30 min | Pipeline runs: `validate-catalog` → cache fetch → `list-wiki-pages` → diff → Stage 1 (L1 routing) → Stage 2 (L2/L3 detail) → render → publish |
| At end | Agency commits the new Markdown to a fresh feature branch `copilot/swe-wi<NNNN>-<hash>` and opens a **draft PR** scoped to `AAAP_CodeWiki/General/**` |
| You | Review the PR → approve → merge |

### Special cases

- **Wiki content unchanged since last run** → `publish-mapping` reports `no markdown changes` and Agency abandons the empty PR. **No action needed.**
- **Build fails** → check the pipeline run logs; the detailed troubleshooting matrix is maintained in the internal ops guide.
- **PR contains files outside `AAAP_CodeWiki/General/`** → guard step should have prevented this; **abandon PR immediately, do not merge**, file platform bug.

---

## 2. Architecture & data flow

### 2.1 End-to-end overview

```mermaid
flowchart TD
  U([User creates work item<br/>tagged + assigned to Agency])
  AS[Agency Service<br/>checks UseAgencyIdentity flag<br/>+ tag + branch link]
  AP[".azuredevops/policies/<br/>agency-preferences.yml<br/>routes to our pipelineId"]
  PIPE[ADO Pipeline<br/>wiki-sap-mapping]
  PR([Draft PR opened on<br/>copilot/swe-wi-NNN branch])
  REV([Reviewer<br/>approves + merges])

  U --> AS
  AS -->|read on default branch| AP
  AP --> PIPE
  PIPE -->|on green| PR
  PR --> REV
  REV --> WIKI[(AAAP_CodeWiki/General/<br/>up to date on main)]

  classDef external fill:#e0e7ff,stroke:#3730a3,color:#1e3a8a
  classDef artifact fill:#fef3c7,stroke:#92400e,color:#78350f
  class AS,AP external
  class WIKI artifact
```

### 2.2 Inside the pipeline run

```mermaid
flowchart LR
  subgraph PRE[preAgentSteps]
    direction TB
    N["UseNode@1<br/>install Node 20"]
    V["validate-catalog<br/>fail-fast exit 13"]
    D["download cache<br/>AgencyArtifact<br/>tags: cache-ready"]
    L["list-wiki-pages<br/>sha256 each page"]
    DIFF["diff-pages<br/>cache vs current"]
    P1["prepare-l1-route<br/>build compact L1 catalog"]
    N --> V --> D --> L --> DIFF --> P1
  end

  subgraph AGENT["Run Agency (WikiSapMapper)"]
    direction TB
    S1[Stage 1<br/>route page → L1 or null]
    PREP2[prepare-l2l3-detail<br/>bucket + batch + apply overrides<br/>+ record no-match drops]
    S2[Stage 2<br/>per bucket/batch:<br/>page → L2/L3 leaf]
    CONS[consolidate-stage2<br/>merge batch outputs]
    MERGE[merge-mapping<br/>carryover + new]
    R2[render-per-l1<br/>per L1 detail, by leaf SAP<br/>+ Rule C strict filter<br/>+ writes render-stats.json]
    R1[render-index<br/>top-level INDEX<br/>reads render-stats]
    PUB[publish-mapping<br/>sync md → AAAP_CodeWiki/General/]
    S1 --> PREP2 --> S2 --> CONS --> MERGE --> R2 --> R1 --> PUB
  end

  subgraph POST[postAgentSteps]
    direction TB
    G[guard<br/>git status: only<br/>AAAP_CodeWiki/General/<br/>allowed; else revert + fail]
    T[trim out/ to cache essentials]
    CP[copy out/ → Agency_LogPath<br/>becomes AgencyArtifact]
    TAG[tag build cache-ready<br/>only after CP succeeds]
    G --> T --> CP --> TAG
  end

  PRE --> AGENT --> POST
  POST -.->|next run| D

  classDef warn fill:#fee2e2,stroke:#991b1b,color:#7f1d1d
  class G warn
```

---

## 3. Configuration & tunables

### 3.1 Manual overrides

`.pipelines/wiki-sap-mapping/config/wiki-sap-overrides.json`:

```json
{
  "/Azure-Arc/Onboarding/Connect-machines-using-Azure-portal": "Azure Arc > Onboarding > Connecting to Arc",
  "_comment": "Keys starting with underscore are skipped — used for inline comments"
}
```

Overrides take precedence over AI classification. Use sparingly — for pages where the AI keeps mis-classifying despite good keywords/description.

---

## 4. Maintenance & troubleshooting

### 4.1 Regular maintenance tasks

| Cadence | Task | How |
|---|---|---|
| Weekly | Trigger a refresh dispatch | Follow [§1](#1-how-to-trigger-a-refresh-daily-op). Review the PR; merge if classifications look good. Wiki changes since last run → most pages cache-hit, only changed ones re-classified |
| When wiki page mis-classifies repeatedly | Add a manual override | Edit `wiki-sap-overrides.json`, commit, next run picks it up |
| When org adds/renames products | Edit catalog | Edit `sap-catalog.json`, commit; **expect full cache rebuild** (catalog hash change). Pre-commit: `node .pipelines/wiki-sap-mapping/wiki-sap.mjs validate-catalog` locally |
| Monthly | Verify Copilot license + Agency dispatch still works | One refresh dispatch end-to-end |
| Quarterly | Sanity-check Top-20-per-leaf coverage | Look for leaves with 20+ pages in per-L1 files (could indicate keyword/description ambiguity) |
| As-needed | Bump Node version | Edit `version: '20.x'` in pipeline yml under `UseNode@1` |

### 4.2 Recover from Agency clone or active-job failures

The 1ES Agency template runs its injected `Clone/Sync repo` step before this
project's `preAgentSteps`. A transient Agency dispatch problem can therefore
leave `$(Build.SourcesDirectory)` empty before any project code executes.

Typical log sequence:

```text
fatal: Remote branch copilot/swe-wi... not found in upstream origin
Agency Clone/Sync repo did not create a complete source checkout.
```

The pipeline now has a `Pre-Agent: verify Agency checkout` fail-fast step. It
checks for both `.git` and `.pipelines/wiki-sap-mapping/wiki-sap.mjs`, then
prints the correct recovery action instead of allowing a misleading Node
`MODULE_NOT_FOUND` error.

**Recovery procedure:**

1. Do **not** use **Rerun**, **Retry**, or manually queue Pipeline 644. An
   Agency/ASA active job is single-use, so a re-queued build reaches
   `Run Agency` without an active job and fails with HTTP 404.
2. Open the originating work item.
3. Set **Assigned To** to blank and save.
4. Set **Assigned To** back to **Agency** and save.
5. Verify the tag `agency:pipelineTrialMode=true` and the development branch
   link `AAAP_Code / main` are still present.
6. Use the newly created build; do not resume the failed build.

This guard improves diagnosis but cannot create the remote working branch
earlier than the template's injected clone step. Branch creation is owned by
the Agency service, so repeated clone failures should be reported to Agency
with the build ID, work-item ID, working branch, and `Clone/Sync repo` log.
