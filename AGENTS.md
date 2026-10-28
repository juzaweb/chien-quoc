# CRITICAL PROTOCOLS

## Language Split
- **Interpersonal Communication:** ALL chat, logic explanations, and feedback MUST be in **VIETNAMESE**.
- **Technical Artifacts:** ALL code, docstrings, and **GIT COMMIT MESSAGES** MUST be in **ENGLISH**.
- **STRICT:** Never use Vietnamese in Git logs or Commit messages under any circumstances.
- **DO NOT** commit or push anything without permission.

### General Rules

- Ask clarifying questions until you are at least 95% confident that you understand the task and can successfully complete it.
- Never make assumptions when a missing requirement could materially affect the implementation.
- Before writing any source code, define the implementation logic and potential error cases / edge cases.
- Notify me if any resources are missing; do not draw without permission.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a fileor symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
