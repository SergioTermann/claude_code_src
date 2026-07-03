# CiteCheck Reference Audit

## Scope

- Source: `bare_jrnl_new_sample4.tex`
- Bibliography: `references.bib`
- Generated bibliography snapshot: `bare_jrnl_new_sample4.bbl`

## Summary

| Item | Result |
| --- | ---: |
| In-text citation occurrences | 43 |
| Unique cited keys | 31 |
| BibTeX entries | 31 |
| `.bbl` entries | 31 |
| Missing BibTeX keys | 0 |
| Unused BibTeX entries | 0 |
| Missing `.bbl` entries | 0 |
| Future-year placeholders | 0 |
| Required-field issues | 0 |

## Added 2025/2026 References

| Key | Year | Topic | Queryability |
| --- | ---: | --- | --- |
| `wang2025wtfaultllm` | 2025 | Wind-turbine KG-enhanced LLM fault diagnosis | Crossref DOI verified: `10.1016/j.procs.2025.08.049` |
| `razaq2026llmkgfaultreview` | 2026 | Systematic review of LLM + KG fault diagnosis | Crossref DOI verified: `10.1016/j.asoc.2026.114908` |
| `ma2026fdrkgllm` | 2026 | KG-enhanced LLM fault reasoning and maintenance decision support | Crossref DOI verified: `10.1080/00207543.2025.2472298` |
| `lan2025kgllmhvdc` | 2025 | KG-enhanced and LLM-guided power-system fault diagnosis | Crossref DOI verified: `10.1063/5.0309229` |

Existing 2025 item `li2025llmyoloms` was corrected to arXiv `2511.10394` with updated title and authors.

## Notes

- The installed CiteCheck CLI could not run under the system Python 3.9 because its package imports `typing.TypeAlias`, which is available in newer Python versions. The audit therefore followed the CiteCheck skill workflow with agent-side parsing, format checks, Crossref verification, and semantic relevance review.
- `bare_jrnl_new_sample4.bbl` was manually synchronized from `references.bib` because BibTeX is not available in this environment.

