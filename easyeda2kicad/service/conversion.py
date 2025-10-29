from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

from easyeda2kicad.easyeda.easyeda_api import EasyedaApi
from easyeda2kicad.easyeda.easyeda_importer import (
    Easyeda3dModelImporter,
    EasyedaFootprintImporter,
    EasyedaSymbolImporter,
)
from easyeda2kicad.easyeda.parameters_easyeda import EeSymbol
from easyeda2kicad.helpers import (
    add_component_in_symbol_lib_file,
    add_sub_components_in_symbol_lib_file,
    id_already_in_symbol_lib,
    update_component_in_symbol_lib_file,
)
from easyeda2kicad.kicad.export_kicad_3d_model import Exporter3dModelKicad
from easyeda2kicad.kicad.export_kicad_footprint import ExporterFootprintKicad
from easyeda2kicad.kicad.export_kicad_symbol import ExporterSymbolKicad
from easyeda2kicad.kicad.parameters_kicad_symbol import KicadVersion, sanitize_fields


class ConversionStage(Enum):
    QUEUED = auto()
    FETCHING = auto()
    EXPORT_SYMBOL = auto()
    EXPORT_FOOTPRINT = auto()
    EXPORT_MODEL = auto()
    FINALISING = auto()
    COMPLETED = auto()
    FAILED = auto()


ProgressCallback = Callable[[ConversionStage, int, Optional[str]], None]


class ConversionError(RuntimeError):
    """Raised when a conversion cannot be completed."""


@dataclass
class ConversionRequest:
    lcsc_id: str
    output_prefix: str
    overwrite: bool = False
    generate_symbol: bool = False
    generate_footprint: bool = False
    generate_model: bool = False
    kicad_version: KicadVersion = KicadVersion.v6
    project_relative: bool = False

    def __post_init__(self) -> None:
        if not self.lcsc_id or not self.lcsc_id.startswith("C"):
            raise ConversionError("LCSC ID must start with 'C'.")
        if not (
            self.generate_symbol or self.generate_footprint or self.generate_model
        ):
            raise ConversionError("At least one export target must be selected.")
        self.output_prefix = str(Path(self.output_prefix))


@dataclass
class ConversionResult:
    symbol_path: Optional[str] = None
    footprint_path: Optional[str] = None
    model_paths: Dict[str, str] = field(default_factory=dict)
    messages: List[str] = field(default_factory=list)


def _symbol_is_empty(symbol: EeSymbol) -> bool:
    return not any(
        [
            symbol.pins,
            symbol.rectangles,
            symbol.circles,
            symbol.arcs,
            symbol.ellipses,
            symbol.polylines,
            symbol.polygons,
            symbol.paths,
        ]
    )


def _ensure_output_scaffold(
    request: ConversionRequest,
) -> tuple[Path, str, str]:
    """
    Ensure output directories and base library file exist.

    Returns a tuple (output_prefix_path, footprint_dir, symbol_extension).
    """
    output_path = Path(request.output_prefix)
    base_dir = output_path.parent if output_path.parent != Path("") else Path(".")
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
    except PermissionError as exc:
        raise ConversionError(
            f"Missing permissions to create base folder '{base_dir}'."
        ) from exc

    footprint_dir = output_path.with_suffix(".pretty")
    model_dir = output_path.with_suffix(".3dshapes")
    try:
        if request.generate_footprint:
            footprint_dir.mkdir(exist_ok=True)
        if request.generate_model or request.generate_footprint:
            model_dir.mkdir(exist_ok=True)
    except PermissionError as exc:
        raise ConversionError(
            f"Missing permissions to create library folders under '{base_dir}'."
        ) from exc

    symbol_extension = "kicad_sym" if request.kicad_version == KicadVersion.v6 else "lib"
    symbol_path = output_path.with_suffix(f".{symbol_extension}")
    if request.generate_symbol and not symbol_path.exists():
        try:
            with open(symbol_path, "w", encoding="utf-8") as symbol_file:
                if request.kicad_version == KicadVersion.v6:
                    symbol_file.write(
                        "(kicad_symbol_lib\n"
                        "  (version 20211014)\n"
                        "  (generator https://github.com/uPesy/easyeda2kicad.py)\n"
                        ")"
                    )
                else:
                    symbol_file.write(
                        "EESchema-LIBRARY Version 2.4\n#encoding utf-8\n"
                    )
        except OSError as exc:
            raise ConversionError(
                f"Unable to initialize symbol library file '{symbol_path}'."
            ) from exc

    return output_path, str(footprint_dir), symbol_extension


def _footprint_exists(lib_path: str, package_name: str) -> bool:
    return Path(lib_path, f"{package_name}.kicad_mod").is_file()


def run_conversion(
    request: ConversionRequest, progress_cb: Optional[ProgressCallback] = None
) -> ConversionResult:
    """
    Execute easyeda2kicad exports based on the incoming request.

    Raises ConversionError on failure.
    """

    def notify(stage: ConversionStage, steps_done: int, total_steps: int, message: str):
        if not progress_cb:
            return
        percent = int((steps_done / total_steps) * 100) if total_steps else 0
        percent = max(0, min(100, percent))
        progress_cb(stage, percent, message)

    steps_total = 1  # Fetching counts as one step
    if request.generate_symbol:
        steps_total += 1
    if request.generate_footprint:
        steps_total += 1
    if request.generate_model:
        steps_total += 1

    completed_steps = 0
    notify(
        ConversionStage.FETCHING,
        completed_steps,
        steps_total,
        "Fetching component data from EasyEDA.",
    )

    output_path, footprint_dir, symbol_ext = _ensure_output_scaffold(request)
    symbol_file = output_path.with_suffix(f".{symbol_ext}")
    model_dir = output_path.with_suffix(".3dshapes")
    library_name = output_path.name

    api = EasyedaApi()
    try:
        cad_data = api.get_cad_data_of_component(lcsc_id=request.lcsc_id)
    except Exception as exc:  # pragma: no cover - network errors bubble up
        raise ConversionError(
            f"Failed to fetch data for {request.lcsc_id}: {exc}"
        ) from exc

    if not cad_data:
        raise ConversionError(
            f"No CAD data received for component {request.lcsc_id}."
        )

    completed_steps += 1
    notify(
        ConversionStage.FETCHING,
        completed_steps,
        steps_total,
        "Component data downloaded.",
    )

    result = ConversionResult()

    easyeda_footprint = None

    if request.generate_symbol:
        notify(
            ConversionStage.EXPORT_SYMBOL,
            completed_steps,
            steps_total,
            "Generating symbol.",
        )
        importer = EasyedaSymbolImporter(easyeda_cp_cad_data=cad_data)
        primary_symbol: EeSymbol = importer.get_symbol()

        subparts_data = cad_data.get("subparts") or []
        sub_symbols: List[EeSymbol] = []
        if subparts_data:
            iterable = subparts_data
            if _symbol_is_empty(primary_symbol):
                primary_importer = EasyedaSymbolImporter(
                    easyeda_cp_cad_data=iterable[0]
                )
                primary_symbol = primary_importer.get_symbol()
                iterable = iterable[1:]
            for subpart_data in iterable:
                sub_importer = EasyedaSymbolImporter(easyeda_cp_cad_data=subpart_data)
                sub_symbols.append(sub_importer.get_symbol())

        sanitized_name = sanitize_fields(primary_symbol.info.name)
        existing = id_already_in_symbol_lib(
            lib_path=str(symbol_file),
            component_name=sanitized_name,
            kicad_version=request.kicad_version,
        )
        if existing and not request.overwrite:
            raise ConversionError(
                f"Symbol '{primary_symbol.info.name}' already exists. "
                "Set overwrite to update."
            )

        exporter = ExporterSymbolKicad(
            symbol=primary_symbol, kicad_version=request.kicad_version
        )
        exported_symbol = exporter.export(footprint_lib_name=library_name)

        exported_sub_symbols: List[str] = []
        for sub_symbol in sub_symbols:
            sub_exporter = ExporterSymbolKicad(
                symbol=sub_symbol, kicad_version=request.kicad_version
            )
            sub_export = sub_exporter.export(footprint_lib_name=library_name)
            if sub_export and sub_export != exported_symbol:
                exported_sub_symbols.append(sub_export)

        if existing:
            update_component_in_symbol_lib_file(
                lib_path=str(symbol_file),
                component_name=sanitized_name,
                component_content=exported_symbol,
                kicad_version=request.kicad_version,
            )
        else:
            add_component_in_symbol_lib_file(
                lib_path=str(symbol_file),
                component_content=exported_symbol,
                kicad_version=request.kicad_version,
            )
        if exported_sub_symbols and request.kicad_version == KicadVersion.v6:
            add_sub_components_in_symbol_lib_file(
                lib_path=str(symbol_file),
                component_name=sanitized_name,
                sub_components_content=exported_sub_symbols,
                kicad_version=request.kicad_version,
            )
        elif exported_sub_symbols:
            logging.warning(
                "Multi-unit symbols are only supported for KiCad v6 libraries; skipping"
                " additional units."
            )

        completed_steps += 1
        notify(
            ConversionStage.EXPORT_SYMBOL,
            completed_steps,
            steps_total,
            "Symbol export completed.",
        )
        result.symbol_path = str(symbol_file)

    if request.generate_footprint:
        notify(
            ConversionStage.EXPORT_FOOTPRINT,
            completed_steps,
            steps_total,
            "Generating footprint.",
        )
        importer = EasyedaFootprintImporter(easyeda_cp_cad_data=cad_data)
        easyeda_footprint = importer.get_footprint()

        footprint_exists = _footprint_exists(
            footprint_dir, easyeda_footprint.info.name
        )
        if footprint_exists and not request.overwrite:
            raise ConversionError(
                f"Footprint '{easyeda_footprint.info.name}' already exists. "
                "Set overwrite to update."
            )

        ki_footprint = ExporterFootprintKicad(footprint=easyeda_footprint)
        footprint_filename = f"{easyeda_footprint.info.name}.kicad_mod"
        model_path = str(model_dir).replace("\\", "/").replace("./", "/")
        if request.project_relative:
            model_path = "${KIPRJMOD}" + model_path

        ki_footprint.export(
            footprint_full_path=os.path.join(footprint_dir, footprint_filename),
            model_3d_path=model_path,
        )

        completed_steps += 1
        notify(
            ConversionStage.EXPORT_FOOTPRINT,
            completed_steps,
            steps_total,
            "Footprint export completed.",
        )
        result.footprint_path = os.path.join(footprint_dir, footprint_filename)

    if request.generate_model:
        notify(
            ConversionStage.EXPORT_MODEL,
            completed_steps,
            steps_total,
            "Generating 3D model.",
        )
        model_data = None
        if easyeda_footprint and easyeda_footprint.model_3d:
            model_data = easyeda_footprint.model_3d
        if model_data is None:
            model_data = Easyeda3dModelImporter(
                easyeda_cp_cad_data=cad_data, download_raw_3d_model=True
            ).output

        exporter = Exporter3dModelKicad(model_3d=model_data)
        exporter.export(lib_path=str(output_path))

        base_name = (
            os.path.splitext(exporter.input.name or "")[0]
            if exporter.input
            else ""
        )
        if not base_name:
            base_name = "easyeda_model"
        safe_base_name = base_name.replace("\\", "_").replace("/", "_")
        wrl_path = os.path.join(
            str(model_dir), f"{safe_base_name}.wrl"
        ) if exporter.output else None
        step_path = os.path.join(
            str(model_dir), f"{safe_base_name}.step"
        ) if exporter.output_step else None
        if wrl_path:
            result.model_paths["wrl"] = wrl_path
        if step_path:
            result.model_paths["step"] = step_path

        completed_steps += 1
        notify(
            ConversionStage.EXPORT_MODEL,
            completed_steps,
            steps_total,
            "3D model export completed.",
        )

    notify(
        ConversionStage.FINALISING,
        completed_steps,
        steps_total,
        "Finalising conversion.",
    )

    notify(ConversionStage.COMPLETED, steps_total, steps_total, "Conversion finished.")

    return result
