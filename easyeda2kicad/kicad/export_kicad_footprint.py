# Global imports
import logging
import os
from math import acos, cos, isnan, pi, sin, sqrt
from typing import List, Optional, Tuple, Union

from easyeda2kicad.easyeda.parameters_easyeda import ee_footprint
from easyeda2kicad.kicad.parameters_kicad_footprint import *

# ---------------------------------------


def to_radians(n: float) -> float:
    return (n / 180.0) * pi


def to_degrees(n: float) -> float:
    return (n / pi) * 180.0


# Elliptical arc implementation based on the SVG specification notes
# https://www.w3.org/TR/SVG11/implnote.html#ArcConversionEndpointToCenter


def compute_arc(
    start_x: float,
    start_y: float,
    radius_x: float,
    radius_y: float,
    angle: float,
    large_arc_flag: bool,
    sweep_flag: bool,
    end_x: float,
    end_y: float,
) -> Tuple[float, float, float]:
    # Compute the half distance between the current and the final point
    dx2 = (start_x - end_x) / 2.0
    dy2 = (start_y - end_y) / 2.0

    # Convert angle from degrees to radians
    angle = to_radians(angle % 360.0)
    cos_angle = cos(angle)
    sin_angle = sin(angle)

    # Step 1 : Compute (x1, y1)
    x1 = cos_angle * dx2 + sin_angle * dy2
    y1 = -sin_angle * dx2 + cos_angle * dy2

    # Ensure radii are large enough
    radius_x = abs(radius_x)
    radius_y = abs(radius_y)
    Pradius_x = radius_x * radius_x
    Pradius_y = radius_y * radius_y
    Px1 = x1 * x1
    Py1 = y1 * y1

    # check that radii are large enough

    radiiCheck = (
        Px1 / Pradius_x + Py1 / Pradius_y if Pradius_x != 0 and Pradius_y != 0 else 0
    )
    if radiiCheck > 1:
        radius_x = sqrt(radiiCheck) * radius_x
        radius_y = sqrt(radiiCheck) * radius_y
        Pradius_x = radius_x * radius_x
        Pradius_y = radius_y * radius_y

    # Step 2 : Compute (cx1, cy1)
    sign = -1 if large_arc_flag == sweep_flag else 1
    sq = 0
    if Pradius_x * Py1 + Pradius_y * Px1 > 0:
        sq = (Pradius_x * Pradius_y - Pradius_x * Py1 - Pradius_y * Px1) / (
            Pradius_x * Py1 + Pradius_y * Px1
        )
    sq = max(sq, 0)
    coef = sign * sqrt(sq)
    cx1 = coef * ((radius_x * y1) / radius_y)
    cy1 = coef * -((radius_y * x1) / radius_x) if radius_x != 0 else 0

    # Step 3 : Compute (cx, cy) from (cx1, cy1)
    sx2 = (start_x + end_x) / 2.0
    sy2 = (start_y + end_y) / 2.0
    # print(start_x, end_x)
    cx = sx2 + (cos_angle * cx1 - sin_angle * cy1)
    cy = sy2 + (sin_angle * cx1 + cos_angle * cy1)

    # Step 4 : Compute the angle_extent (dangle)
    ux = (x1 - cx1) / radius_x if radius_x != 0 else 0
    uy = (y1 - cy1) / radius_y if radius_y != 0 else 0
    vx = (-x1 - cx1) / radius_x if radius_x != 0 else 0
    vy = (-y1 - cy1) / radius_y if radius_y != 0 else 0

    # Compute the angle extent
    n = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
    p = ux * vx + uy * vy
    sign = -1 if (ux * vy - uy * vx) < 0 else 1
    if n != 0:
        clamped_ratio = max(-1, min(1, p / n))
        angle_extent = to_degrees(sign * acos(clamped_ratio))
    else:
        angle_extent = 360 + 359
    if not (sweep_flag) and angle_extent > 0:
        angle_extent -= 360
    elif sweep_flag and angle_extent < 0:
        angle_extent += 360

    angleExtent_sign = 1 if angle_extent < 0 else -1
    angle_extent = (abs(angle_extent) % 360) * angleExtent_sign

    return cx, cy, angle_extent


# ---------------------------------------


def fp_to_ki(dim: float) -> float:
    if dim not in ["", None] and isnan(float(dim)) is False:
        return round(float(dim) * 10 * 0.0254, 2)
    return dim


# ---------------------------------------


def drill_to_ki(
    hole_radius: float, hole_length: float, pad_height: float, pad_width: float
) -> str:
    if (
        hole_radius > 0
        and hole_length != ""
        and hole_length is not None
        and hole_length != 0
    ):
        max_distance_hole = max(hole_radius * 2, hole_length)
        pos_0 = pad_height - max_distance_hole
        pos_90 = pad_width - max_distance_hole
        max_distance = max(pos_0, pos_90)

        if max_distance == pos_0:
            return f"(drill oval {hole_radius*2} {hole_length})"
        else:
            return f"(drill oval {hole_length} {hole_radius*2})"
    if hole_radius > 0:
        return f"(drill {2 * hole_radius})"
    return ""


# ---------------------------------------


def angle_to_ki(rotation: float) -> Union[float, str]:
    if isnan(rotation) is False:
        return -(360 - rotation) if rotation > 180 else rotation
    return ""


# ---------------------------------------


def rotate(x: float, y: float, degrees: float) -> Tuple[float, float]:
    radians = (degrees / 180) * 2 * pi
    new_x = x * cos(radians) - y * sin(radians)
    new_y = x * sin(radians) + y * cos(radians)
    return new_x, new_y


# ---------------------------------------


def is_on_segment(
    x0: float, y0: float, x1: float, y1: float, px: float, py: float
) -> bool:
    epsilon = 1e-9
    return (
        min(x0, x1) <= px <= max(x0, x1)
        and min(y0, y1) <= py <= max(y0, y1)
        and abs((px - x0) * (y1 - y0) - (py - y0) * (x1 - x0)) < epsilon
    )


def is_left(x0: float, y0: float, x1: float, y1: float, px: float, py: float) -> bool:
    return ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) > 0


def is_point_in_polygon(
    point: Tuple[float, float], polygon: List[Tuple[float, float]]
) -> bool:
    x, y = point
    winding_number = 0
    n = len(polygon)

    for i in range(n):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % n]

        if is_on_segment(x0, y0, x1, y1, x, y):
            return True

        if y0 <= y < y1 and is_left(x0, y0, x1, y1, x, y):
            winding_number += 1
        elif y1 <= y < y0 and not is_left(x0, y0, x1, y1, x, y):
            winding_number -= 1

    return winding_number != 0


def get_circumscribed_regular_polygon(
    center: Tuple[float, float], radius: float, n: int
) -> List[Tuple[float, float]]:
    cx, cy = center
    return [
        (cx + radius * cos(2 * pi * i / n), cy + radius * sin(2 * pi * i / n))
        for i in range(n)
    ]


def is_circle_in_polygon(
    center: Tuple[float, float], radius: float, polygon: List[Tuple[float, float]]
) -> bool:
    return all(
        is_point_in_polygon(vertex, polygon)
        for vertex in get_circumscribed_regular_polygon(center, radius, 12)
    )


def get_bounds_of_polygon(
    polygon: List[Tuple[float, float]],
) -> Tuple[float, float, float, float]:
    min_x = min(polygon, key=lambda vertex: vertex[0])[0]
    max_x = max(polygon, key=lambda vertex: vertex[0])[0]
    min_y = min(polygon, key=lambda vertex: vertex[1])[1]
    max_y = max(polygon, key=lambda vertex: vertex[1])[1]
    return min_x, max_x, min_y, max_y


def frange(start: float, stop: float, step: float):
    count = int((stop - start) / step) + 1
    for i in range(count):
        yield start + step * i


def find_circle_center_in_polygon(
    polygon: List[Tuple[float, float]], radius: float
) -> Optional[Tuple[float, float]]:
    min_x, max_x, min_y, max_y = get_bounds_of_polygon(polygon)
    step = 0.05

    for x in frange(min_x, max_x, step):
        for y in frange(min_y, max_y, step):
            center = (x, y)
            if is_circle_in_polygon(center, radius, polygon):
                return center
    return None


def set_appropriate_position_for_custom_shape(
    ki_pad: KiFootprintPad, polygon: List[Tuple[float, float]]
) -> None:
    center = (ki_pad.pos_x, ki_pad.pos_y)
    radius = ki_pad.width / 2

    if is_circle_in_polygon(center, radius, polygon):
        return

    new_center = find_circle_center_in_polygon(polygon, radius)
    if new_center is None:
        logging.warning(
            f"The custom shape of PAD #${ki_pad.number} cannot contain its anchor pad"
        )
        return

    ki_pad.pos_x, ki_pad.pos_y = new_center


# ---------------------------------------


def sanitize_model_filename(name: str) -> str:
    base = os.path.splitext(name or "")[0]
    if not base:
        base = "easyeda_model"
    return base.replace("\\", "_").replace("/", "_")


def compute_geometry_center(footprint: ee_footprint) -> Tuple[float, float]:
    min_x = float("inf")
    max_x = float("-inf")
    min_y = float("inf")
    max_y = float("-inf")

    def update_bounds(x: float, y: float) -> None:
        nonlocal min_x, max_x, min_y, max_y
        if x < min_x:
            min_x = x
        if x > max_x:
            max_x = x
        if y < min_y:
            min_y = y
        if y > max_y:
            max_y = y

    def update_box(x1: float, y1: float, x2: float, y2: float) -> None:
        update_bounds(x1, y1)
        update_bounds(x2, y2)

    for pad in footprint.pads:
        half_w = pad.width / 2
        half_h = pad.height / 2
        update_box(
            pad.center_x - half_w,
            pad.center_y - half_h,
            pad.center_x + half_w,
            pad.center_y + half_h,
        )

    for track in footprint.tracks:
        if not track.points:
            continue
        points = [fp_to_ki(point) for point in track.points.split(" ") if point != ""]
        for idx in range(0, len(points), 2):
            try:
                update_bounds(points[idx], points[idx + 1])
            except IndexError:
                break

    for circle in footprint.circles:
        update_box(
            circle.cx - circle.radius,
            circle.cy - circle.radius,
            circle.cx + circle.radius,
            circle.cy + circle.radius,
        )

    for rectangle in footprint.rectangles:
        update_box(
            rectangle.x,
            rectangle.y,
            rectangle.x + rectangle.width,
            rectangle.y + rectangle.height,
        )

    for hole in footprint.holes:
        update_box(
            hole.center_x - hole.radius,
            hole.center_y - hole.radius,
            hole.center_x + hole.radius,
            hole.center_y + hole.radius,
        )

    for via in footprint.vias:
        update_box(
            via.center_x - via.radius,
            via.center_y - via.radius,
            via.center_x + via.radius,
            via.center_y + via.radius,
        )

    if min_x == float("inf") or min_y == float("inf"):
        min_x = footprint.bbox.x
        max_x = footprint.bbox.x
        min_y = footprint.bbox.y
        max_y = footprint.bbox.y

    return (
        (min_x + max_x) / 2,
        (min_y + max_y) / 2,
        min_x,
        max_x,
        min_y,
        max_y,
    )


class ExporterFootprintKicad:
    def __init__(self, footprint: ee_footprint):
        self.input = footprint
        if not isinstance(self.input, ee_footprint):
            logging.error("Unsupported conversion")
        else:
            self.generate_kicad_footprint()

    def generate_kicad_footprint(self) -> None:
        # Convert dimension from easyeda to kicad
        self.input.bbox.convert_to_mm()

        for fields in (
            self.input.pads,
            self.input.tracks,
            self.input.holes,
            self.input.vias,
            self.input.circles,
            self.input.rectangles,
            self.input.texts,
        ):
            for field in fields:
                field.convert_to_mm()

        ki_info = KiFootprintInfo(
            name=self.input.info.name, fp_type=self.input.info.fp_type
        )

        if self.input.model_3d is not None:
            self.input.model_3d.convert_to_mm()
            (
                footprint_center_x,
                footprint_center_y,
                footprint_min_x,
                footprint_max_x,
                footprint_min_y,
                footprint_max_y,
            ) = compute_geometry_center(self.input)
            footprint_origin_x = self.input.bbox.x
            footprint_origin_y = self.input.bbox.y

            local_center_x = footprint_center_x - footprint_origin_x
            local_center_y = footprint_center_y - footprint_origin_y
            footprint_width = footprint_max_x - footprint_min_x
            footprint_height = footprint_max_y - footprint_min_y

            model_translation_z = 0.0
            if (
                self.input.model_3d.center is not None
                and self.input.model_3d.size is not None
                and len(self.input.model_3d.center) == 3
                and len(self.input.model_3d.size) == 3
                and all(axis != 0 for axis in self.input.model_3d.size[:2])
                and self.input.model_3d.size[2] != 0
            ):
                model_center_x, model_center_y, model_center_z = self.input.model_3d.center
                model_size_x, model_size_y, model_size_z = self.input.model_3d.size
                scale_x = footprint_width / model_size_x if model_size_x else 1.0
                scale_y = footprint_height / model_size_y if model_size_y else 1.0
                model_translation_x = round(local_center_x - model_center_x * scale_x, 2)
                model_translation_y = -round(local_center_y - model_center_y * scale_y, 2)
                model_bottom_z = model_center_z - (model_size_z / 2)
                model_translation_z = -round(model_bottom_z, 2)
            else:
                api_translation_x = self.input.model_3d.translation.x
                api_translation_y = self.input.model_3d.translation.y
                model_translation_x = round(
                    api_translation_x - footprint_origin_x, 2
                )
                model_translation_y = -round(
                    api_translation_y - footprint_origin_y, 2
                )
                model_translation_z = (
                    -round(self.input.model_3d.translation.z, 2)
                    if self.input.info.fp_type == "smd"
                    else 0
                )

            ki_3d_model_info = Ki3dModel(
                name=self.input.model_3d.name,
                translation=Ki3dModelBase(
                    x=model_translation_x,
                    y=model_translation_y,
                    z=model_translation_z,
                ),
                rotation=Ki3dModelBase(
                    x=(360 - self.input.model_3d.rotation.x) % 360,
                    y=(360 - self.input.model_3d.rotation.y) % 360,
                    z=(360 - self.input.model_3d.rotation.z) % 360,
                ),
                raw_wrl=None,
            )
        else:
            ki_3d_model_info = None

        self.output = KiFootprint(info=ki_info, model_3d=ki_3d_model_info)

        # For pads
        for ee_pad in self.input.pads:
            ki_pad = KiFootprintPad(
                type="thru_hole" if ee_pad.hole_radius > 0 else "smd",
                shape=(
                    KI_PAD_SHAPE[ee_pad.shape]
                    if ee_pad.shape in KI_PAD_SHAPE
                    else "custom"
                ),
                pos_x=ee_pad.center_x - self.input.bbox.x,
                pos_y=ee_pad.center_y - self.input.bbox.y,
                width=max(ee_pad.width, 0.01),
                height=max(ee_pad.height, 0.01),
                layers=(
                    KI_PAD_LAYER if ee_pad.hole_radius <= 0 else KI_PAD_LAYER_THT
                ).get(ee_pad.layer_id, ""),
                number=ee_pad.number,
                drill=0.0,
                orientation=angle_to_ki(ee_pad.rotation),
                polygon="",
            )

            ki_pad.drill = drill_to_ki(
                ee_pad.hole_radius, ee_pad.hole_length, ki_pad.height, ki_pad.width
            )
            if "(" in ki_pad.number and ")" in ki_pad.number:
                ki_pad.number = ki_pad.number.split("(")[1].split(")")[0]

            # For custom polygon
            is_custom_shape = ki_pad.shape == "custom"
            point_list = [fp_to_ki(point) for point in ee_pad.points.split(" ")]
            if is_custom_shape:
                if len(point_list) <= 0:
                    logging.warning(
                        f"PAD ${ee_pad.id} is a polygon, but has no points defined"
                    )
                else:
                    ki_pad.width = KI_PAD_SIZE_MIN
                    ki_pad.height = KI_PAD_SIZE_MIN
                    ki_pad.orientation = 0

                    absolute_coords = [
                        (
                            point_list[i] - self.input.bbox.x,
                            point_list[i + 1] - self.input.bbox.y,
                        )
                        for i in range(0, len(point_list), 2)
                    ]
                    set_appropriate_position_for_custom_shape(
                        ki_pad=ki_pad, polygon=absolute_coords
                    )

                    relative_coords = [
                        (x - ki_pad.pos_x, y - ki_pad.pos_y)
                        for (x, y) in absolute_coords
                    ]
                    path = "".join(
                        f"(xy {round(x, 2)} {round(y, 2)})" for x, y in relative_coords
                    )
                    ki_pad.polygon = (
                        "\n\t\t(primitives \n\t\t\t(gr_poly \n\t\t\t\t(pts"
                        f" {path}\n\t\t\t\t) \n\t\t\t\t(width 0) \n\t\t\t)\n\t\t)\n\t"
                    )

            self.output.pads.append(ki_pad)

        # For tracks
        for ee_track in self.input.tracks:
            ki_track = KiFootprintTrack(
                layers=(
                    KI_PAD_LAYER[ee_track.layer_id]
                    if ee_track.layer_id in KI_PAD_LAYER
                    else "F.Fab"
                ),
                stroke_width=max(ee_track.stroke_width, 0.01),
            )

            # Generate line
            point_list = [fp_to_ki(point) for point in ee_track.points.split(" ")]
            for i in range(0, len(point_list) - 2, 2):
                ki_track.points_start_x.append(
                    round(point_list[i] - self.input.bbox.x, 2)
                )
                ki_track.points_start_y.append(
                    round(point_list[i + 1] - self.input.bbox.y, 2)
                )
                ki_track.points_end_x.append(
                    round(point_list[i + 2] - self.input.bbox.x, 2)
                )
                ki_track.points_end_y.append(
                    round(point_list[i + 3] - self.input.bbox.y, 2)
                )

            self.output.tracks.append(ki_track)

        # For holes
        for ee_hole in self.input.holes:
            ki_hole = KiFootprintHole(
                pos_x=ee_hole.center_x - self.input.bbox.x,
                pos_y=ee_hole.center_y - self.input.bbox.y,
                size=ee_hole.radius * 2,
            )

            self.output.holes.append(ki_hole)

        # For Vias
        for ee_via in self.input.vias:
            ki_via = KiFootprintVia(
                pos_x=ee_via.center_x - self.input.bbox.x,
                pos_y=ee_via.center_y - self.input.bbox.y,
                size=ee_via.radius * 2,
                diameter=ee_via.diameter,
            )

            self.output.vias.append(ki_via)

        # For circles
        for ee_circle in self.input.circles:
            ki_circle = KiFootprintCircle(
                cx=ee_circle.cx - self.input.bbox.x,
                cy=ee_circle.cy - self.input.bbox.y,
                end_x=0.0,
                end_y=0.0,
                layers=(
                    KI_LAYERS[ee_circle.layer_id]
                    if ee_circle.layer_id in KI_LAYERS
                    else "F.Fab"
                ),
                stroke_width=max(ee_circle.stroke_width, 0.01),
            )
            ki_circle.end_x = ki_circle.cx + ee_circle.radius
            ki_circle.end_y = ki_circle.cy
            self.output.circles.append(ki_circle)

        # For rectangles
        for ee_rectangle in self.input.rectangles:
            ki_rectangle = KiFootprintRectangle(
                layers=(
                    KI_PAD_LAYER[ee_rectangle.layer_id]
                    if ee_rectangle.layer_id in KI_PAD_LAYER
                    else "F.Fab"
                ),
                stroke_width=max(ee_rectangle.stroke_width, 0.01),
            )

            start_x = ee_rectangle.x - self.input.bbox.x
            start_y = ee_rectangle.y - self.input.bbox.y
            width = ee_rectangle.width
            height = ee_rectangle.height

            ki_rectangle.points_start_x = [
                start_x,
                start_x + width,
                start_x + width,
                start_x,
            ]
            ki_rectangle.points_start_y = [
                start_y,
                start_y,
                start_y + height,
                start_y + height,
            ]
            ki_rectangle.points_end_x = [
                start_x + width,
                start_x + width,
                start_x,
                start_x,
            ]
            ki_rectangle.points_end_y = [
                start_y,
                start_y + height,
                start_y + height,
                start_y,
            ]

            self.output.rectangles.append(ki_rectangle)

        # For arcs
        for ee_arc in self.input.arcs:
            arc_path = (
                ee_arc.path.replace(",", " ").replace("M ", "M").replace("A ", "A")
            )

            start_x, start_y = arc_path.split("A")[0][1:].split(" ", 1)
            start_x = fp_to_ki(start_x) - self.input.bbox.x
            start_y = fp_to_ki(start_y) - self.input.bbox.y

            arc_parameters = arc_path.split("A")[1].replace("  ", " ")
            (
                svg_rx,
                svg_ry,
                x_axis_rotation,
                large_arc,
                sweep,
                end_x,
                end_y,
            ) = arc_parameters.split(" ", 6)
            rx, ry = rotate(fp_to_ki(svg_rx), fp_to_ki(svg_ry), 0)

            end_x = fp_to_ki(end_x) - self.input.bbox.x
            end_y = fp_to_ki(end_y) - self.input.bbox.y
            if ry != 0:
                cx, cy, extent = compute_arc(
                    start_x,
                    start_y,
                    rx,
                    ry,
                    float(x_axis_rotation),
                    large_arc == "1",
                    sweep == "1",
                    end_x,
                    end_y,
                )
            else:
                cx = 0.0
                cy = 0.0
                extent = 0.0

            ki_arc = KiFootprintArc(
                start_x=cx,
                start_y=cy,
                end_x=end_x,
                end_y=end_y,
                angle=extent,
                layers=(
                    KI_LAYERS[ee_arc.layer_id]
                    if ee_arc.layer_id in KI_LAYERS
                    else "F.Fab"
                ),
                stroke_width=max(fp_to_ki(ee_arc.stroke_width), 0.01),
            )
            self.output.arcs.append(ki_arc)

        # For texts
        for ee_text in self.input.texts:
            ki_text = KiFootprintText(
                pos_x=ee_text.center_x - self.input.bbox.x,
                pos_y=ee_text.center_y - self.input.bbox.y,
                orientation=angle_to_ki(ee_text.rotation),
                text=ee_text.text,
                layers=(
                    KI_LAYERS[ee_text.layer_id]
                    if ee_text.layer_id in KI_LAYERS
                    else "F.Fab"
                ),
                font_size=max(ee_text.font_size, 1),
                thickness=max(ee_text.stroke_width, 0.01),
                display=" hide" if ee_text.is_displayed is False else "",
                mirror="",
            )
            ki_text.layers = (
                ki_text.layers.replace(".SilkS", ".Fab")
                if ee_text.type == "N"
                else ki_text.layers
            )
            ki_text.mirror = " mirror" if ki_text.layers[0] == "B" else ""
            self.output.texts.append(ki_text)

    def get_ki_footprint(self) -> KiFootprint:
        return self.output

    def export(self, footprint_full_path: str, model_3d_path: str) -> None:
        ki = self.output
        ki_lib = ""

        ki_lib += KI_MODULE_INFO.format(
            package_lib="easyeda2kicad", package_name=ki.info.name, edit="5DC5F6A4"
        )

        if ki.info.fp_type:
            ki_lib += KI_FP_TYPE.format(
                component_type=("smd" if ki.info.fp_type == "smd" else "through_hole")
            )

        # Get y_min and y_max to put component info
        y_low = min(pad.pos_y for pad in ki.pads)
        y_high = max(pad.pos_y for pad in ki.pads)

        ki_lib += KI_REFERENCE.format(pos_x="0", pos_y=y_low - 4)

        ki_lib += KI_PACKAGE_VALUE.format(
            package_name=ki.info.name, pos_x="0", pos_y=y_high + 4
        )
        ki_lib += KI_FAB_REF

        # ---------------------------------------

        for track in ki.tracks + ki.rectangles:
            for i in range(len(track.points_start_x)):
                ki_lib += KI_LINE.format(
                    start_x=track.points_start_x[i],
                    start_y=track.points_start_y[i],
                    end_x=track.points_end_x[i],
                    end_y=track.points_end_y[i],
                    layers=track.layers,
                    stroke_width=track.stroke_width,
                )

        for pad in ki.pads:
            ki_lib += KI_PAD.format(**vars(pad))

        for hole in ki.holes:
            ki_lib += KI_HOLE.format(**vars(hole))

        for via in ki.vias:
            ki_lib += KI_VIA.format(**vars(via))

        for circle in ki.circles:
            ki_lib += KI_CIRCLE.format(**vars(circle))

        for arc in ki.arcs:
            ki_lib += KI_ARC.format(**vars(arc))

        for text in ki.texts:
            ki_lib += KI_TEXT.format(**vars(text))

        if ki.model_3d is not None:
            model_base_name = sanitize_model_filename(ki.model_3d.name)
            ki_lib += KI_MODEL_3D.format(
                file_3d=f"..{model_3d_path}/{model_base_name}.wrl",
                pos_x=ki.model_3d.translation.x,
                pos_y=ki.model_3d.translation.y,
                pos_z=ki.model_3d.translation.z,
                rot_x=ki.model_3d.rotation.x,
                rot_y=ki.model_3d.rotation.y,
                rot_z=ki.model_3d.rotation.z,
            )

        ki_lib += KI_END_FILE

        with open(
            file=footprint_full_path,
            mode="w",
            encoding="utf-8",
        ) as my_lib:
            my_lib.write(ki_lib)
