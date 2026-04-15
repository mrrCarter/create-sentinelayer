from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PersonaPromptSpec:
    persona_id: str
    title: str
    risk_surface: str
    file_name: str
    version: str = "v1"


class PersonaPromptRegistry:
    _ROOT = Path(__file__).resolve().parent.parent / "prompts" / "omar_personas"
    _SPECS: dict[str, PersonaPromptSpec] = {
        "nina_patel": PersonaPromptSpec(
            persona_id="nina_patel",
            title="Nina Patel - Security Overlay",
            risk_surface="security_overlay",
            file_name="nina_patel_security_overlay.md",
        ),
        "maya_volkov": PersonaPromptSpec(
            persona_id="maya_volkov",
            title="Maya Volkov - Backend Runtime",
            risk_surface="backend_runtime",
            file_name="maya_volkov_backend_runtime.md",
        ),
        "jules_tanaka": PersonaPromptSpec(
            persona_id="jules_tanaka",
            title="Jules Tanaka - Frontend Runtime",
            risk_surface="frontend_runtime",
            file_name="jules_tanaka_frontend_runtime.md",
        ),
        "linh_tran": PersonaPromptSpec(
            persona_id="linh_tran",
            title="Linh Tran - Data Layer",
            risk_surface="data_layer",
            file_name="linh_tran_data_layer.md",
        ),
        "kat_hughes": PersonaPromptSpec(
            persona_id="kat_hughes",
            title="Kat Hughes - Infrastructure",
            risk_surface="infrastructure",
            file_name="kat_hughes_infrastructure.md",
        ),
        "omar_singh": PersonaPromptSpec(
            persona_id="omar_singh",
            title="Omar Singh - Release Engineering",
            risk_surface="release_engineering",
            file_name="omar_singh_release_engineering.md",
        ),
        "noah_bendavid": PersonaPromptSpec(
            persona_id="noah_bendavid",
            title="Noah Ben-David - Reliability SRE",
            risk_surface="reliability_sre",
            file_name="noah_bendavid_reliability_sre.md",
        ),
        "sofia_alvarez": PersonaPromptSpec(
            persona_id="sofia_alvarez",
            title="Sofia Alvarez - Observability",
            risk_surface="observability",
            file_name="sofia_alvarez_observability.md",
        ),
        "priya_raman": PersonaPromptSpec(
            persona_id="priya_raman",
            title="Priya Raman - Testing Correctness",
            risk_surface="testing_correctness",
            file_name="priya_raman_testing_correctness.md",
        ),
        "nora_kline": PersonaPromptSpec(
            persona_id="nora_kline",
            title="Nora Kline - Supply Chain",
            risk_surface="supply_chain",
            file_name="nora_kline_supply_chain.md",
        ),
        "ethan_park": PersonaPromptSpec(
            persona_id="ethan_park",
            title="Ethan Park - Code Quality",
            risk_surface="code_quality",
            file_name="ethan_park_code_quality.md",
        ),
        "samir_okafor": PersonaPromptSpec(
            persona_id="samir_okafor",
            title="Samir Okafor - Docs Knowledge",
            risk_surface="docs_knowledge",
            file_name="samir_okafor_docs_knowledge.md",
        ),
        "amina_chen": PersonaPromptSpec(
            persona_id="amina_chen",
            title="Amina Chen - AI Pipeline",
            risk_surface="ai_pipeline",
            file_name="amina_chen_ai_pipeline.md",
        ),
    }

    @classmethod
    def required_persona_ids(cls) -> list[str]:
        return sorted(cls._SPECS.keys())

    @classmethod
    def prompt_path(cls, persona_id: str) -> Path:
        spec = cls.spec_for(persona_id)
        return cls._ROOT / spec.file_name

    @classmethod
    def prompt_ref(cls, persona_id: str) -> str:
        spec = cls.spec_for(persona_id)
        return f"src/prompts/omar_personas/{spec.file_name}"

    @classmethod
    def spec_for(cls, persona_id: str) -> PersonaPromptSpec:
        normalized = str(persona_id or "").strip()
        if normalized not in cls._SPECS:
            raise KeyError(f"Unknown persona prompt id: {normalized}")
        return cls._SPECS[normalized]

    @classmethod
    def load_prompt(cls, persona_id: str) -> str:
        path = cls.prompt_path(persona_id)
        return path.read_text(encoding="utf-8")

    @classmethod
    def render_prompt(
        cls,
        *,
        persona_id: str,
        pack_id: str,
        risk_surface: str,
        task: dict[str, Any],
        domain_contract: dict[str, Any],
        adjudication_policy: dict[str, Any],
    ) -> str:
        spec = cls.spec_for(persona_id)
        template = cls.load_prompt(persona_id)
        scoped_evidence = task.get("scoped_evidence") if isinstance(task.get("scoped_evidence"), dict) else {}
        replacements = {
            "PERSONA_ID": spec.persona_id,
            "PERSONA_TITLE": spec.title,
            "PROMPT_VERSION": spec.version,
            "PACK_ID": str(pack_id or "").strip(),
            "RISK_SURFACE": str(risk_surface or spec.risk_surface).strip(),
            "ASSIGNED_PACK_IDS": cls._bullet_list(task.get("assigned_pack_ids") or []),
            "SCOPE_FILES": cls._bullet_list(scoped_evidence.get("scope_files") or []),
            "SCOPE_SERVICES": cls._bullet_list(scoped_evidence.get("scope_services") or []),
            "EVIDENCE_REFS": cls._bullet_list(scoped_evidence.get("evidence_refs") or []),
            "BASELINE_CANDIDATES": cls._bullet_list(task.get("baseline_candidates") or []),
            "DOMAIN_FOCUS": cls._bullet_list(domain_contract.get("domain_focus") or []),
            "EVIDENCE_REQUIREMENTS": cls._bullet_list(domain_contract.get("evidence_requirements") or []),
            "ESCALATION_TARGETS": cls._bullet_list(domain_contract.get("escalation_targets") or []),
            "CONFIDENCE_FLOOR": str(domain_contract.get("confidence_floor") or "0.0"),
            "BLACKBOARD_EPOCH": str(task.get("blackboard_epoch") or "").strip(),
            "ALLOWED_TOOLS": cls._bullet_list(task.get("allowed_tools") or []),
            "WRITE_POLICY": json.dumps(task.get("write_policy") or {}, sort_keys=True),
            "BUDGET": json.dumps(task.get("budget") or {}, sort_keys=True),
            "ADJUDICATION_POLICY": json.dumps(adjudication_policy or {}, sort_keys=True),
            "ADJUDICATION_POLICY_ID": str(adjudication_policy.get("policy_id") or "").strip(),
        }
        rendered = template
        for key, value in replacements.items():
            rendered = rendered.replace(f"{{{{{key}}}}}", value)
        return rendered

    @classmethod
    def registry_manifest(cls) -> list[dict[str, str]]:
        return [
            {
                "persona_id": spec.persona_id,
                "title": spec.title,
                "risk_surface": spec.risk_surface,
                "prompt_ref": cls.prompt_ref(spec.persona_id),
                "version": spec.version,
            }
            for spec in sorted(cls._SPECS.values(), key=lambda item: item.persona_id)
        ]

    @staticmethod
    def _bullet_list(values: list[Any]) -> str:
        normalized = [
            str(value).strip()
            for value in values
            if str(value).strip()
        ]
        if not normalized:
            return "- none"
        return "\n".join(f"- {value}" for value in normalized)
