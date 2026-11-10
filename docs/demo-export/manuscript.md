# Live Gemini Smoke Test Project

## Abstract

This systematic literature review aimed to identify which LLM-based tools are evaluated for code generation and program repair, assess how correct and secure the code produced by LLM assistants is, and determine the measured effect of AI assistants on developer productivity. Studies were included if they empirically evaluated LLM-based code generation, repair, or developer productivity, while position papers or abstracts without empirical evaluation were excluded. Across 6 included studies published between 2021 and 2024, 6 records were screened, assessed for eligibility, and extracted for analysis without quality assessment or reported exclusion reasons.

Empirical findings indicate that GitHub Copilot achieved high accuracy in code generation benchmarks, and program repair accuracy improved significantly when automated sampling was employed. Furthermore, repeated model sampling demonstrated effectiveness for code generation. However, functional correctness varies strongly by target programming language and task difficulty, reported metrics evaluated on contaminated benchmarks may be overstated, and long-term code quality was not measured in related productivity experiments. Additionally, generated code may contain security weaknesses in approximately 35% of snippets across multiple Common Weakness Enumeration categories.

The findings imply that while large language models show promising capabilities, their measured effectiveness appears to remain contingent on benchmark integrity, sampling parameters, task complexity, and security considerations.

## Introduction

### Research questions


The primary objective of this systematic literature review is to delineate the core research questions driving current scholarly inquiry within the field. A synthesis of the extant literature indicates that contemporary investigations predominantly focus on identifying key operational challenges and evaluating the efficacy of emerging methodological frameworks.

## Methods

### Review questions

The review addressed the following research questions:

- RQ1: Which LLM-based tools are evaluated for code generation and program repair?
- RQ2: How correct and how secure is the code that LLM assistants produce?
- RQ3: What is the measured effect of AI assistants on developer productivity?

### Eligibility criteria

Studies were included if they met the following criteria:

- IC1: Empirically evaluates LLM-based code generation, repair or developer productivity.

Studies were excluded if they met the following criteria:

- EC1: Position papers or abstracts without an empirical evaluation.

The review question was framed with the PICOC elements below.

- Population: Software developers; Open-source projects
- Intervention: LLM code assistants; GitHub Copilot; Codex
- Comparison: Manual coding; Traditional repair tools
- Outcome: Functional correctness; Security weaknesses; Task completion time
- Context: Benchmarks and industrial settings, 2021-2024

### Information sources and search

The databases and other sources that were searched were not reported in the review record.

### Study selection

Records were identified from databases and registers (n = 0), from other methods (n = 0) and without a recorded source (n = 6). Before screening, 0 duplicate records and 0 records for other reasons were removed. A total of 6 records were screened and 0 were excluded. A total of 6 reports were sought for retrieval, of which 0 could not be retrieved. A total of 6 reports were assessed for eligibility. No reports were excluded after full-text assessment with a recorded reason. A total of 6 studies were included in the review.

The review record does not report the following counts: records removed by automation tools and reports of the included studies.

### Data extraction and quality assessment

Data were extracted for 6 of the 6 studies selected for extraction. No quality assessment was recorded for the included studies.

### Characteristics of the included studies

The review corpus contains 6 studies, published during 2021–2024.

## Results

### Theme for RQ1


An overview of the current literature suggests that model-driven code generation and program repair performance varies across evaluation contexts and operational strategies. Specifically, empirical evidence indicates that GitHub Copilot achieved high accuracy in code generation benchmarks, while program repair accuracy improved significantly when automated sampling was employed (demo_paper_copilot_2022; demo_paper_repair_2024). Supporting findings further indicate that functional correctness appears to depend strongly on programming language and task difficulty, repeated model sampling may serve as a surprisingly effective strategy, generated code may contain security weaknesses in roughly 35% of snippets across multiple CWE categories, and results evaluated on contaminated benchmarks might be overstated (demo_paper_codex_2021; demo_paper_copilot_2022; demo_paper_repair_2024; demo_paper_security_2023). Synthesizing these insights implies that while large language models show promising capabilities, their measured effectiveness appears to remain contingent on benchmark integrity, sampling parameters, task complexity, and security considerations.

Empirical evaluations in the primary literature detail the performance capabilities of automated code synthesis models. Specifically, an evaluation of GitHub Copilot demonstrated that the system achieved high accuracy in code generation benchmarks (demo_paper_copilot_2022), while another study observed that program repair accuracy improved significantly with automated sampling strategies (demo_paper_repair_2024). However, findings regarding functional correctness indicate that performance varies strongly depending on the target programming language and task difficulty (demo_paper_copilot_2022), while reported outcomes on contaminated benchmarks may be overstated (demo_paper_repair_2024).

An examination of empirical evaluations reveals nuanced performance dynamics across code generation and program repair domains. While repeated sampling from models demonstrates considerable effectiveness in code generation tasks (demo_paper_codex_2021) and automated sampling appears to improve program repair accuracy (E-02, demo_paper_repair_2024), functional correctness still seems to vary substantially based on the target programming language and task complexity (demo_paper_copilot_2022). Nevertheless, these reported gains must be interpreted cautiously, as performance metrics derived from contaminated benchmarks may be overstated (demo_paper_repair_2024) and approximately 35% of generated snippets may still harbor security weaknesses across multiple CWE categories (demo_paper_security_2023).

### Theme for RQ2


Emerging evidence suggests that large language models may enhance software engineering tasks under specific circumstances. Empirical evaluations indicate that GitHub Copilot appeared to achieve high accuracy in code generation benchmarks, while program repair accuracy seemed to improve significantly when automated sampling was employed (demo_paper_copilot_2022; demo_paper_repair_2024). Synthetically, these findings indicate that AI-assisted tools could potentially offer measurable performance gains in automated code generation and repair workflows.

Regarding the evaluation of code generation and program repair tools, empirical studies present detailed performance evaluations across various benchmarks. Specifically, an evaluation of GitHub Copilot reported that Copilot achieved high accuracy in code generation benchmarks (demo_paper_copilot_2022), while another study noted that program repair accuracy improved significantly with automated sampling (demo_paper_repair_2024). However, these reported outcomes depend on the specific benchmark tasks and sampling strategies evaluated within each experiment.

Evaluating AI-assisted software engineering tools reveals varied outcomes across generation and repair tasks. On one hand, GitHub Copilot demonstrated high accuracy in code generation benchmarks (demo_paper_copilot_2022), while automated sampling techniques appeared to significantly improve program repair accuracy across several benchmarks (demo_paper_repair_2024). However, these performance insights may remain qualified, as long-term code quality was not measured in related productivity experiments (demo_paper_productivity_2023).

## Discussion

### Agreement and conflict between studies


A comparative analysis of the included studies reveals key areas of convergence and conflict regarding the evaluated outcomes. Across the reviewed literature, several findings align in demonstrating consistent operational patterns, whereas other results diverge based on methodological variations. However, these synthesised insights must be contextualised within the specific parameters and constraints of the underlying primary research.

### Limitations


This systematic literature review evaluated the current body of research according to the defined protocol. However, a primary limitation of this synthesis stems from the restricted scope and availability of the underlying primary evidence.

## Conclusion

This systematic literature review addressed three research questions regarding large language model (LLM) tools in software engineering. Regarding RQ1, the evaluated tools identified in the included literature for code generation and program repair specifically include GitHub Copilot and OpenAI Codex.

In response to RQ2, concerning the correctness and security of the generated code, GitHub Copilot achieved high accuracy in code generation benchmarks, and program repair accuracy improved significantly when automated sampling strategies or repeated model sampling were used. However, functional correctness remains strongly dependent on the target programming language and task difficulty, and performance outcomes evaluated on contaminated benchmarks may be overstated. In terms of security, generated code was found to contain security weaknesses in roughly 35% of snippets across multiple Common Weakness Enumeration categories.

Addressing RQ3, the measured effect of AI assistants on developer productivity was not established with detailed productivity metrics in the synthesised findings, as long-term code quality was not measured in related productivity experiments. Overall, the available evidence is limited by the restricted scope and availability of the underlying primary literature, as well as the absence of long-term code quality measurements in productivity evaluations.

## References

1. Mark Chen, Jerry Tworek, Heewoo Jun (2021) "Evaluating Large Language Models Trained on Code". *arXiv preprint* https://doi.org/10.48550/arXiv.2107.03374
2. Alice Johnson, Bob Miller, Carol Danvers (2022) "An Empirical Evaluation of GitHub Copilot on Code Completion Tasks". *ICSE 2022* https://doi.org/10.1145/3510003.3510050
3. Sida Peng, Eirini Kalliamvakou, Peter Cihon (2023) "The Impact of AI on Developer Productivity: Evidence from GitHub Copilot". *arXiv preprint* https://doi.org/10.48550/arXiv.2302.06590
4. Chunqiu Steven Xia, Yuxiang Wei, Lingming Zhang (2024) "Automated Program Repair in the Era of Large Pre-trained Language Models". *ICSE 2023* https://doi.org/10.1109/ICSE48619.2023.00129
5. Yujia Fu, Peng Liang, Amjed Tahir (2023) "Security Weaknesses of Copilot Generated Code in GitHub Projects". *ACM Transactions on Software Engineering and Methodology* https://doi.org/10.1145/3643674
6. Carlos Jimenez, John Yang, Alexander Wettig (2024) "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?". *ICLR 2024* https://doi.org/10.48550/arXiv.2310.06770
