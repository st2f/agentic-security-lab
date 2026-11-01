# Project Brief: Agentic Security Investigation Lab

## 1. Purpose

Build a small, extensible AI-assisted security investigation system to learn agent orchestration through practical experiments.

The primary goal is learning, not delivering a production-ready security scanner.

The project combines three learning objectives:

- **Agent orchestration:** Understand model-directed exploration, tool calling, state management, multi-model coordination, verification loops, and resource constraints.
- **Security testing:** Learn established security testing techniques and tools, with particular attention to the terminology and concepts in the ISTQB Certified Tester Security Test Engineer (CT-STE) syllabus.
- **TypeScript backend engineering:** Practice Node.js, TypeScript, modular architecture, testing, and integration with external tools and APIs.

## 2. Investigation Scope

The system investigates source-code repositories for potential security vulnerabilities, particularly context-dependent risks that conventional generic security scanners may overlook or cannot easily verify.

Examples include:

- Missing or inconsistent authorization checks.
- Cross-tenant data exposure.
- Business logic vulnerabilities and workflow bypasses.
- Race conditions affecting security invariants.
- Inconsistent security enforcement across entry points.
- Trust-boundary violations and unsafe data flows.

OWASP references, including the OWASP Top 10, may guide discovery and classification. They should not impose a rigid checklist or restrict the agent to predefined vulnerability categories.

Existing scanners remain valuable complementary tools. The project should not claim that these vulnerability classes are inherently undetectable by static or dynamic analysis.

### Investigation modes

Support both:

- **Targeted investigation:** The user provides a specific question, concern, vulnerability category, or area of code.
- **Open exploration:** The agent investigates a repository to identify and prioritize potentially significant security risks.

Both modes should use the same underlying investigation process.

## 3. Intended Investigation Workflow

The conceptual workflow is:

**Discovery → Prioritization → Investigation/Verification → Reassessment → Report**

These activities are revisitable, not a rigid sequence. As new evidence emerges during exploration or verification, candidates may be added, reprioritized, merged, or discarded.

### Discovery and prioritization

The agent explores the repository and produces an initial prioritized list of potential risk areas, with a maximum of 3 or 10 candidates, for example, depending on the requested scope and available budget. These are upper limits, not required counts. Zero credible candidates is a valid outcome and does not establish that the repository is secure.

Each candidate should contain a hypothesis, rationale, available evidence, and possible next checks.

The initial list represents hypotheses, not confirmed vulnerabilities.

### Investigation and verification

For each selected candidate, the system should eventually be able to:

- Inspect relevant code and trace execution or data flows.
- Identify applicable security checks and existing tests.
- Request appropriate verification using available tools.
- Integrate established security testing tools where relevant.
- Record evidence supporting or contradicting the hypothesis.
- Identify verification gaps and suggest additional tools, tests, or skills.
- Distinguish findings from assumptions and uncertainties.

Suggested new capabilities must not be installed or executed automatically without appropriate authorization.

### Reassessment

After verification, an analysis model reassesses the evidence and may confirm, reject, refine, or retain a hypothesis as unresolved.

Additional verification rounds should be possible when justified, subject to explicit resource limits.

### Reporting

Reports should distinguish:

- Potential risks and hypotheses.
- Source-code evidence with precise references.
- Verification performed and its outcomes.
- Which hypotheses are supported by code, which behaviors have been verified at runtime, and which claims remain unresolved or have been rejected.
- Checks that could not be performed.
- Suggested next steps, tools, or tests.
- Investigation scope and limitations.

Reporting should distinguish the claim being made from the evidence supporting it:

- **Hypothesis:** A potential security issue requiring further examination.
- **Code-supported finding:** A specific claim supported by source-code evidence. Code inspection may establish a defect while leaving runtime behavior or deployment assumptions unresolved.
- **Runtime-verified behavior:** Behavior observed under documented test conditions. The report must state what was exercised and observed, without generalizing beyond those conditions.
- **Exploitability:** A separate assessment of whether the issue can be used to violate a security property under stated attacker capabilities and environmental assumptions. Neither a code observation nor a runtime result automatically proves exploitability.

Runtime verification is not a universal prerequisite for a valid code-supported finding. Reports must make the limits of each claim explicit and identify assumptions or missing evidence affecting conclusions about exploitability.

These are reporting principles, not a detailed verification status model. Define that model when verification is introduced in the relevant milestone.

## 4. Why Agent Orchestration?

The project must demonstrate a genuine reason for using an LLM-driven investigation rather than a deterministic workflow.

The agent should make meaningful decisions such as:

- Which code paths to investigate.
- Which hypotheses deserve further examination.
- What evidence is missing.
- Which available tools could help verify a hypothesis.
- Whether further investigation is justified.
- When available evidence is insufficient to reach a conclusion.

The complete sequence of investigation actions should not be predetermined by the application.

The orchestrator remains responsible for execution control, tool permissions, state transitions, limits, and termination.

Do not introduce an LLM merely to reformat deterministic scanner output or summarize arbitrary search results.

## 5. Technology and Architecture

### Initial technology choices

- **Language:** TypeScript
- **Runtime:** Node.js
- **Orchestration framework:** LangGraph.js
- **Model providers:** Initially one provider, with a design that supports different models for different responsibilities.
- **Security tools:** Introduced incrementally when they support a specific investigation or verification need.

Use current, documented LangGraph.js APIs rather than assuming an older interface.

### Separation of responsibilities

Keep three conceptual boundaries:

#### Domain

Security investigation concepts such as risk candidates, evidence, findings, verification outcomes, and domain rules.

The domain must not depend on LangGraph, model SDKs, or security tool implementations.

#### Application

Investigation use cases, policies, candidate prioritization, verification coordination, and completion criteria.

#### Infrastructure and orchestration

LangGraph graphs, nodes, transitions, model clients, repository inspection tools, and security scanner adapters.

Graph nodes should coordinate application behavior rather than accumulate all investigation logic.

Avoid creating unnecessary abstractions, interfaces, ports, or directory structures before there is a concrete reason for them.

### State

Distinguish model conversation history from structured investigation state.

Structured state should represent actual investigation progress, such as candidates, evidence, verification tasks, and outcomes.

Do not add generic notes, persistence, or memory systems that merely duplicate information already available in the model context.

## 6. Multi-Model Orchestration

Multi-model coordination is an intended learning objective and should be considered in the architecture from the beginning.

A useful future pattern is:

1. A stronger analysis model identifies and prioritizes risks.
2. A cheaper verification model investigates unresolved questions using tools.
3. The analysis model reassesses the new evidence.
4. Further verification rounds occur only when justified.

The first implementation may use a single model, but it should not assume that all phases must share the same model or conversation history.

Distinguish between multiple model configurations and multiple autonomous agents. These are not necessarily the same architecture.

Model/provider abstraction, parallel workers, and automatic routing should only be implemented when justified by a concrete milestone.

## 7. Security Testing Tools and ISTQB

The project should progressively explore established security testing techniques and tools, potentially including:

| Technique or area                           | Candidate tools     |
| ------------------------------------------- | ------------------- |
| Static application security testing (SAST)  | Semgrep, CodeQL     |
| Dynamic application security testing (DAST) | OWASP ZAP           |
| Software composition analysis (SCA)         | OSV-Scanner         |
| API fuzz testing                            | Schemathesis        |
| Threat modeling                             | OWASP Threat Dragon |

These are candidates, not mandatory dependencies.

Maintain a distinction between security testing techniques, tools, and orchestration capabilities.

Where useful, document experiments using the exact terminology of the relevant ISTQB Certified Tester Security Test Engineer (CT-STE) syllabus version. Verify the syllabus terminology before treating it as an official learning objective.

The project may eventually integrate deterministic scanner results with model-directed investigation and verification.

## 8. Incremental Development

Development must be incremental. Each milestone should produce independently demonstrable behavior and have explicit learning objectives and acceptance criteria.

Suggested progression:

| Milestone | Deliverable                                                                             |
| --------- | --------------------------------------------------------------------------------------- |
| 1         | Iterative, model-directed repository exploration → prioritized risk hypotheses → report |
| 2         | Pre-analysis → verification → report with evidence and next steps                       |
| 3         | Integration of an established security testing tool                                     |
| 4         | Capability-gap identification and suggested additional verification tools               |
| 5         | Separate analysis and verification model configurations                                 |
| 6         | Iterative verification and reassessment with bounded rounds                             |

This is a conceptual progression, not a mandatory implementation sequence. Adjust it when an experiment demonstrates a better order.

Milestone 1 must include a bounded exploration loop in which the model selects follow-up repository search or file-reading actions based on previously discovered evidence. Summarizing a predetermined collection of files does not satisfy this milestone. Acceptance requires an inspectable action trace demonstrating at least one evidence-driven follow-up action, alongside the resulting hypotheses and source references. This exploration loop is distinct from the later verification and reassessment rounds in milestone 6.

Do not build the complete future architecture in milestone 1.

## 9. Testing and Evaluation

Use two complementary kinds of investigation targets:

### Real repositories owned or authorized by the developer

These provide realistic codebases and unknown security issues.

### Controlled fixture repositories

These contain deliberately seeded vulnerabilities and secure implementations, with known expected outcomes.

The fixture's answer key must not be available to the investigating agent.

Evaluation should consider:

- Correctly identified risks.
- False positives.
- Missed vulnerabilities.
- Quality and accuracy of evidence references.
- Appropriate uncertainty and verification status.
- Tool selection and investigation decisions.
- Cost and number of model/tool iterations.

A reproducible demonstration is more valuable than an impressive but unverified report.

Any active security testing should run only against authorized targets, preferably isolated local test applications.

## 10. Design Principles and Constraints

- Favor a small, understandable, extensible implementation.
- Use LangGraph.js from the beginning, but only the necessary primitives.
- Separate domain and application logic from framework-specific implementation.
- Prefer explicit, testable behavior over elaborate agent architectures.
- Introduce tools and components only when their responsibilities are justified.
- Keep initial repository access read-only.
- Treat repository content and tool outputs as untrusted input.
- Enforce tool permissions and resource limits in application code, not only through prompts.
- Do not automatically execute arbitrary commands proposed by a model.
- Do not introduce unnecessary persistence, generic memory, subagents, fallback systems, or provider abstractions.
- Document why orchestration is appropriate and when deterministic security testing would be preferable.
- Keep the project useful even if development stops after an early milestone.
