from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.investigation_pack import InvestigationPack, PackFinding
from .persona_calibration_service import PersonaCalibrationService
from .persona_prompt_registry import PersonaPromptRegistry


_FALSE_POSITIVE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(?i)magic\s+number\s+detected", re.IGNORECASE),
]

_FALSE_POSITIVE_SCOPES: list[re.Pattern[str]] = [
    re.compile(r"alembic/versions/"),
]

_KNOWN_CONSTANTS: frozenset[str] = frozenset({
    "2048", "4096", "8192", "65537",
    "256", "384", "512",
    "8080", "8443", "443", "80", "5432", "6379", "3000", "3306", "27017",
    "200", "201", "204", "301", "302", "400", "401", "403", "404", "409", "422", "429", "500", "502", "503", "504",
    "30", "60", "120", "300", "600", "900", "1800", "3600", "7200", "86400",
    "0644", "0755", "0600", "0o644", "0o755", "0o600",
})


def _is_false_positive_finding(finding: dict[str, Any]) -> bool:
    """Return True if a finding matches known false-positive patterns.

    Catches the most common noise sources: alembic revision metadata
    flagged as secrets, standard crypto constants and port numbers
    flagged as magic numbers, and date/timestamp strings in migration
    files.
    """
    message = str(finding.get("message") or finding.get("impact") or "").strip()
    scope = finding.get("scope") if isinstance(finding.get("scope"), dict) else {}
    file_path = str(scope.get("path") or "").strip()
    severity = str(finding.get("severity") or "P3").upper()
    category = str(finding.get("category") or "").lower()

    if severity in ("P0", "P1"):
        return False

    evidence_refs = finding.get("evidence_refs") or []
    evidence_str = " ".join(str(ref) for ref in evidence_refs) if evidence_refs else ""
    combined = f"{message} {evidence_str} {file_path}"

    for pattern in _FALSE_POSITIVE_PATTERNS:
        if pattern.search(message):
            for constant in _KNOWN_CONSTANTS:
                if constant in combined:
                    return True
            if any(sp.search(file_path) for sp in _FALSE_POSITIVE_SCOPES):
                return True
            if any(sp.search(combined) for sp in _FALSE_POSITIVE_SCOPES):
                return True

    if category in ("code_quality", "docs_knowledge") and any(sp.search(file_path) for sp in _FALSE_POSITIVE_SCOPES):
        if "magic" in message.lower() or "revision" in message.lower() or "constant" in message.lower():
            return True

    if any(sp.search(file_path) for sp in _FALSE_POSITIVE_SCOPES):
        if "magic" in message.lower() or "revision" in message.lower():
            return True

    return False


class InvestigationPackService:
    FINDING_PAYLOAD_HASH_VERSION = "v1_material"
    PERSONA_CONTRACT_SCHEMA_VERSION = "v1.0"

    _PERSONA_ID_ALIASES = {
        "security_overlay": "nina_patel",
        "security-overlay": "nina_patel",
        "backend_runtime": "maya_volkov",
        "backend-runtime": "maya_volkov",
        "frontend_runtime": "jules_tanaka",
        "frontend-runtime": "jules_tanaka",
        "data_layer": "linh_tran",
        "data-layer": "linh_tran",
        "release_engineering": "omar_singh",
        "release-engineering": "omar_singh",
        "infrastructure_iac": "kat_hughes",
        "infrastructure-iac": "kat_hughes",
        "reliability_sre": "noah_bendavid",
        "reliability-sre": "noah_bendavid",
        "observability": "sofia_alvarez",
        "testing_correctness": "priya_raman",
        "testing-correctness": "priya_raman",
        "supply_chain": "nora_kline",
        "supply-chain": "nora_kline",
        "code_quality": "ethan_park",
        "code-quality": "ethan_park",
        "docs_knowledge": "samir_okafor",
        "docs-knowledge": "samir_okafor",
        "ai_pipeline": "amina_chen",
        "ai-pipeline": "amina_chen",
        "nina_patel": "nina_patel",
        "maya_volkov": "maya_volkov",
        "jules_tanaka": "jules_tanaka",
        "linh_tran": "linh_tran",
        "omar_singh": "omar_singh",
        "kat_hughes": "kat_hughes",
        "noah_bendavid": "noah_bendavid",
        "sofia_alvarez": "sofia_alvarez",
        "priya_raman": "priya_raman",
        "nora_kline": "nora_kline",
        "ethan_park": "ethan_park",
        "samir_okafor": "samir_okafor",
        "amina_chen": "amina_chen",
    }
    _PERSONA_DOMAIN_CONTRACTS: dict[str, dict[str, Any]] = {
        "nina_patel": {
            "contract_id": "persona.nina_patel.security_overlay.v1",
            "domain_focus": ["authz", "secret_exposure", "policy_bypass", "injection"],
            "evidence_requirements": ["file_line_scope", "data_flow_anchor", "repro_command"],
            "confidence_floor": 0.72,
            "escalation_targets": ["kat_hughes", "maya_volkov"],
        },
        "maya_volkov": {
            "contract_id": "persona.maya_volkov.backend_runtime.v1",
            "domain_focus": ["runtime_safety", "resource_exhaustion", "input_validation"],
            "evidence_requirements": ["execution_path", "boundary_condition", "repro_command"],
            "confidence_floor": 0.68,
            "escalation_targets": ["nina_patel", "noah_bendavid"],
        },
        "jules_tanaka": {
            "contract_id": "persona.jules_tanaka.frontend_runtime.v1",
            "domain_focus": ["xss", "client_state_exposure", "unsafe_dom", "token_storage"],
            "evidence_requirements": ["component_scope", "entry_vector", "repro_command"],
            "confidence_floor": 0.66,
            "escalation_targets": ["nina_patel", "priya_raman"],
        },
        "linh_tran": {
            "contract_id": "persona.linh_tran.data_layer.v1",
            "domain_focus": ["sql_injection", "migration_drift", "data_integrity", "access_controls"],
            "evidence_requirements": ["query_path", "table_scope", "repro_command"],
            "confidence_floor": 0.7,
            "escalation_targets": ["nina_patel", "maya_volkov"],
        },
        "kat_hughes": {
            "contract_id": "persona.kat_hughes.infrastructure_iac.v1",
            "domain_focus": ["iac_misconfig", "public_exposure", "identity_scope", "network_posture"],
            "evidence_requirements": ["resource_scope", "policy_ref", "repro_command"],
            "confidence_floor": 0.72,
            "escalation_targets": ["noah_bendavid", "nina_patel"],
        },
        "omar_singh": {
            "contract_id": "persona.omar_singh.release_engineering.v1",
            "domain_focus": ["ci_cd_integrity", "supply_chain_gate", "artifact_provenance"],
            "evidence_requirements": ["workflow_scope", "gate_trace", "repro_command"],
            "confidence_floor": 0.67,
            "escalation_targets": ["nora_kline", "kat_hughes"],
        },
        "noah_bendavid": {
            "contract_id": "persona.noah_bendavid.reliability_sre.v1",
            "domain_focus": ["availability", "fault_isolation", "retry_safety", "timeouts"],
            "evidence_requirements": ["failure_mode", "blast_radius", "repro_command"],
            "confidence_floor": 0.64,
            "escalation_targets": ["maya_volkov", "sofia_alvarez"],
        },
        "sofia_alvarez": {
            "contract_id": "persona.sofia_alvarez.observability.v1",
            "domain_focus": ["telemetry_gaps", "alerting_blindspots", "signal_integrity"],
            "evidence_requirements": ["signal_path", "missing_observation", "repro_command"],
            "confidence_floor": 0.6,
            "escalation_targets": ["noah_bendavid", "omar_singh"],
        },
        "priya_raman": {
            "contract_id": "persona.priya_raman.testing_correctness.v1",
            "domain_focus": ["test_coverage_gap", "flaky_guardrails", "regression_risk"],
            "evidence_requirements": ["test_scope", "assertion_gap", "repro_command"],
            "confidence_floor": 0.58,
            "escalation_targets": ["maya_volkov", "nina_patel"],
        },
        "nora_kline": {
            "contract_id": "persona.nora_kline.supply_chain.v1",
            "domain_focus": ["dependency_risk", "provenance", "artifact_signing", "pinning"],
            "evidence_requirements": ["package_scope", "version_trace", "repro_command"],
            "confidence_floor": 0.65,
            "escalation_targets": ["omar_singh", "kat_hughes"],
        },
        "ethan_park": {
            "contract_id": "persona.ethan_park.code_quality.v1",
            "domain_focus": ["maintainability_risk", "unsafe_patterns", "complexity_hotspots"],
            "evidence_requirements": ["code_path", "complexity_anchor", "repro_command"],
            "confidence_floor": 0.55,
            "escalation_targets": ["maya_volkov", "priya_raman"],
        },
        "samir_okafor": {
            "contract_id": "persona.samir_okafor.docs_knowledge.v1",
            "domain_focus": ["runbook_gaps", "misleading_docs", "operational_drift"],
            "evidence_requirements": ["doc_scope", "behavior_mismatch", "repro_command"],
            "confidence_floor": 0.5,
            "escalation_targets": ["omar_singh", "sofia_alvarez"],
        },
        "amina_chen": {
            "contract_id": "persona.amina_chen.ai_pipeline.v1",
            "domain_focus": ["prompt_injection", "model_guardrails", "eval_drift", "agent_policy"],
            "evidence_requirements": ["pipeline_scope", "guardrail_trace", "repro_command"],
            "confidence_floor": 0.69,
            "escalation_targets": ["nina_patel", "omar_singh"],
        },
        "unknown_persona": {
            "contract_id": "persona.unknown.generic.v1",
            "domain_focus": ["general_risk_surface"],
            "evidence_requirements": ["file_line_scope", "repro_command"],
            "confidence_floor": 0.5,
            "escalation_targets": ["nina_patel"],
        },
    }
    _RISK_SURFACE_ADJUDICATION_POLICY: dict[str, dict[str, Any]] = {
        "security_overlay": {
            "policy_id": "adjudication.security_overlay.v1",
            "min_confidence_for_auto_confirm": 0.72,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 1,
            "max_new_findings_per_persona": 20,
        },
        "backend_runtime": {
            "policy_id": "adjudication.backend_runtime.v1",
            "min_confidence_for_auto_confirm": 0.67,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "frontend_runtime": {
            "policy_id": "adjudication.frontend_runtime.v1",
            "min_confidence_for_auto_confirm": 0.64,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "data_layer": {
            "policy_id": "adjudication.data_layer.v1",
            "min_confidence_for_auto_confirm": 0.7,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 1,
            "max_new_findings_per_persona": 20,
        },
        "infrastructure": {
            "policy_id": "adjudication.infrastructure.v1",
            "min_confidence_for_auto_confirm": 0.72,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 1,
            "max_new_findings_per_persona": 20,
        },
        "release_engineering": {
            "policy_id": "adjudication.release_engineering.v1",
            "min_confidence_for_auto_confirm": 0.66,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "reliability_sre": {
            "policy_id": "adjudication.reliability_sre.v1",
            "min_confidence_for_auto_confirm": 0.62,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "observability": {
            "policy_id": "adjudication.observability.v1",
            "min_confidence_for_auto_confirm": 0.58,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "testing_correctness": {
            "policy_id": "adjudication.testing_correctness.v1",
            "min_confidence_for_auto_confirm": 0.56,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "supply_chain": {
            "policy_id": "adjudication.supply_chain.v1",
            "min_confidence_for_auto_confirm": 0.63,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "code_quality": {
            "policy_id": "adjudication.code_quality.v1",
            "min_confidence_for_auto_confirm": 0.55,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "docs_knowledge": {
            "policy_id": "adjudication.docs_knowledge.v1",
            "min_confidence_for_auto_confirm": 0.5,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
        "ai_pipeline": {
            "policy_id": "adjudication.ai_pipeline.v1",
            "min_confidence_for_auto_confirm": 0.69,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 1,
            "max_new_findings_per_persona": 20,
        },
        "general": {
            "policy_id": "adjudication.general.v1",
            "min_confidence_for_auto_confirm": 0.55,
            "min_evidence_refs": 1,
            "dispute_escalation_threshold": 2,
            "max_new_findings_per_persona": 20,
        },
    }

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create_packs_from_ingest(
        self,
        *,
        run_id: str,
        ingest_result: dict[str, Any],
        detector_seeds: list[Any] | None = None,
    ) -> list[InvestigationPack]:
        blueprints = self._build_pack_blueprints(
            run_id=run_id,
            ingest_result=ingest_result,
            detector_seeds=detector_seeds or [],
        )
        return await self._upsert_blueprints(blueprints)

    async def create_pack_from_event(
        self,
        *,
        case_id: str,
        event: dict[str, Any],
        service_context: dict[str, Any] | None = None,
    ) -> InvestigationPack:
        event_type = str(event.get("event_type") or event.get("type") or "").strip().lower()
        risk_surface = self._derive_risk_surface_from_event(event_type)
        ingest_result = {
            "risk_surfaces": [risk_surface],
            "scope_files": self._normalize_string_list(event.get("scope_files") or []),
            "scope_services": self._normalize_string_list(
                (service_context or {}).get("scope_services") or event.get("scope_services") or []
            ),
            "coverage_obligations": self._normalize_string_list(
                event.get("coverage_obligations") or []
            ),
            "policy_tags": self._normalize_string_list(
                event.get("policy_tags") or (service_context or {}).get("policy_tags") or []
            ),
            "sensitivity_class": str(event.get("sensitivity_class") or "standard").strip()
            or "standard",
        }
        synthetic_run_id = str(event.get("run_id") or f"case:{case_id}").strip()
        blueprints = self._build_pack_blueprints(
            run_id=synthetic_run_id,
            ingest_result=ingest_result,
            detector_seeds=[],
        )
        if not blueprints:
            raise ValueError("Failed to derive an event-scoped investigation pack")
        blueprint = blueprints[0]
        blueprint["case_id"] = case_id
        packs = await self._upsert_blueprints([blueprint])
        return packs[0]

    async def get_packs(self, *, run_id: str) -> list[InvestigationPack]:
        rows = await self.db.execute(
            select(InvestigationPack)
            .where(InvestigationPack.run_id == run_id)
            .order_by(InvestigationPack.created_at.asc(), InvestigationPack.pack_id.asc())
        )
        return list(rows.scalars().all())

    async def get_pack(self, *, pack_id: str) -> InvestigationPack | None:
        rows = await self.db.execute(
            select(InvestigationPack).where(InvestigationPack.pack_id == pack_id)
        )
        return rows.scalar_one_or_none()

    async def get_pack_findings(self, *, pack_id: str) -> list[PackFinding]:
        rows = await self.db.execute(
            select(PackFinding)
            .where(PackFinding.pack_id == pack_id)
            .order_by(PackFinding.created_at.asc(), PackFinding.finding_id.asc())
        )
        return list(rows.scalars().all())

    async def get_run_findings(
        self,
        *,
        run_id: str,
        limit: int | None = None,
    ) -> list[PackFinding]:
        normalized_run_id = str(run_id or "").strip()
        if not normalized_run_id:
            return []
        query = (
            select(PackFinding)
            .where(PackFinding.run_id == normalized_run_id)
            .order_by(PackFinding.created_at.asc(), PackFinding.finding_id.asc())
        )
        if limit is not None and int(limit) > 0:
            query = query.limit(int(limit))
        rows = await self.db.execute(query)
        return list(rows.scalars().all())

    async def assign_personas(self, *, pack_id: str) -> dict[str, Any]:
        pack = await self.get_pack(pack_id=pack_id)
        if pack is None:
            raise ValueError(f"Unknown pack_id: {pack_id}")

        primary, supporting = self._determine_persona_assignment(pack.risk_surface)
        pack.primary_persona = primary
        pack.supporting_personas_json = supporting
        pack.updated_at = datetime.now(timezone.utc)
        await self.db.commit()
        return {
            "pack_id": pack_id,
            "primary_persona": primary,
            "supporting_personas": supporting,
        }

    async def build_pack_persona_tasks(
        self,
        *,
        pack_id: str,
        iteration: int | None = None,
        blackboard_epoch: str | None = None,
        persona_mode: str | None = None,
        baseline_candidates: list[dict[str, Any]] | None = None,
        budget: dict[str, Any] | None = None,
        allowed_tools: list[str] | None = None,
        write_policy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        pack = await self.get_pack(pack_id=pack_id)
        if pack is None:
            raise ValueError(f"Unknown pack_id: {pack_id}")

        task_iteration = self._safe_int(iteration, default=int(pack.iteration or 1), minimum=1)
        epoch = str(blackboard_epoch or f"epoch_{task_iteration}").strip() or f"epoch_{task_iteration}"
        normalized_budget = self._normalize_budget(budget or {})
        normalized_write_policy = self._normalize_write_policy(write_policy or {})
        normalized_tools = self._normalize_allowed_tools(
            allowed_tools or self._default_allowed_tools_for_risk(str(pack.risk_surface))
        )
        scoped_files = self._normalize_string_list(list(pack.scope_files_json or []))
        scoped_services = self._normalize_string_list(list(pack.scope_services_json or []))
        scoped_evidence_refs = self._normalize_string_list(list(pack.evidence_refs_json or []))

        candidate_fingerprints = self._extract_baseline_candidates(
            baseline_candidates or []
        )
        if not candidate_fingerprints:
            findings = await self.get_pack_findings(pack_id=pack_id)
            candidate_fingerprints = self._normalize_string_list(
                [str(row.finding_fingerprint) for row in findings if str(row.finding_fingerprint).strip()]
            )

        persona_candidates = [
            str(item.get("persona_id") or "").strip()
            for item in self.persona_contracts_for_pack(
                primary_persona=pack.primary_persona,
                supporting_personas=list(pack.supporting_personas_json or []),
                include_all=self._is_full_depth_persona_mode(persona_mode),
            )
            if isinstance(item, dict)
        ]
        adjudication_policy = self._adjudication_policy_for_risk_surface(str(pack.risk_surface))
        tasks: list[dict[str, Any]] = []
        for persona_candidate in persona_candidates:
            persona_id = self._to_stable_persona_id(persona_candidate)
            domain_contract = self._persona_contract_for_id(persona_id)
            persona_prompt_ref = PersonaPromptRegistry.prompt_ref(persona_id)
            persona_prompt_markdown = PersonaPromptRegistry.render_prompt(
                persona_id=persona_id,
                pack_id=str(pack.pack_id),
                risk_surface=str(pack.risk_surface),
                task={
                    "assigned_pack_ids": [str(pack.pack_id)],
                    "blackboard_epoch": epoch,
                    "baseline_candidates": candidate_fingerprints,
                    "budget": normalized_budget,
                        "allowed_tools": normalized_tools,
                        "write_policy": normalized_write_policy,
                        "scoped_evidence": {
                            "evidence_refs": scoped_evidence_refs,
                            "scope_files": scoped_files,
                            "scope_services": scoped_services,
                        },
                    },
                domain_contract=domain_contract,
                adjudication_policy=dict(adjudication_policy),
            )
            persona_prompt_hash = hashlib.sha256(
                persona_prompt_markdown.encode("utf-8")
            ).hexdigest()[:24]
            tasks.append(
                {
                    "persona_id": persona_id,
                    "task_type": "domain_review",
                    "assigned_pack_ids": [str(pack.pack_id)],
                    "iteration": task_iteration,
                    "scoped_evidence": {
                        "evidence_refs": scoped_evidence_refs,
                        "scope_files": scoped_files,
                        "scope_services": scoped_services,
                    },
                    "blackboard_epoch": epoch,
                    "baseline_candidates": candidate_fingerprints,
                    "budget": normalized_budget,
                    "allowed_tools": normalized_tools,
                    "write_policy": normalized_write_policy,
                    "domain_contract": domain_contract,
                    "adjudication_policy": dict(adjudication_policy),
                    "persona_prompt_ref": persona_prompt_ref,
                    "persona_prompt_markdown": persona_prompt_markdown,
                    "persona_prompt_version": PersonaPromptRegistry.spec_for(persona_id).version,
                    "persona_prompt_hash": persona_prompt_hash,
                }
            )

        return {
            "pack_id": str(pack.pack_id),
            "risk_surface": str(pack.risk_surface),
            "iteration": task_iteration,
            "task_count": len(tasks),
            "tasks": tasks,
            "adjudication_policy": dict(adjudication_policy),
            "persona_contract_schema_version": self.PERSONA_CONTRACT_SCHEMA_VERSION,
            "generated_at": datetime.now(timezone.utc),
        }

    async def adjudicate_pack_scoped_outputs(
        self,
        *,
        pack_id: str,
        persona_outputs: list[dict[str, Any]],
    ) -> dict[str, Any]:
        scoped_results: list[dict[str, Any]] = []
        coverage_gaps: list[dict[str, Any]] = []
        blackboard_writes: list[dict[str, Any]] = []
        escalations: list[dict[str, Any]] = []
        calibration_records: list[dict[str, Any]] = []
        calibration_service = PersonaCalibrationService(self.db)

        for output in persona_outputs:
            if not isinstance(output, dict):
                continue
            assigned_pack_ids = output.get("assigned_pack_ids")
            assigned = (
                self._normalize_string_list(assigned_pack_ids)
                if isinstance(assigned_pack_ids, list)
                else [str(pack_id)]
            )
            if str(pack_id) not in assigned:
                continue

            persona_id = self._to_stable_persona_id(str(output.get("persona_id") or ""))
            scoped_results.append(
                {
                    "persona_id": persona_id,
                    "task_type": str(output.get("task_type") or "domain_review"),
                    "prompt_trace": self._normalize_prompt_trace(output.get("prompt_trace")),
                    "execution_trace": self._normalize_execution_trace(output.get("execution_trace")),
                    "confirmed_findings": output.get("confirmed_findings"),
                    "disputed_findings": output.get("disputed_findings"),
                    "new_findings": output.get("new_findings"),
                }
            )
            coverage_gaps.extend(self._normalize_dict_list(output.get("coverage_gaps")))
            blackboard_writes.extend(self._normalize_dict_list(output.get("blackboard_writes")))
            escalations.extend(self._normalize_dict_list(output.get("escalations")))

            hitl_review = output.get("hitl_review")
            if isinstance(hitl_review, dict):
                calibration_row = await calibration_service.record_hitl_review(
                    persona_id=persona_id,
                    task_type=str(output.get("task_type") or "domain_review"),
                    findings_reviewed=self._safe_int(hitl_review.get("findings_reviewed"), default=0, minimum=0),
                    findings_overturned=self._safe_int(hitl_review.get("findings_overturned"), default=0, minimum=0),
                    evidence_backed_claims=self._safe_int(hitl_review.get("evidence_backed_claims"), default=0, minimum=0),
                    total_claims=self._safe_int(hitl_review.get("total_claims"), default=0, minimum=0),
                    schema_valid_outputs=self._safe_int(hitl_review.get("schema_valid_outputs"), default=0, minimum=0),
                    total_outputs=self._safe_int(hitl_review.get("total_outputs"), default=0, minimum=0),
                    exception_correct_decisions=self._safe_int(hitl_review.get("exception_correct_decisions"), default=0, minimum=0),
                    exception_decisions_total=self._safe_int(hitl_review.get("exception_decisions_total"), default=0, minimum=0),
                    confidence_delta_samples=self._normalize_float_list(hitl_review.get("confidence_delta_samples")),
                    escalations_accepted=self._safe_int(hitl_review.get("escalations_accepted"), default=0, minimum=0),
                    escalations_total=self._safe_int(hitl_review.get("escalations_total"), default=0, minimum=0),
                )
                calibration_records.append(calibration_service.to_payload(calibration_row))

        if not scoped_results:
            raise ValueError("No persona outputs were assigned to this pack")

        adjudication = await self.adjudicate_pack(
            pack_id=pack_id,
            persona_results=scoped_results,
        )
        adjudication["persona_output_count"] = len(scoped_results)
        adjudication["coverage_gap_count"] = len(coverage_gaps)
        adjudication["blackboard_write_count"] = len(blackboard_writes)
        adjudication["escalation_count"] = len(escalations)
        adjudication["calibrations_recorded"] = calibration_records
        return adjudication

    async def adjudicate_pack(
        self,
        *,
        pack_id: str,
        persona_results: list[dict[str, Any]],
    ) -> dict[str, Any]:
        pack = await self.get_pack(pack_id=pack_id)
        if pack is None:
            raise ValueError(f"Unknown pack_id: {pack_id}")

        aggregated = self._aggregate_persona_results(persona_results)
        await self.db.execute(delete(PackFinding).where(PackFinding.pack_id == pack_id))

        now = datetime.now(timezone.utc)
        finding_rows: list[PackFinding] = []
        severity_counts = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
        suppressed_count = 0
        for finding in aggregated:
            if _is_false_positive_finding(finding):
                suppressed_count += 1
                continue
            severity = str(finding.get("severity") or "P3").upper()
            if severity not in severity_counts:
                severity = "P3"
            severity_counts[severity] += 1
            fingerprint = str(finding["finding_fingerprint"])
            canonical_finding_id = self._canonical_finding_id(
                run_id=str(pack.run_id or ""),
                finding_fingerprint=fingerprint,
            )
            finding_payload_hash = self._finding_payload_hash(
                run_id=str(pack.run_id or ""),
                finding_fingerprint=fingerprint,
                finding=finding,
                payload_hash_version=self.FINDING_PAYLOAD_HASH_VERSION,
            )
            finding_rows.append(
                PackFinding(
                    finding_id=self._finding_id(pack_id=pack_id, finding_fingerprint=fingerprint),
                    pack_id=pack_id,
                    finding_fingerprint=fingerprint,
                    canonical_finding_id=canonical_finding_id,
                    finding_payload_hash=finding_payload_hash,
                    payload_hash_version=self.FINDING_PAYLOAD_HASH_VERSION,
                    run_id=pack.run_id,
                    iteration=int(pack.iteration or 1),
                    owner_persona=str(finding.get("owner_persona") or "security-overlay"),
                    claim_status=str(finding.get("claim_status") or "candidate"),
                    persona_traces_json=self._normalize_persona_trace_list(
                        finding.get("persona_traces")
                    ),
                    reconciliation_json=(
                        finding.get("reconciliation")
                        if isinstance(finding.get("reconciliation"), dict)
                        else {}
                    ),
                    hitl_handoff_json=(
                        finding.get("hitl_handoff")
                        if isinstance(finding.get("hitl_handoff"), dict)
                        else {}
                    ),
                    severity=severity,
                    category=str(finding.get("category") or "general"),
                    scope_json=finding.get("scope") if isinstance(finding.get("scope"), dict) else {},
                    evidence_refs_json=self._normalize_string_list(finding.get("evidence_refs") or []),
                    impact=(str(finding.get("impact") or "").strip() or None),
                    remediation_guidance=(str(finding.get("remediation_guidance") or "").strip() or None),
                    verification_steps_json=self._normalize_string_list(
                        finding.get("verification_steps") or []
                    ),
                    confidence=float(finding.get("confidence") or 0.0),
                    provenance=(str(finding.get("provenance") or "").strip() or None),
                    exception_check_result=(
                        str(finding.get("exception_check_result") or "").strip() or None
                    ),
                    created_at=now,
                )
            )

        if finding_rows:
            self.db.add_all(finding_rows)
        pack.status = "adjudicated"
        pack.updated_at = now
        await self.db.commit()
        return {
            "pack_id": pack_id,
            "finding_count": len(finding_rows),
            "suppressed_count": suppressed_count,
            "severity_counts": severity_counts,
            "status": pack.status,
        }

    async def merge_pack_adjudications(
        self,
        *,
        run_id: str,
        pack_results: list[dict[str, Any]],
    ) -> dict[str, Any]:
        severity_counts = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
        total_findings = 0
        pack_ids: list[str] = []

        for result in pack_results:
            if not isinstance(result, dict):
                continue
            pack_id = str(result.get("pack_id") or "").strip()
            if pack_id:
                pack_ids.append(pack_id)
            total_findings += int(result.get("finding_count") or 0)
            result_counts = result.get("severity_counts")
            if isinstance(result_counts, dict):
                for severity in ("P0", "P1", "P2", "P3"):
                    severity_counts[severity] += int(result_counts.get(severity) or 0)

        highest_severity = "P3"
        for severity in ("P0", "P1", "P2", "P3"):
            if severity_counts[severity] > 0:
                highest_severity = severity
                break

        return {
            "run_id": run_id,
            "pack_count": len(pack_ids),
            "pack_ids": sorted(set(pack_ids)),
            "total_findings": total_findings,
            "severity_counts": severity_counts,
            "highest_severity": highest_severity,
            "status": "merged",
        }

    async def _upsert_blueprints(self, blueprints: list[dict[str, Any]]) -> list[InvestigationPack]:
        if not blueprints:
            return []
        pack_ids = [str(item["pack_id"]) for item in blueprints]
        existing_rows = await self.db.execute(
            select(InvestigationPack).where(InvestigationPack.pack_id.in_(pack_ids))
        )
        existing_by_pack_id = {str(row.pack_id): row for row in existing_rows.scalars().all()}
        now = datetime.now(timezone.utc)
        persisted: list[InvestigationPack] = []
        for blueprint in blueprints:
            pack_id = str(blueprint["pack_id"])
            row = existing_by_pack_id.get(pack_id)
            if row is None:
                row = InvestigationPack(
                    pack_id=pack_id,
                    run_id=blueprint.get("run_id"),
                    case_id=blueprint.get("case_id"),
                    iteration=int(blueprint.get("iteration") or 1),
                    risk_surface=str(blueprint.get("risk_surface") or "general"),
                    scope_files_json=self._normalize_string_list(blueprint.get("scope_files") or []),
                    scope_services_json=self._normalize_string_list(
                        blueprint.get("scope_services") or []
                    ),
                    detector_ids_json=self._normalize_string_list(blueprint.get("detector_ids") or []),
                    evidence_refs_json=self._normalize_string_list(
                        blueprint.get("evidence_refs") or []
                    ),
                    coverage_obligations_json=self._normalize_string_list(
                        blueprint.get("coverage_obligations") or []
                    ),
                    primary_persona=str(blueprint.get("primary_persona") or "").strip() or None,
                    supporting_personas_json=self._normalize_string_list(
                        blueprint.get("supporting_personas") or []
                    ),
                    policy_tags_json=self._normalize_string_list(blueprint.get("policy_tags") or []),
                    sensitivity_class=str(blueprint.get("sensitivity_class") or "standard"),
                    pack_fingerprint=str(blueprint.get("pack_fingerprint") or ""),
                    status=str(blueprint.get("status") or "created"),
                    created_at=now,
                    updated_at=now,
                )
                self.db.add(row)
            else:
                row.iteration = int(blueprint.get("iteration") or row.iteration or 1)
                row.risk_surface = str(blueprint.get("risk_surface") or row.risk_surface or "general")
                row.scope_files_json = self._normalize_string_list(
                    blueprint.get("scope_files") or row.scope_files_json or []
                )
                row.scope_services_json = self._normalize_string_list(
                    blueprint.get("scope_services") or row.scope_services_json or []
                )
                row.detector_ids_json = self._normalize_string_list(
                    blueprint.get("detector_ids") or row.detector_ids_json or []
                )
                row.evidence_refs_json = self._normalize_string_list(
                    blueprint.get("evidence_refs") or row.evidence_refs_json or []
                )
                row.coverage_obligations_json = self._normalize_string_list(
                    blueprint.get("coverage_obligations") or row.coverage_obligations_json or []
                )
                row.primary_persona = str(
                    blueprint.get("primary_persona") or row.primary_persona or ""
                ).strip() or None
                row.supporting_personas_json = self._normalize_string_list(
                    blueprint.get("supporting_personas") or row.supporting_personas_json or []
                )
                row.policy_tags_json = self._normalize_string_list(
                    blueprint.get("policy_tags") or row.policy_tags_json or []
                )
                row.sensitivity_class = str(
                    blueprint.get("sensitivity_class") or row.sensitivity_class or "standard"
                )
                row.pack_fingerprint = str(blueprint.get("pack_fingerprint") or row.pack_fingerprint)
                row.status = str(blueprint.get("status") or row.status or "created")
                row.updated_at = now
            persisted.append(row)

        await self.db.commit()
        return sorted(persisted, key=lambda row: str(row.pack_id))

    @classmethod
    def _build_pack_blueprints(
        cls,
        *,
        run_id: str,
        ingest_result: dict[str, Any],
        detector_seeds: list[Any],
    ) -> list[dict[str, Any]]:
        normalized_run_id = str(run_id or "").strip()
        if not normalized_run_id:
            raise ValueError("run_id is required for pack creation")

        iteration = cls._safe_int(ingest_result.get("iteration"), default=1, minimum=1)
        detector_ids = cls._normalize_detector_ids(detector_seeds)
        coverage_obligations = cls._normalize_string_list(
            ingest_result.get("coverage_obligations") or []
        )
        policy_tags = cls._normalize_string_list(ingest_result.get("policy_tags") or [])
        evidence_refs = cls._normalize_string_list(ingest_result.get("evidence_refs") or [])
        sensitivity_class = str(ingest_result.get("sensitivity_class") or "standard").strip() or "standard"

        explicit_packs = ingest_result.get("packs")
        blueprints: list[dict[str, Any]] = []
        if isinstance(explicit_packs, list) and explicit_packs:
            for pack_item in explicit_packs:
                if not isinstance(pack_item, dict):
                    continue
                risk_surface = str(pack_item.get("risk_surface") or "general").strip().lower() or "general"
                scope_files = cls._normalize_string_list(pack_item.get("scope_files") or [])
                scope_services = cls._normalize_string_list(pack_item.get("scope_services") or [])
                if not scope_files:
                    scope_files = cls._normalize_string_list(
                        ingest_result.get("scope_files")
                        or ingest_result.get("changed_files")
                        or ingest_result.get("files")
                        or []
                    )
                if not scope_services:
                    scope_services = cls._normalize_string_list(
                        ingest_result.get("scope_services") or ingest_result.get("services") or []
                    )
                blueprints.append(
                    cls._make_blueprint(
                        run_id=normalized_run_id,
                        case_id=None,
                        iteration=iteration,
                        risk_surface=risk_surface,
                        scope_files=scope_files,
                        scope_services=scope_services,
                        detector_ids=detector_ids,
                        evidence_refs=evidence_refs,
                        coverage_obligations=coverage_obligations,
                        policy_tags=policy_tags,
                        sensitivity_class=sensitivity_class,
                    )
                )
        else:
            scope_files = cls._normalize_string_list(
                ingest_result.get("scope_files")
                or ingest_result.get("changed_files")
                or ingest_result.get("files")
                or []
            )
            scope_services = cls._normalize_string_list(
                ingest_result.get("scope_services") or ingest_result.get("services") or []
            )
            risk_surfaces = cls._normalize_string_list(ingest_result.get("risk_surfaces") or [])
            if not risk_surfaces:
                risk_surfaces = [cls._derive_risk_surface(scope_files, scope_services)]
            for risk_surface in risk_surfaces:
                filtered_files = cls._filter_scope_by_risk_surface(scope_files, risk_surface)
                filtered_services = cls._filter_scope_by_risk_surface(scope_services, risk_surface)
                blueprints.append(
                    cls._make_blueprint(
                        run_id=normalized_run_id,
                        case_id=None,
                        iteration=iteration,
                        risk_surface=risk_surface,
                        scope_files=filtered_files or scope_files,
                        scope_services=filtered_services or scope_services,
                        detector_ids=detector_ids,
                        evidence_refs=evidence_refs,
                        coverage_obligations=coverage_obligations,
                        policy_tags=policy_tags,
                        sensitivity_class=sensitivity_class,
                    )
                )

        deduped: dict[str, dict[str, Any]] = {}
        for blueprint in blueprints:
            deduped[str(blueprint["pack_id"])] = blueprint
        return [deduped[key] for key in sorted(deduped.keys())]

    @classmethod
    def _make_blueprint(
        cls,
        *,
        run_id: str,
        case_id: str | None,
        iteration: int,
        risk_surface: str,
        scope_files: list[str],
        scope_services: list[str],
        detector_ids: list[str],
        evidence_refs: list[str],
        coverage_obligations: list[str],
        policy_tags: list[str],
        sensitivity_class: str,
    ) -> dict[str, Any]:
        normalized_risk = str(risk_surface or "general").strip().lower() or "general"
        normalized_scope_files = cls._normalize_string_list(scope_files)
        normalized_scope_services = cls._normalize_string_list(scope_services)
        fingerprint_payload = {
            "run_id": run_id,
            "case_id": case_id,
            "iteration": iteration,
            "risk_surface": normalized_risk,
            "scope_files": normalized_scope_files,
            "scope_services": normalized_scope_services,
            "detector_ids": cls._normalize_string_list(detector_ids),
            "evidence_refs": cls._normalize_string_list(evidence_refs),
            "coverage_obligations": cls._normalize_string_list(coverage_obligations),
            "policy_tags": cls._normalize_string_list(policy_tags),
            "sensitivity_class": str(sensitivity_class or "standard").strip() or "standard",
        }
        pack_fingerprint = cls._fingerprint(fingerprint_payload)
        pack_id = f"pack_{pack_fingerprint[:24]}"
        primary, supporting = cls._determine_persona_assignment(normalized_risk)
        return {
            "pack_id": pack_id,
            "pack_fingerprint": pack_fingerprint,
            "run_id": run_id,
            "case_id": case_id,
            "iteration": iteration,
            "risk_surface": normalized_risk,
            "scope_files": normalized_scope_files,
            "scope_services": normalized_scope_services,
            "detector_ids": cls._normalize_string_list(detector_ids),
            "evidence_refs": cls._normalize_string_list(evidence_refs),
            "coverage_obligations": cls._normalize_string_list(coverage_obligations),
            "primary_persona": primary,
            "supporting_personas": supporting,
            "policy_tags": cls._normalize_string_list(policy_tags),
            "sensitivity_class": str(sensitivity_class or "standard").strip() or "standard",
            "status": "created",
        }

    @classmethod
    def _derive_risk_surface(cls, scope_files: list[str], scope_services: list[str]) -> str:
        tokens = " ".join(scope_files + scope_services).lower()
        if any(token in tokens for token in ("auth", "permission", "oauth", "session")):
            return "security_overlay"
        if any(token in tokens for token in ("terraform", "k8s", "docker", "infra")):
            return "infrastructure"
        if any(token in tokens for token in ("react", "next", "frontend", ".tsx", ".jsx")):
            return "frontend_runtime"
        if any(token in tokens for token in ("sql", "migration", "db", "postgres")):
            return "data_layer"
        return "general"

    @staticmethod
    def _derive_risk_surface_from_event(event_type: str) -> str:
        normalized = str(event_type or "").strip().lower()
        if normalized in {"pull_request", "check_run", "issue_comment"}:
            return "security_overlay"
        if normalized in {"push", "workflow_run"}:
            return "release_engineering"
        if normalized == "release":
            return "infrastructure"
        return "general"

    @classmethod
    def _filter_scope_by_risk_surface(cls, values: list[str], risk_surface: str) -> list[str]:
        normalized_risk = str(risk_surface or "").strip().lower()
        if normalized_risk == "security_overlay":
            keywords = ("auth", "permission", "token", "session", "oauth")
        elif normalized_risk == "frontend_runtime":
            keywords = ("frontend", "ui", ".tsx", ".jsx", ".css", "react", "next")
        elif normalized_risk == "data_layer":
            keywords = ("migration", "sql", "db", "orm", "query")
        elif normalized_risk == "infrastructure":
            keywords = ("terraform", "infra", "k8s", "docker", "helm")
        elif normalized_risk == "release_engineering":
            keywords = ("workflow", "github", "actions", "ci", "cd", "release")
        else:
            return []

        filtered = []
        for value in values:
            token = str(value).lower()
            if any(keyword in token for keyword in keywords):
                filtered.append(value)
        return cls._normalize_string_list(filtered)

    @staticmethod
    def _determine_persona_assignment(risk_surface: str) -> tuple[str, list[str]]:
        normalized = str(risk_surface or "general").strip().lower()
        mapping: dict[str, tuple[str, list[str]]] = {
            "security_overlay": (
                "security-overlay",
                ["backend-runtime", "data-layer", "reliability-sre"],
            ),
            "backend_runtime": (
                "backend-runtime",
                ["security-overlay", "reliability-sre"],
            ),
            "frontend_runtime": (
                "frontend-runtime",
                ["security-overlay", "testing-correctness"],
            ),
            "data_layer": (
                "data-layer",
                ["backend-runtime", "security-overlay"],
            ),
            "infrastructure": (
                "infrastructure-iac",
                ["release-engineering", "reliability-sre"],
            ),
            "release_engineering": (
                "release-engineering",
                ["supply-chain", "reliability-sre"],
            ),
            "reliability_sre": (
                "reliability-sre",
                ["backend-runtime", "observability"],
            ),
            "observability": (
                "observability",
                ["reliability-sre", "release-engineering"],
            ),
            "testing_correctness": (
                "testing-correctness",
                ["backend-runtime", "frontend-runtime"],
            ),
            "supply_chain": (
                "supply-chain",
                ["release-engineering", "security-overlay"],
            ),
            "code_quality": (
                "code-quality",
                ["backend-runtime", "testing-correctness"],
            ),
            "docs_knowledge": (
                "docs-knowledge",
                ["release-engineering", "observability"],
            ),
            "ai_pipeline": (
                "ai-pipeline",
                ["security-overlay", "release-engineering"],
            ),
            "general": (
                "security-overlay",
                ["backend-runtime", "testing-correctness"],
            ),
        }
        return mapping.get(normalized, mapping["general"])

    @classmethod
    def _aggregate_persona_results(
        cls,
        persona_results: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for persona_result in persona_results:
            if not isinstance(persona_result, dict):
                continue
            persona_id = str(persona_result.get("persona_id") or "").strip() or "unknown-persona"
            task_type = str(persona_result.get("task_type") or "domain_review").strip() or "domain_review"
            prompt_trace = cls._normalize_prompt_trace(persona_result.get("prompt_trace"))
            execution_trace = cls._normalize_execution_trace(persona_result.get("execution_trace"))
            sources = [
                ("confirmed", persona_result.get("confirmed_findings")),
                ("disputed", persona_result.get("disputed_findings")),
                ("candidate", persona_result.get("new_findings")),
                ("candidate", persona_result.get("findings")),
            ]
            for claim_status, findings in sources:
                if not isinstance(findings, list):
                    continue
                for item in findings:
                    if not isinstance(item, dict):
                        continue
                    normalized = dict(item)
                    normalized["claim_status"] = str(
                        normalized.get("claim_status") or claim_status
                    ).strip().lower() or claim_status
                    normalized["owner_persona"] = str(
                        normalized.get("owner_persona") or persona_id
                    ).strip() or persona_id
                    if prompt_trace:
                        normalized["prompt_trace"] = dict(prompt_trace)
                    if execution_trace:
                        normalized["execution_trace"] = dict(execution_trace)
                    normalized["task_type"] = task_type
                    fingerprint = str(
                        normalized.get("finding_fingerprint")
                        or normalized.get("fingerprint")
                        or ""
                    ).strip()
                    if not fingerprint:
                        fingerprint = cls._fingerprint(
                            {
                                "persona": normalized["owner_persona"],
                                "category": normalized.get("category"),
                                "scope": normalized.get("scope"),
                                "evidence_refs": normalized.get("evidence_refs"),
                                "impact": normalized.get("impact"),
                            }
                        )[:32]
                    grouped.setdefault(fingerprint, []).append(normalized)

        aggregated: list[dict[str, Any]] = []
        for finding_fingerprint in sorted(grouped.keys()):
            entries = grouped[finding_fingerprint]
            best = max(
                entries,
                key=lambda entry: (
                    cls._severity_rank(str(entry.get("severity") or "P3")),
                    float(entry.get("confidence") or 0.0),
                ),
            )
            claim_statuses = {str(item.get("claim_status") or "candidate").lower() for item in entries}
            if "disputed" in claim_statuses and "confirmed" in claim_statuses:
                claim_status = "disputed"
            elif "confirmed" in claim_statuses:
                claim_status = "confirmed"
            elif "disputed" in claim_statuses:
                claim_status = "disputed"
            else:
                claim_status = "candidate"
            evidence_refs: list[str] = []
            for item in entries:
                evidence_refs.extend(cls._normalize_string_list(item.get("evidence_refs") or []))
            persona_traces = cls._build_persona_trace_entries(entries)
            confidence = min(1.0, max(0.0, float(best.get("confidence") or 0.0)))
            severity = cls._normalize_severity(str(best.get("severity") or "P3"))
            reconciliation = cls._build_reconciliation_summary(
                claim_status=claim_status,
                severity=severity,
                confidence=confidence,
                evidence_refs=cls._normalize_string_list(evidence_refs),
                persona_traces=persona_traces,
            )
            hitl_handoff = cls._build_hitl_handoff(
                claim_status=claim_status,
                severity=severity,
                confidence=confidence,
                evidence_refs=cls._normalize_string_list(evidence_refs),
                reconciliation=reconciliation,
            )

            aggregated.append(
                {
                    "finding_fingerprint": finding_fingerprint,
                    "owner_persona": str(best.get("owner_persona") or "unknown-persona"),
                    "claim_status": claim_status,
                    "severity": severity,
                    "category": str(best.get("category") or "general"),
                    "scope": best.get("scope") if isinstance(best.get("scope"), dict) else {},
                    "evidence_refs": cls._normalize_string_list(evidence_refs),
                    "impact": (str(best.get("impact") or "").strip() or None),
                    "remediation_guidance": (
                        str(best.get("remediation_guidance") or "").strip() or None
                    ),
                    "verification_steps": cls._normalize_string_list(
                        best.get("verification_steps") or []
                    ),
                    "confidence": confidence,
                    "provenance": (str(best.get("provenance") or "").strip() or None),
                    "persona_traces": persona_traces,
                    "reconciliation": reconciliation,
                    "hitl_handoff": hitl_handoff,
                    "exception_check_result": (
                        str(best.get("exception_check_result") or "").strip() or None
                    ),
                }
            )

        return aggregated

    @classmethod
    def _to_stable_persona_id(cls, value: str) -> str:
        candidate = str(value or "").strip().lower()
        if not candidate:
            return "unknown_persona"
        return cls._PERSONA_ID_ALIASES.get(candidate, candidate.replace("-", "_"))

    @staticmethod
    def _normalize_budget(raw_budget: dict[str, Any]) -> dict[str, int]:
        token_cap = 0
        time_seconds = 0
        if isinstance(raw_budget, dict):
            token_cap = int(raw_budget.get("token_cap") or 0)
            time_seconds = int(raw_budget.get("time_seconds") or 0)
        token_cap = max(0, min(token_cap, 2_000_000))
        time_seconds = max(0, min(time_seconds, 43_200))
        return {
            "token_cap": token_cap,
            "time_seconds": time_seconds,
        }

    @staticmethod
    def _normalize_write_policy(raw_write_policy: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(raw_write_policy, dict):
            return {"mode": "append_only", "allow_overwrite": False}
        mode = str(raw_write_policy.get("mode") or "append_only").strip().lower() or "append_only"
        if mode not in {"append_only", "readonly"}:
            mode = "append_only"
        allow_overwrite = bool(raw_write_policy.get("allow_overwrite", False))
        return {
            "mode": mode,
            "allow_overwrite": allow_overwrite and mode != "readonly",
        }

    @classmethod
    def _default_allowed_tools_for_risk(cls, risk_surface: str) -> list[str]:
        normalized_risk = str(risk_surface or "").strip().lower()
        base_tools = ["repo.read", "evidence.read", "blackboard.append"]
        by_risk = {
            "security_overlay": ["policy.read", "auth.graph.read"],
            "backend_runtime": ["runtime.trace.read", "api.contract.read"],
            "frontend_runtime": ["dom.surface.read"],
            "data_layer": ["schema.read", "migration.read"],
            "infrastructure": ["iac.read", "state.read"],
            "release_engineering": ["workflow.read", "artifact.read"],
            "reliability_sre": ["slo.read", "incident.read"],
            "observability": ["telemetry.read", "alert.read"],
            "testing_correctness": ["tests.read", "coverage.read"],
            "supply_chain": ["dependency.read", "sbom.read"],
            "code_quality": ["complexity.read", "lint.read"],
            "docs_knowledge": ["docs.read", "runbook.read"],
            "ai_pipeline": ["prompt.read", "policy.read", "eval.read"],
        }
        merged = base_tools + by_risk.get(normalized_risk, [])
        return cls._normalize_string_list(merged)

    @classmethod
    def _persona_contract_for_id(cls, persona_id: str) -> dict[str, Any]:
        stable_id = cls._to_stable_persona_id(persona_id)
        base = cls._PERSONA_DOMAIN_CONTRACTS.get(
            stable_id,
            cls._PERSONA_DOMAIN_CONTRACTS["unknown_persona"],
        )
        return {
            "schema_version": cls.PERSONA_CONTRACT_SCHEMA_VERSION,
            "persona_id": stable_id,
            "contract_id": str(base.get("contract_id") or "persona.unknown.generic.v1"),
            "domain_focus": cls._normalize_string_list(base.get("domain_focus") or []),
            "evidence_requirements": cls._normalize_string_list(
                base.get("evidence_requirements") or []
            ),
            "confidence_floor": max(0.0, min(1.0, float(base.get("confidence_floor") or 0.5))),
            "escalation_targets": cls._normalize_string_list(
                base.get("escalation_targets") or []
            ),
        }

    @classmethod
    def _adjudication_policy_for_risk_surface(cls, risk_surface: str) -> dict[str, Any]:
        normalized_risk = str(risk_surface or "").strip().lower() or "general"
        base = cls._RISK_SURFACE_ADJUDICATION_POLICY.get(
            normalized_risk,
            cls._RISK_SURFACE_ADJUDICATION_POLICY["general"],
        )
        return {
            "schema_version": cls.PERSONA_CONTRACT_SCHEMA_VERSION,
            "risk_surface": normalized_risk,
            "policy_id": str(base.get("policy_id") or "adjudication.general.v1"),
            "min_confidence_for_auto_confirm": max(
                0.0,
                min(1.0, float(base.get("min_confidence_for_auto_confirm") or 0.55)),
            ),
            "min_evidence_refs": max(0, int(base.get("min_evidence_refs") or 0)),
            "dispute_escalation_threshold": max(
                0, int(base.get("dispute_escalation_threshold") or 0)
            ),
            "max_new_findings_per_persona": max(
                1, int(base.get("max_new_findings_per_persona") or 1)
            ),
        }

    @classmethod
    def persona_contracts_for_pack(
        cls,
        *,
        primary_persona: str | None,
        supporting_personas: list[str] | None,
        include_all: bool = False,
    ) -> list[dict[str, Any]]:
        ordered: list[str] = []
        for candidate in [primary_persona or "", *(supporting_personas or [])]:
            normalized = str(candidate or "").strip()
            if normalized:
                ordered.append(normalized)
        if include_all:
            for candidate in cls._PERSONA_DOMAIN_CONTRACTS.keys():
                if candidate == "unknown_persona":
                    continue
                ordered.append(candidate)
        contracts: list[dict[str, Any]] = []
        seen_persona_ids: set[str] = set()
        for candidate in ordered:
            contract = cls._persona_contract_for_id(candidate)
            persona_id = str(contract.get("persona_id") or "").strip()
            if not persona_id or persona_id in seen_persona_ids:
                continue
            seen_persona_ids.add(persona_id)
            contracts.append(contract)
        return contracts

    @staticmethod
    def _is_full_depth_persona_mode(value: str | None) -> bool:
        normalized = str(value or "").strip().lower()
        return normalized in {"full_depth_13_persona", "full_depth", "13_persona"}

    @classmethod
    def adjudication_policy_for_pack(cls, *, risk_surface: str) -> dict[str, Any]:
        return cls._adjudication_policy_for_risk_surface(risk_surface)

    @classmethod
    def _normalize_allowed_tools(cls, allowed_tools: list[str]) -> list[str]:
        return cls._normalize_string_list(allowed_tools or [])

    @classmethod
    def _extract_baseline_candidates(cls, candidates: list[dict[str, Any]]) -> list[str]:
        if not isinstance(candidates, list):
            return []
        fingerprints: list[str] = []
        for item in candidates:
            if not isinstance(item, dict):
                continue
            fingerprint = str(
                item.get("finding_fingerprint") or item.get("fingerprint") or ""
            ).strip()
            if fingerprint:
                fingerprints.append(fingerprint)
        return cls._normalize_string_list(fingerprints)

    @staticmethod
    def _normalize_dict_list(raw_value: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_value, list):
            return []
        normalized: list[dict[str, Any]] = []
        for item in raw_value:
            if isinstance(item, dict):
                normalized.append(dict(item))
        return normalized

    @staticmethod
    def _normalize_float_list(raw_value: Any) -> list[float]:
        if not isinstance(raw_value, list):
            return []
        normalized: list[float] = []
        for item in raw_value:
            if isinstance(item, (int, float)):
                normalized.append(float(item))
        return normalized

    @staticmethod
    def _normalize_prompt_trace(raw_value: Any) -> dict[str, Any]:
        if not isinstance(raw_value, dict):
            return {}
        prompt_ref = str(raw_value.get("prompt_ref") or "").strip() or None
        prompt_version = str(raw_value.get("prompt_version") or "").strip() or None
        prompt_hash = str(raw_value.get("prompt_hash") or "").strip() or None
        if not any((prompt_ref, prompt_version, prompt_hash)):
            return {}
        return {
            "prompt_ref": prompt_ref,
            "prompt_version": prompt_version,
            "prompt_hash": prompt_hash,
        }

    @classmethod
    def _normalize_execution_trace(cls, raw_value: Any) -> dict[str, Any]:
        if not isinstance(raw_value, dict):
            return {}
        execution_mode = str(raw_value.get("execution_mode") or "").strip() or None
        task_index = cls._safe_int(raw_value.get("task_index"), default=0, minimum=0)
        duration_ms = cls._safe_int(raw_value.get("duration_ms"), default=0, minimum=0)
        role = str(raw_value.get("role") or "").strip() or None
        contract_id = str(raw_value.get("contract_id") or "").strip() or None
        started_at = str(raw_value.get("started_at") or "").strip() or None
        completed_at = str(raw_value.get("completed_at") or "").strip() or None
        assigned_pack_ids = cls._normalize_string_list(raw_value.get("assigned_pack_ids") or [])
        normalized = {
            "execution_mode": execution_mode,
            "task_index": task_index,
            "duration_ms": duration_ms,
            "role": role,
            "contract_id": contract_id,
            "started_at": started_at,
            "completed_at": completed_at,
            "assigned_pack_ids": assigned_pack_ids,
        }
        return {key: value for key, value in normalized.items() if value not in (None, [], "")}

    @classmethod
    def _normalize_persona_trace_list(cls, raw_value: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_value, list):
            return []
        normalized: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str, float]] = set()
        for item in raw_value:
            if not isinstance(item, dict):
                continue
            persona_id = cls._to_stable_persona_id(str(item.get("persona_id") or ""))
            claim_status = str(item.get("claim_status") or "candidate").strip().lower() or "candidate"
            if claim_status not in {"confirmed", "disputed", "candidate"}:
                claim_status = "candidate"
            severity = cls._normalize_severity(str(item.get("severity") or "P3"))
            try:
                confidence = float(item.get("confidence") or 0.0)
            except (TypeError, ValueError):
                confidence = 0.0
            confidence = max(0.0, min(1.0, confidence))
            contract_id = str(item.get("contract_id") or "").strip()
            evidence_refs = cls._normalize_string_list(item.get("evidence_refs") or [])
            prompt_trace = cls._normalize_prompt_trace(item.get("prompt_trace"))
            execution_trace = cls._normalize_execution_trace(item.get("execution_trace"))
            dedupe_key = (persona_id, claim_status, severity, confidence)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            row = {
                "persona_id": persona_id,
                "claim_status": claim_status,
                "severity": severity,
                "confidence": confidence,
                "contract_id": contract_id or cls._persona_contract_for_id(persona_id).get("contract_id"),
                "evidence_refs": evidence_refs,
            }
            if prompt_trace:
                row["prompt_trace"] = prompt_trace
            if execution_trace:
                row["execution_trace"] = execution_trace
            normalized.append(row)
        normalized.sort(key=lambda row: str(row.get("persona_id") or ""))
        return normalized

    @classmethod
    def _build_persona_trace_entries(cls, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        persona_rows: dict[str, dict[str, Any]] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            persona_id = cls._to_stable_persona_id(str(entry.get("owner_persona") or ""))
            claim_status = str(entry.get("claim_status") or "candidate").strip().lower() or "candidate"
            if claim_status not in {"confirmed", "disputed", "candidate"}:
                claim_status = "candidate"
            severity = cls._normalize_severity(str(entry.get("severity") or "P3"))
            try:
                confidence = float(entry.get("confidence") or 0.0)
            except (TypeError, ValueError):
                confidence = 0.0
            confidence = max(0.0, min(1.0, confidence))
            evidence_refs = cls._normalize_string_list(entry.get("evidence_refs") or [])
            contract = cls._persona_contract_for_id(persona_id)

            candidate = {
                "persona_id": persona_id,
                "claim_status": claim_status,
                "severity": severity,
                "confidence": confidence,
                "contract_id": str(contract.get("contract_id") or "").strip() or None,
                "evidence_refs": evidence_refs,
            }
            prompt_trace = cls._normalize_prompt_trace(entry.get("prompt_trace"))
            execution_trace = cls._normalize_execution_trace(entry.get("execution_trace"))
            if prompt_trace:
                candidate["prompt_trace"] = prompt_trace
            if execution_trace:
                candidate["execution_trace"] = execution_trace
            existing = persona_rows.get(persona_id)
            if existing is None:
                persona_rows[persona_id] = candidate
                continue

            existing_score = (
                cls._claim_status_rank(str(existing.get("claim_status") or "candidate")),
                cls._severity_rank(str(existing.get("severity") or "P3")),
                float(existing.get("confidence") or 0.0),
                len(cls._normalize_string_list(existing.get("evidence_refs") or [])),
            )
            candidate_score = (
                cls._claim_status_rank(claim_status),
                cls._severity_rank(severity),
                confidence,
                len(evidence_refs),
            )
            merged_evidence = cls._normalize_string_list(
                list(existing.get("evidence_refs") or []) + evidence_refs
            )
            if candidate_score >= existing_score:
                candidate["evidence_refs"] = merged_evidence
                if not candidate.get("prompt_trace") and existing.get("prompt_trace"):
                    candidate["prompt_trace"] = existing.get("prompt_trace")
                if not candidate.get("execution_trace") and existing.get("execution_trace"):
                    candidate["execution_trace"] = existing.get("execution_trace")
                persona_rows[persona_id] = candidate
            else:
                existing["evidence_refs"] = merged_evidence
                if not existing.get("prompt_trace") and candidate.get("prompt_trace"):
                    existing["prompt_trace"] = candidate.get("prompt_trace")
                if not existing.get("execution_trace") and candidate.get("execution_trace"):
                    existing["execution_trace"] = candidate.get("execution_trace")
                persona_rows[persona_id] = existing

        ordered = [persona_rows[key] for key in sorted(persona_rows.keys())]
        return cls._normalize_persona_trace_list(ordered)

    @classmethod
    def _build_reconciliation_summary(
        cls,
        *,
        claim_status: str,
        severity: str,
        confidence: float,
        evidence_refs: list[str],
        persona_traces: list[dict[str, Any]],
    ) -> dict[str, Any]:
        confirming = [
            str(item.get("persona_id") or "").strip()
            for item in persona_traces
            if str(item.get("claim_status") or "").strip().lower() == "confirmed"
        ]
        disputing = [
            str(item.get("persona_id") or "").strip()
            for item in persona_traces
            if str(item.get("claim_status") or "").strip().lower() == "disputed"
        ]
        candidates = [
            str(item.get("persona_id") or "").strip()
            for item in persona_traces
            if str(item.get("claim_status") or "").strip().lower() == "candidate"
        ]
        prompt_refs = cls._normalize_string_list(
            [
                str(((item.get("prompt_trace") or {}).get("prompt_ref")) or "").strip()
                for item in persona_traces
                if isinstance(item, dict)
            ]
        )
        persona_count = len(persona_traces)
        dominant_group_size = max(len(confirming), len(disputing), len(candidates), 0)
        agreement_ratio = round(
            (dominant_group_size / persona_count) if persona_count > 0 else 0.0,
            4,
        )
        normalized_claim_status = str(claim_status or "candidate").strip().lower() or "candidate"
        summary = (
            f"{len(confirming)}/{persona_count} confirmed, "
            f"{len(disputing)} disputed, {len(candidates)} candidate personas."
            if persona_count > 0
            else "No persona traces recorded."
        )
        return {
            "schema_version": "v1",
            "consensus_state": normalized_claim_status,
            "summary": summary,
            "persona_count": persona_count,
            "agreement_ratio": agreement_ratio,
            "confirming_personas": cls._normalize_string_list(confirming),
            "disputing_personas": cls._normalize_string_list(disputing),
            "candidate_personas": cls._normalize_string_list(candidates),
            "persona_prompt_refs": prompt_refs,
            "evidence_ref_count": len(cls._normalize_string_list(evidence_refs)),
            "severity": cls._normalize_severity(severity),
            "confidence": round(min(1.0, max(0.0, confidence)), 4),
        }

    @classmethod
    def _build_hitl_handoff(
        cls,
        *,
        claim_status: str,
        severity: str,
        confidence: float,
        evidence_refs: list[str],
        reconciliation: dict[str, Any],
    ) -> dict[str, Any]:
        normalized_claim_status = str(claim_status or "candidate").strip().lower() or "candidate"
        normalized_severity = cls._normalize_severity(severity)
        normalized_confidence = min(1.0, max(0.0, confidence))
        evidence_ref_count = len(cls._normalize_string_list(evidence_refs))
        agreement_ratio = max(
            0.0,
            min(1.0, float(reconciliation.get("agreement_ratio") or 0.0)),
        )
        reasons: list[str] = []
        if normalized_severity in {"P0", "P1"}:
            reasons.append("severity_requires_hitl")
        if normalized_claim_status == "disputed":
            reasons.append("persona_dispute")
        if normalized_claim_status != "confirmed":
            reasons.append("consensus_not_final")
        if agreement_ratio < 0.67:
            reasons.append("low_consensus")
        if evidence_ref_count < 2:
            reasons.append("thin_evidence")
        if normalized_confidence < 0.75:
            reasons.append("low_confidence")
        required = len(reasons) > 0
        priority = "normal"
        if normalized_severity == "P0":
            priority = "urgent"
        elif normalized_severity in {"P1", "P2"} or normalized_claim_status == "disputed":
            priority = "high"
        reviewer_roles = ["internal_hitl_reviewer"]
        if normalized_severity in {"P0", "P1"} or normalized_claim_status == "disputed":
            reviewer_roles.append("senior_reviewer")
        if normalized_severity == "P0":
            reviewer_roles.append("admin")
        return {
            "schema_version": "v1",
            "required": required,
            "reasons": cls._normalize_string_list(reasons),
            "review_priority": priority,
            "suggested_reviewer_roles": cls._normalize_string_list(reviewer_roles),
            "consensus_state": str(reconciliation.get("consensus_state") or normalized_claim_status),
            "consensus_summary": str(reconciliation.get("summary") or "").strip() or None,
            "persona_prompt_refs": cls._normalize_string_list(
                reconciliation.get("persona_prompt_refs") or []
            ),
        }

    @staticmethod
    def _claim_status_rank(value: str) -> int:
        normalized = str(value or "").strip().lower()
        rank = {"confirmed": 3, "disputed": 2, "candidate": 1}
        return rank.get(normalized, 0)

    @classmethod
    def _normalize_detector_ids(cls, detector_seeds: list[Any]) -> list[str]:
        normalized: list[str] = []
        for seed in detector_seeds:
            if isinstance(seed, str):
                normalized.append(seed)
                continue
            if isinstance(seed, dict):
                detector_id = str(seed.get("detector_id") or seed.get("id") or "").strip()
                if detector_id:
                    normalized.append(detector_id)
        return cls._normalize_string_list(normalized)

    @staticmethod
    def _normalize_string_list(values: list[Any]) -> list[str]:
        unique = set()
        normalized: list[str] = []
        for value in values:
            text = str(value or "").strip()
            if not text:
                continue
            if text in unique:
                continue
            unique.add(text)
            normalized.append(text)
        normalized.sort()
        return normalized

    @staticmethod
    def _safe_int(value: Any, *, default: int, minimum: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return max(default, minimum)
        return max(parsed, minimum)

    @staticmethod
    def _normalize_severity(value: str) -> str:
        normalized = str(value or "P3").strip().upper()
        if normalized in {"P0", "P1", "P2", "P3"}:
            return normalized
        return "P3"

    @classmethod
    def _canonical_finding_id(cls, *, run_id: str, finding_fingerprint: str) -> str:
        normalized_run_id = str(run_id or "").strip() or "run_unknown"
        normalized_fingerprint = str(finding_fingerprint or "").strip() or "fingerprint_unknown"
        digest = cls._fingerprint(
            {
                "run_id": normalized_run_id,
                "finding_fingerprint": normalized_fingerprint,
            }
        )[:32]
        return f"cf_{digest}"

    @classmethod
    def _finding_payload_hash(
        cls,
        *,
        run_id: str,
        finding_fingerprint: str,
        finding: dict[str, Any],
        payload_hash_version: str,
    ) -> str:
        scope = finding.get("scope") if isinstance(finding.get("scope"), dict) else {}
        scope_path = str(
            scope.get("path")
            or scope.get("file")
            or scope.get("file_path")
            or ""
        ).strip()
        line_start = cls._safe_int(scope.get("line_start"), default=0, minimum=0)
        line_end = cls._safe_int(scope.get("line_end"), default=0, minimum=0)
        if line_start > 0 and line_end > line_start:
            location_type = "line_range"
        elif line_start > 0:
            location_type = "line_exact"
        elif scope_path:
            location_type = "file_scope"
        else:
            location_type = "repo_scope"

        material_payload = {
            "payload_hash_version": str(payload_hash_version or "").strip() or "v1_material",
            "run_id": str(run_id or "").strip() or "run_unknown",
            "finding_fingerprint": str(finding_fingerprint or "").strip() or "fingerprint_unknown",
            "severity": cls._normalize_severity(str(finding.get("severity") or "P3")),
            "claim_text": str(
                finding.get("title")
                or finding.get("impact")
                or finding.get("category")
                or ""
            ).strip(),
            "location": {
                "location_type": location_type,
                "path": scope_path or None,
                "line_start": line_start if line_start > 0 else None,
                "line_end": line_end if line_end > 0 else None,
            },
            "evidence_refs": cls._normalize_string_list(finding.get("evidence_refs") or []),
            "repro_spec": cls._normalize_string_list(finding.get("verification_steps") or []),
            "verification_mode": (
                str(finding.get("verification_mode") or "").strip()
                or ("manual_only" if not finding.get("verification_steps") else "static")
            ),
            "rubric_version": str(finding.get("rubric_version") or "v1").strip() or "v1",
            "policy_version": str(finding.get("policy_version") or "v1").strip() or "v1",
        }
        return cls._fingerprint(material_payload)

    @classmethod
    def _severity_rank(cls, value: str) -> int:
        severity = cls._normalize_severity(value)
        rank = {"P0": 4, "P1": 3, "P2": 2, "P3": 1}
        return rank.get(severity, 0)

    @staticmethod
    def _fingerprint(payload: dict[str, Any]) -> str:
        normalized = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    @classmethod
    def _finding_id(cls, *, pack_id: str, finding_fingerprint: str) -> str:
        return f"finding_{cls._fingerprint({'pack_id': pack_id, 'fingerprint': finding_fingerprint})[:24]}"
