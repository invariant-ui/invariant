# Pattern discovery v1

`invariant discover` finds structures that recur in application code and writes them as **candidates** for people to review. It is separate from source discovery (`discovery-and-adapters-v1.md`), which finds the design system's own components.

Discovery never approves anything, never changes the contract, and never creates a rule. A candidate becomes a pattern only when a person accepts it and promotes it into `invariant.patterns.json`, and even then the pattern is `documented` until someone approves it.

## What it reads

React `.tsx` and `.jsx` files, by syntax only. Nothing is run. Each JSX element is resolved to a component in the compiled contract by the same rules `invariant validate` uses (imports from the design system's packages, compound members like `Card.Header`). So it needs a compiled contract. Other files are skipped and counted in a diagnostic: Vue, Angular, HTML and plain scripts are not analyzed.

Each file becomes a forest of design-system elements: an element sits under the nearest enclosing design-system element. Markup and components from elsewhere between the two are ignored, so "inside" does not mean "direct child". Elements are marked `?` when they may not render (`cond && <X/>`), `*` when they may render many times (a `.map` callback), `~` when something other than the elements seen may supply their children. These marks are part of the structure, so a conditional element and a fixed one are never the same shape.

## Two methods

**Exact structure** (`kind: arrangement`). Every design-system element with something inside it is an arrangement. Its canonical form, to `--depth` levels (default 3), is its key, for example `card(card.header(text),card.body(button))`. Arrangements with the same key are grouped. A group recurring at least `--min-uses` times (default 3) in at least `--min-files` files (default 3) is a candidate. Two arrangements are the same only if they are written the same. A candidate whose every occurrence lies inside another candidate's occurrences gets `subsumedBy`: it is kept, not dropped, and hidden from `candidates list` unless `--all`.

**Overlap of structure** (`kind: similar-files`). Each file is described by its top-level design-system elements (`^stack`) and each element-inside-element pair (`card > card.header`). Files with fewer than 4 such features are too small to say anything and are left out. Files are taken in path order and put in the first group where every pair overlaps (Jaccard) by at least `--similarity` (default 0.7), or start a new group. A group with at least `--min-files` files is a candidate. It reports the features in every file, in at least 80% of them, and the rest with counts, plus the lowest and mean pairwise overlap. These are measurements. The grouping depends on the files present.

## What a candidate says and does not say

Every candidate has `basis: "inferred"` and `equivalence: "not-established"`. Similarity of structure is measured and reported, and it is never taken to mean the same purpose. Names are derived from component names (`nameSource: "derived"`); the category is always `composition`, and what the shape is for is the reviewer's call at promotion. There is no confidence score: nothing here is a probability, so the file gives what was counted (`support`, `consistency`) instead. A language model is not involved, so there is no AI-derived field to qualify. If one is added later to name or describe candidates, its output must carry its own source and confidence.

## Output: `invariant/invariant.candidates.json`

Deterministic for the same files, contract and options (no timestamps; sorted; ids derived from the structure, `candidate:<kind>.<8 hex>`, so a finding keeps its id while its structure is unchanged). Fields: `contract.contentHash`, `parameters`, `summary`, `diagnostics`, and per candidate: `id`, `kind`, `status`, `basis`, `equivalence`, `suggestedName`, `summary`, `explanation` (why it was found and what it does not show), `support`, `consistency`, `structure`, `evidence` (file, line, column, detail; the first 25 in file order, with `evidenceTruncated`), `definition` (the start of a pattern definition), `derivation` (method, version, parameters) and `subsumedBy`.

## Review: `invariant.candidate-reviews.json`

Decisions live in a committed file at the project root (`governance.candidateReviewsFile` to change it), not in the candidates file, so running discovery again never loses them. It is an append-only history: `candidate`, `decision` (`accepted`, `rejected`, `deferred`), `decidedBy`, `decidedAt`, optional `reason`, `reference`, and `promotedTo`. The latest entry for a candidate is the one that counts. Names are asserted, not authenticated, and `governance.approvers` restricts who may decide, as for `invariant review`. A decision whose structure discovery no longer finds is reported (`discovery-stale-review`) and kept. This is a separate file from `invariant.decisions.json` because candidates are not contract entities and have no fact paths or fingerprints to attach a decision to.

## Promotion

`candidates promote <id> --id <pattern id> --as <name>` requires the candidate to be accepted. It adds a definition to `invariant.patterns.json` (created if absent; the file is rewritten as formatted JSON): the name, description and composition parts from the candidate (parts in every occurrence `required`, conditional or repeated ones `optional`), and an `origin` block with the candidate id, method, counts, who accepted it, when and the reference. It adds no `approval`, no `intent` and no constraints. `--dry-run` prints the definition without writing. The definition is checked against the definitions schema before anything is written, and a duplicate id is refused. After `compile` the pattern is `documented`, its provenance is in `extensions.discovery`, and `patterns inspect` says it is not approved. Approving it is the existing step (`invariant review approve`, or an approval block in the file).

## Not built

Browser or runtime observation, Vue, Angular and HTML analysis, grouping by props, text or style, and naming or describing candidates with a language model. Generating constraints from candidates is deliberately absent: an observed arrangement is not a rule. MCP does not expose candidates; agents should rely on approved patterns.
