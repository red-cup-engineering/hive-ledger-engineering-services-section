# Hive Ledger Services Section

Hive Ledger Services realizes the Wallet Analyzer, Wallet Engine Analyzer, and
Synthesized Wallet Analyzer lines of the 2025-12-15 Hive Auto Ledger (HAL)
roadmap (`hive-services-section/content/text/documents/notes/hal/hive-auto-ledger-hal.md`):
`read-hive-account-history-service` reads a Hive account's mainnet operation
history from two independent public nodes, witnessed against each other, with
VESTS carried alongside HP at the chain's vests-to-HP ratio; `read-hive-engine-account-history-service`
does the same over Hive-Engine, composing `@red-cup-engineering/read-hive-engine-fill-service`
for market and pool fills rather than re-deriving them; `derive-hive-account-ledger-service`
is the pure transformation turning both histories plus price directives into a
costed Beancount ledger for the supported account operations, composing
`@red-cup-engineering/derive-set-of-fill-transactions-service` for venue fills;
`apps/hive-auto-ledger-cli.mjs` composes all three for one account and range,
writing the ledger and running `farolfi`'s balance and valuation reports over
it. Every read is read-only; no key is ever required or accepted.

The export retains observed histories, source refusals, derivation refusals and
balance disagreements in a `; hive-ledger-evidence` JSON comment in the same
Beancount file. Accounting validity does not prove complete history or resource
coverage. CLI output reports coverage separately; unresolved evidence or failed
accounting checks produce exit status 1 while retaining the export for recovery.
A refusal-free export still reports coverage as `not-established`, rather than
claiming that all personal commodities and resources have been accounted for.

## Source recovery and delivery boundary

This family is recovered into Red Cup's computer blockchain engineering source from Bare Cedar Fog commit `67f5f22c0c2f6c62de54aac403454e2328014a25`. It preserves Hive and Hive-Engine histories, fill derivation, account ledger derivation, schemas, historical financial knowledge and the CLI. Repository metadata identifies this source rather than treating the laptop snapshot as its owner. The fill reader uses the declared JavaScript operation export rather than traversing the snapshot directory tree.

This is staged source recovery. Existing snapshot consumers remain in place pending migration. The Hive blockchain client has also been recovered alongside this family, and a keyless live account read succeeded from that recovered source. File publication is bound to the owning write-file-service repository at immutable merge revision `530a7a91c432c6d21095684bef96cdf915a36a03` (merged supplier PR #1), preserving durability and exclusive-create properties and applying requested or preserved permissions when the temporary file is created. The exact supplier source and test bytes were read back after merge; its 33 focused checks passed. This is supplier source receiving, not installed Hive or live runtime receiving. The output check uses this supplier directly. The four remaining direct external workspace suppliers (computer data engineering, Farolfi, JavaScript Node services and Metrologic), plus the client’s shared suppliers, still require their actual upstream distribution bindings. The original six declared supplier names returned 404 from the public npm registry during recovery; that observation does not establish absence from other distribution carriers. Verification used the installed snapshot dependency closure with recovered accounting modules, without publishing packages or activating a node release.

Accounting validity and history coverage are separate. Delivered ledger evidence retains unknown operations, source refusals and exact observations. A balanced ledger with unresolved coverage must not be represented as a complete account. This recovery does not yet establish Actor hiring, Board admission, unified personal accounting, Sign primitive composition or production completeness.

### Typed derivation evidence

The delivered `hive-ledger-evidence` record now includes `ledgerDerivation`, a SignCell typed mark admitted against the existing derivation output schema. `admitHiveAccountLedgerMark` re-admits the schema and content address at reception; altered account or ledger content fails address admission. This preserves the full derivation, comparisons and refusals alongside the source histories and coverage. It does not attest ownership, authorize execution or establish complete history. Shared SignCell distribution and the wider Actor/resource/operational composition remain unfinished.

## Observed receiving gap on Cold Red Gate — 2026-10-06

Read-only inspection found game records in `/home/emsenn/.local/state/561-group/hive-games/{terracore,dcrops,holozing-rewards,workerbee}.jsonl`, latest entries dated 2026-09-26. These are outside the chain-history readers' inputs. Terracore includes separate claim-confirmed, battle-won-confirmed and settlement-pending outcomes; the pending outcome reports a confirmed Hive transaction but unreconciled game effect and explicitly forbids retry. Do not turn broadcast confirmation into settled game income or re-execute that action. dCrops and Holozing records include policy waits recorded with exit code 1; exit status alone cannot classify economic outcomes. Workerbee records distinguish delegation from realized distributions.

The installed fleet implementation lives in the Cold Red Gate release snapshot's Hive fleet operations service, while `/home/emsenn/aagaard` still contains older source and dirty operational data. Its `terracore-cycle.mjs` exposes `--recover-tx` separately from `--execute-one`, and holds receipt functions in `src/core/terracoreSettlement.mjs`. Recovery must inspect these actual receiving paths and preserve pending obligations, commodity identity and contradictory provider evidence before claiming complete personal ledger coverage. No game execution, credential access, receipt mutation or settlement recovery was performed in this inspection.

The Coesite observation core has no production caller in the inspected Bare Cedar Fog `origin/main` (febbc0f7c9c). Journal demonstrations do not establish an Actor entrance, budgeted hire or completeness of game accounting. Typed fleet balances remain a narrower observation capability.

The deployed Terracore receiving path was subsequently inspected: `recordTerraCoreActionReceipt` retains the complete event through `witnessChainAct`, but `readTerraCoreActionReceipts` throws unconditionally and its recovery caller does not await it. BCF candidate `rowan/hive-settlement-recovery` (`9996e8dc93e356ae914ba35d7e9b5d1c9f9d8f52`, base `febbc0f7c9c`) restores held journal receipt retrieval and the awaited recovery caller. An actual temporary journal roundtrip retains exact quantities, pending status and retry prohibition, isolates transaction identities and refuses contrary testimony. Queue delivery, canonical fleet source recovery and Cold Red Gate receipt reconciliation remain unfinished. No live transaction was retried or declared settled.

Cold Red Gate data recovery on 2026-10-06 found zero Terracore action events in both the installed release data root and persistent `/home/emsenn/aagaard/data`. The separate game JSONL still held three complete transaction receipts. Using the already-installed journal writer, those original receipts were received into the persistent Aagaard journal with original recorded times, without changing their content or removing the source. A fresh process retrieved all three and verified the pending receipt still has an unconfirmed game effect, complete baseline/plan and `retryAllowed: false`. This recovers evidence, not settlement: the installed recovery command still needs its queued reader correction and binding to this persistent root; no transaction was signed, retried or reclassified.

BCF candidate `rowan/hive-journal-binding` (`5d81af490a25c96c6c6b6d4a2ed37a137ec436d3`, base `413df3779bb`) removes nine game/financial command-local data paths and makes the common journal honor the fleet's existing `AAGAARD_DATA_DIR` host binding. A temporary host-bound journal received pending evidence outside the source release; all nine changed command modules passed syntax checks. The legacy package-relative fallback still exists when no host binding is supplied. Queue delivery, Cold Red Gate host configuration, complete source recovery and removal of that fallback remain unfinished. No live service configuration or restart was forced.

Historical game receiving was completed on 2026-10-06 for the four preserved JSONL sources: 39 complete command observations (12 dCrops, 12 Holozing rewards, 12 Terracore, 3 Workerbee) now reside in game-specific categories of the persistent Aagaard semantic journal. One additional raw Terracore receipt carried its own completion time rather than wrapper fields and was received as a settlement event, bringing retained full Terracore receipts to four. A fresh process structurally compared every one of the 40 original source records with its retained journal content. Policy-wait text, exit statuses, full outcomes and the unresolved settlement's retry prohibition remain intact; sources were not deleted and no financial outcome was reclassified. Object key ordering changes under canonical serialization required structural comparison, not JSON-text equality. Live launch migration, receipt reconciliation, Actor association and complete ledger coverage remain unfinished.
