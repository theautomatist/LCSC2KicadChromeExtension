# Global imports
import argparse
import logging
import os
import re
import sys
from textwrap import dedent
from typing import List

from easyeda2kicad import __version__
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
    get_local_config,
    id_already_in_symbol_lib,
    set_logger,
    update_component_in_symbol_lib_file,
)
from easyeda2kicad.kicad.export_kicad_3d_model import Exporter3dModelKicad
from easyeda2kicad.kicad.export_kicad_footprint import ExporterFootprintKicad
from easyeda2kicad.kicad.export_kicad_symbol import ExporterSymbolKicad
from easyeda2kicad.kicad.parameters_kicad_symbol import KicadVersion, sanitize_fields


def symbol_is_empty(symbol: EeSymbol) -> bool:
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


def get_parser() -> argparse.ArgumentParser:

    parser = argparse.ArgumentParser(
        description=(
            "A Python script that convert any electronic components from LCSC or"
            " EasyEDA to a Kicad library"
        )
    )

    parser.add_argument("--lcsc_id", help="LCSC id", required=True, type=str)

    parser.add_argument(
        "--symbol", help="Get symbol of this id", required=False, action="store_true"
    )

    parser.add_argument(
        "--footprint",
        help="Get footprint of this id",
        required=False,
        action="store_true",
    )

    parser.add_argument(
        "--3d",
        help="Get the 3d model of this id",
        required=False,
        action="store_true",
    )

    parser.add_argument(
        "--full",
        help="Get the symbol, footprint and 3d model of this id",
        required=False,
        action="store_true",
    )

    parser.add_argument(
        "--output",
        required=False,
        metavar="file.kicad_sym",
        help="Output file",
        type=str,
    )

    parser.add_argument(
        "--overwrite",
        required=False,
        help=(
            "overwrite symbol and footprint lib if there is already a component with"
            " this lcsc_id"
        ),
        action="store_true",
    )

    parser.add_argument(
        "--v5",
        required=False,
        help="Convert library in legacy format for KiCad 5.x",
        action="store_true",
    )

    parser.add_argument(
        "--project-relative",
        required=False,
        help="Sets the 3D file path stored relative to the project",
        action="store_true",
    )

    parser.add_argument(
        "--debug",
        help="set the logging level to debug",
        required=False,
        default=False,
        action="store_true",
    )

    return parser


def valid_arguments(arguments: dict) -> bool:

    if not arguments["lcsc_id"].startswith("C"):
        logging.error("lcsc_id should start by C....")
        return False

    if arguments["full"]:
        arguments["symbol"], arguments["footprint"], arguments["3d"] = True, True, True

    if not any([arguments["symbol"], arguments["footprint"], arguments["3d"]]):
        logging.error(
            "Missing action arguments\n"
            "  easyeda2kicad --lcsc_id=C2040 --footprint\n"
            "  easyeda2kicad --lcsc_id=C2040 --symbol"
        )
        return False

    kicad_version = KicadVersion.v5 if arguments.get("v5") else KicadVersion.v6
    arguments["kicad_version"] = kicad_version

    if arguments["project_relative"] and not arguments["output"]:
        logging.error(
            "A project specific library path should be given with --output option when"
            " using --project-relative option\nFor example: easyeda2kicad"
            " --lcsc_id=C2040 --full"
            " --output=C:/Users/your_username/Documents/Kicad/6.0/projects/my_project"
            " --project-relative"
        )
        return False

    if arguments["output"]:
        base_folder = "/".join(arguments["output"].replace("\\", "/").split("/")[:-1])
        lib_name = (
            arguments["output"]
            .replace("\\", "/")
            .split("/")[-1]
            .split(".lib")[0]
            .split(".kicad_sym")[0]
        )

        if not os.path.isdir(base_folder):
            logging.error(f"Can't find the folder : {base_folder}")
            return False
    else:
        default_folder = os.path.join(
            os.path.expanduser("~"),
            "Documents",
            "Kicad",
            "easyeda2kicad",
        )
        if not os.path.isdir(default_folder):
            os.makedirs(default_folder, exist_ok=True)

        base_folder = default_folder
        lib_name = "easyeda2kicad"
        arguments["use_default_folder"] = True

    arguments["output"] = f"{base_folder}/{lib_name}"

    # Create new footprint folder if it does not exist
    if not os.path.isdir(f"{arguments['output']}.pretty"):
        os.mkdir(f"{arguments['output']}.pretty")
        logging.info(f"Create {lib_name}.pretty footprint folder in {base_folder}")

    # Create new 3d model folder if don't exist
    if not os.path.isdir(f"{arguments['output']}.3dshapes"):
        os.mkdir(f"{arguments['output']}.3dshapes")
        logging.info(f"Create {lib_name}.3dshapes 3D model folder in {base_folder}")

    lib_extension = "kicad_sym" if kicad_version == KicadVersion.v6 else "lib"
    if not os.path.isfile(f"{arguments['output']}.{lib_extension}"):
        with open(
            file=f"{arguments['output']}.{lib_extension}", mode="w+", encoding="utf-8"
        ) as my_lib:
            my_lib.write(
                dedent(
                    """\
                (kicad_symbol_lib
                  (version 20211014)
                  (generator https://github.com/uPesy/easyeda2kicad.py)
                )"""
                )
                if kicad_version == KicadVersion.v6
                else "EESchema-LIBRARY Version 2.4\n#encoding utf-8\n"
            )
        logging.info(f"Create {lib_name}.{lib_extension} symbol lib in {base_folder}")

    return True


def delete_component_in_symbol_lib(
    lib_path: str, component_id: str, component_name: str
) -> None:
    with open(file=lib_path, encoding="utf-8") as f:
        current_lib = f.read()
        new_data = re.sub(
            rf'(#\n# {component_name}\n#\n.*?F6 "{component_id}".*?ENDDEF\n)',
            "",
            current_lib,
            flags=re.DOTALL,
        )

    with open(file=lib_path, mode="w", encoding="utf-8") as my_lib:
        my_lib.write(new_data)


def fp_already_in_footprint_lib(lib_path: str, package_name: str) -> bool:
    if os.path.isfile(f"{lib_path}/{package_name}.kicad_mod"):
        logging.warning(f"The footprint for this id is already in {lib_path}")
        return True
    return False


def main(argv: List[str] = sys.argv[1:]) -> int:
    print(f"-- easyeda2kicad.py v{__version__} --")

    # cli interface
    parser = get_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as err:
        return err.code
    arguments = vars(args)

    if arguments["debug"]:
        set_logger(log_file=None, log_level=logging.DEBUG)
    else:
        set_logger(log_file=None, log_level=logging.INFO)

    if not valid_arguments(arguments=arguments):
        return 1

    # conf = get_local_config()

    component_id = arguments["lcsc_id"]
    kicad_version = arguments["kicad_version"]
    sym_lib_ext = "kicad_sym" if kicad_version == KicadVersion.v6 else "lib"

    # Get CAD data of the component using easyeda API
    api = EasyedaApi()
    cad_data = api.get_cad_data_of_component(lcsc_id=component_id)

    # API returned no data
    if not cad_data:
        logging.error(f"Failed to fetch data from EasyEDA API for part {component_id}")
        return 1

    # ---------------- SYMBOL ----------------
    if arguments["symbol"]:
        importer = EasyedaSymbolImporter(easyeda_cp_cad_data=cad_data)
        easyeda_symbol: EeSymbol = importer.get_symbol()

        subparts_data = cad_data.get("subparts") or []
        easyeda_sub_symbols: List[EeSymbol] = []
        if subparts_data:
            subparts_iterable = subparts_data
            if symbol_is_empty(easyeda_symbol):
                primary_subpart = subparts_iterable[0]
                primary_importer = EasyedaSymbolImporter(
                    easyeda_cp_cad_data=primary_subpart
                )
                easyeda_symbol = primary_importer.get_symbol()
                subparts_iterable = subparts_iterable[1:]
            for subpart_data in subparts_iterable:
                sub_importer = EasyedaSymbolImporter(easyeda_cp_cad_data=subpart_data)
                easyeda_sub_symbols.append(sub_importer.get_symbol())

        sanitized_component_name = sanitize_fields(easyeda_symbol.info.name)
        is_id_already_in_symbol_lib = id_already_in_symbol_lib(
            lib_path=f"{arguments['output']}.{sym_lib_ext}",
            component_name=sanitized_component_name,
            kicad_version=kicad_version,
        )

        if not arguments["overwrite"] and is_id_already_in_symbol_lib:
            logging.error("Use --overwrite to update the older symbol lib")
            return 1

        exporter = ExporterSymbolKicad(
            symbol=easyeda_symbol, kicad_version=kicad_version
        )
        # print(exporter.output)
        kicad_symbol_lib = exporter.export(
            footprint_lib_name=arguments["output"].split("/")[-1].split(".")[0],
        )

        kicad_sub_symbols_lib: List[str] = []
        for sub_symbol in easyeda_sub_symbols:
            sub_exporter = ExporterSymbolKicad(
                symbol=sub_symbol, kicad_version=kicad_version
            )
            exported_content = sub_exporter.export(
                footprint_lib_name=arguments["output"].split("/")[-1].split(".")[0]
            )
            if exported_content and exported_content != kicad_symbol_lib:
                kicad_sub_symbols_lib.append(exported_content)

        if is_id_already_in_symbol_lib:
            update_component_in_symbol_lib_file(
                lib_path=f"{arguments['output']}.{sym_lib_ext}",
                component_name=sanitized_component_name,
                component_content=kicad_symbol_lib,
                kicad_version=kicad_version,
            )
        else:
            add_component_in_symbol_lib_file(
                lib_path=f"{arguments['output']}.{sym_lib_ext}",
                component_content=kicad_symbol_lib,
                kicad_version=kicad_version,
            )
        if kicad_sub_symbols_lib and kicad_version == KicadVersion.v6:
            add_sub_components_in_symbol_lib_file(
                lib_path=f"{arguments['output']}.{sym_lib_ext}",
                component_name=sanitized_component_name,
                sub_components_content=kicad_sub_symbols_lib,
                kicad_version=kicad_version,
            )
        elif kicad_sub_symbols_lib:
            logging.warning(
                "Multi-unit symbols are only supported for KiCad v6 libraries; "
                "skipping additional units."
            )

        logging.info(
            f"Created Kicad symbol for ID : {component_id}\n"
            f"       Symbol name : {easyeda_symbol.info.name}\n"
            f"       Library path : {arguments['output']}.{sym_lib_ext}"
        )

    # ---------------- FOOTPRINT ----------------
    easyeda_footprint = None

    if arguments["footprint"]:
        importer = EasyedaFootprintImporter(easyeda_cp_cad_data=cad_data)
        easyeda_footprint = importer.get_footprint()

        is_id_already_in_footprint_lib = fp_already_in_footprint_lib(
            lib_path=f"{arguments['output']}.pretty",
            package_name=easyeda_footprint.info.name,
        )
        if not arguments["overwrite"] and is_id_already_in_footprint_lib:
            logging.error("Use --overwrite to replace the older footprint lib")
            return 1

        ki_footprint = ExporterFootprintKicad(footprint=easyeda_footprint)
        footprint_filename = f"{easyeda_footprint.info.name}.kicad_mod"
        footprint_path = f"{arguments['output']}.pretty"
        model_3d_path = f"{arguments['output']}.3dshapes".replace("\\", "/").replace(
            "./", "/"
        )

        if arguments.get("use_default_folder"):
            model_3d_path = "${EASYEDA2KICAD}/easyeda2kicad.3dshapes"
        if arguments["project_relative"]:
            model_3d_path = "${KIPRJMOD}" + model_3d_path

        ki_footprint.export(
            footprint_full_path=f"{footprint_path}/{footprint_filename}",
            model_3d_path=model_3d_path,
        )

        logging.info(
            f"Created Kicad footprint for ID: {component_id}\n"
            f"       Footprint name: {easyeda_footprint.info.name}\n"
            f"       Footprint path: {os.path.join(footprint_path, footprint_filename)}"
        )

    # ---------------- 3D MODEL ----------------
    if arguments["3d"]:
        model_3d_data = None
        if easyeda_footprint and easyeda_footprint.model_3d:
            model_3d_data = easyeda_footprint.model_3d
        if model_3d_data is None:
            model_3d_data = Easyeda3dModelImporter(
                easyeda_cp_cad_data=cad_data, download_raw_3d_model=True
            ).output

        exporter = Exporter3dModelKicad(model_3d=model_3d_data)
        exporter.export(lib_path=arguments["output"])
        if exporter.output or exporter.output_step:
            model_base_name = os.path.splitext(exporter.input.name or "")[0] if exporter.input else ""
            if not model_base_name:
                model_base_name = "easyeda_model"
            model_base_name = model_base_name.replace("\\", "_").replace("/", "_")
            filename_wrl = f"{model_base_name}.wrl"
            filename_step = f"{model_base_name}.step"
            lib_path = f"{arguments['output']}.3dshapes"

            logging.info(
                f"Created 3D model for ID: {component_id}\n"
                f"       3D model name: {model_base_name}\n"
                + (
                    "       3D model path (wrl):"
                    f" {os.path.join(lib_path, filename_wrl)}\n"
                    if filename_wrl
                    else ""
                )
                + (
                    "       3D model path (step):"
                    f" {os.path.join(lib_path, filename_step)}\n"
                    if filename_step
                    else ""
                )
            )

        # logging.info(f"3D model: {os.path.join(lib_path, filename)}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
