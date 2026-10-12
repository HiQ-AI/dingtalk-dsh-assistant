# New engineering Runs with remote source and inline acceptance

Newly prepared engineering Runs use v25. Existing frozen Runs keep their definition and receipts.

Repository sourceRepository is optional. With no sourceRepository, or with explicit sourceBranch/developmentBranch/targetBranch configuration, preparation freezes actual remote source/development/target refs. sourceBranch defaults to the remote symbolic HEAD. developmentBranch must be a separate development branch; targetBranch is the configured UAT target. Fetch and checkout occur only in the Task/repository-owned Git directory, shared by that Task's later Runs and stages. An existing sourceRepository configuration without new branch fields retains current source-only baseline selection and branch repair behavior.

The independent plan-local-acceptance agent node is removed only from v25. Keep complete original business acceptance criteria; criteria are coverage descriptions, not expected output values. Each configured scenario must declare an executable expected string. For existing approved JSON scenario descriptions, a clear `expected必须为{...}` / `expected: {...}` literal is parsed as JSON and canonically serialized. A missing or ambiguous expectation fails with LOCAL_ACCEPTANCE_EXPECTATION_REQUIRED. Scenario parameters remain the approved configured parameters (or {}). Actual runner output must still equal expected, satisfy namespace/service identity, and have confirmed process/data cleanup. Do not substitute prose, HTTP 200, passed:true, or a mock backend for native business evidence.

Project active Spring profile and existing application configuration can be referenced by path/hash for native Maven/service startup. No fixed local.yml, private default database, or credential values are synthesized. Original environment authorization remains required.

Stage acceptance criteria have no 2000-character cap; original source key/version/quote/objective checks remain. New v25 PR body file lists are read from the actual Git commit, so missing formatted path metadata does not block delivery. Candidate verification tickets and remote PR identity verification remain required.

Formal reset keeps same Task/repository workspace and approved own commit progress. Cold restoration verifies actual parent/tree, successful commit effect and receipt, directory metadata and branch ownership. Foreign commits, changed completed source and out-of-scope pending files remain rejected. Original Task Owner controls and completion judgment stay in the original Task session.

Use scripts/deploy-local.ps1 and the resident deployment runbook after independent narrow review. This source selection is not an installed package or business acceptance result.
