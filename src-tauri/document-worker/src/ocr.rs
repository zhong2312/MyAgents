use image::{DynamicImage, GenericImageView, imageops};
use ort::{session::Session, value::Tensor};
use std::collections::VecDeque;
use std::path::Path;

const DET_MIN_SIDE: u32 = 736;
const DET_MAX_SIDE: u32 = 4000;
const DET_THRESHOLD: f32 = 0.20;
const DET_BOX_THRESHOLD: f32 = 0.45;
const DET_UNCLIP_RATIO: f32 = 1.4;
const REC_HEIGHT: u32 = 48;
const REC_MIN_WIDTH: u32 = 320;
const REC_MAX_WIDTH: u32 = 3200;
const DET_MIN_BOX_SIDE: f32 = 3.0;
const MAX_TEXT_BOXES: usize = 3000;

pub struct OcrEngine {
    detector: Session,
    recognizer: Session,
    dictionary: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct OcrLine {
    pub text: String,
    pub confidence: f32,
    pub top: u32,
    pub left: u32,
}

#[derive(Debug, Clone, Copy)]
struct Point {
    x: f32,
    y: f32,
}

#[derive(Debug, Clone, Copy)]
struct Quad {
    points: [Point; 4],
}

impl OcrEngine {
    pub fn load(
        runtime: &Path,
        detector: &Path,
        recognizer: &Path,
        dictionary: &Path,
    ) -> Result<Self, String> {
        ort::init_from(runtime)
            .map_err(|_| "DOCUMENT_OCR_RUNTIME_UNAVAILABLE".to_string())?
            .with_name("myagents-anydoc")
            .commit();
        let mut detector_builder = Session::builder()
            .map_err(|_| "DOCUMENT_OCR_RUNTIME_UNAVAILABLE".to_string())?
            .with_intra_threads(2)
            .map_err(|_| "DOCUMENT_OCR_RUNTIME_UNAVAILABLE".to_string())?;
        let detector = detector_builder
            .commit_from_file(detector)
            .map_err(|_| "DOCUMENT_OCR_RUNTIME_UNAVAILABLE".to_string())?;
        let mut recognizer_builder = Session::builder()
            .map_err(|_| "DOCUMENT_OCR_RUNTIME_UNAVAILABLE".to_string())?
            .with_intra_threads(2)
            .map_err(|_| "DOCUMENT_OCR_RUNTIME_UNAVAILABLE".to_string())?;
        let recognizer = recognizer_builder
            .commit_from_file(recognizer)
            .map_err(|_| "DOCUMENT_OCR_RUNTIME_UNAVAILABLE".to_string())?;
        let dictionary = std::fs::read_to_string(dictionary)
            .map_err(|_| "DOCUMENT_OCR_RUNTIME_UNAVAILABLE".to_string())?
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if dictionary.len() != 18_708 {
            return Err("DOCUMENT_OCR_RUNTIME_UNAVAILABLE".into());
        }
        Ok(Self {
            detector,
            recognizer,
            dictionary,
        })
    }

    pub fn recognize(&mut self, image: &DynamicImage) -> Result<Vec<OcrLine>, String> {
        let boxes = self.detect(image)?;
        let mut lines = Vec::with_capacity(boxes.len());
        for quad in boxes {
            let crop = perspective_crop(image, &quad)?;
            if let Some((text, confidence)) = self.recognize_crop(&crop)? {
                let top = quad
                    .points
                    .iter()
                    .map(|point| point.y.max(0.0) as u32)
                    .min()
                    .unwrap_or(0);
                let left = quad
                    .points
                    .iter()
                    .map(|point| point.x.max(0.0) as u32)
                    .min()
                    .unwrap_or(0);
                lines.push(OcrLine {
                    text,
                    confidence,
                    top,
                    left,
                });
            }
        }
        lines.sort_by_key(|line| (line.top / 12, line.left));
        Ok(lines)
    }

    fn detect(&mut self, image: &DynamicImage) -> Result<Vec<Quad>, String> {
        let (source_width, source_height) = image.dimensions();
        let (width, height) = detector_dimensions(source_width, source_height);
        let resized = image
            .resize_exact(width, height, imageops::FilterType::Triangle)
            .to_rgb8();
        let mut input = vec![0_f32; 3 * width as usize * height as usize];
        let area = width as usize * height as usize;
        for (index, pixel) in resized.pixels().enumerate() {
            let channels = [pixel[2], pixel[1], pixel[0]];
            for channel in 0..3 {
                let mean = [0.485, 0.456, 0.406][channel];
                let std = [0.229, 0.224, 0.225][channel];
                input[channel * area + index] = (channels[channel] as f32 / 255.0 - mean) / std;
            }
        }
        let tensor = Tensor::from_array(([1_usize, 3, height as usize, width as usize], input))
            .map_err(|_| "DOCUMENT_OCR_INFERENCE_FAILED".to_string())?;
        let outputs = self
            .detector
            .run(ort::inputs!["x" => tensor])
            .map_err(|_| "DOCUMENT_OCR_INFERENCE_FAILED".to_string())?;
        let (shape, probabilities) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|_| "DOCUMENT_OCR_OUTPUT_INVALID".to_string())?;
        if shape.len() != 4 || probabilities.len() < area {
            return Err("DOCUMENT_OCR_OUTPUT_INVALID".into());
        }
        let output_height = shape[shape.len() - 2] as usize;
        let output_width = shape[shape.len() - 1] as usize;
        let map_len = output_height.saturating_mul(output_width);
        if map_len == 0 || probabilities.len() < map_len {
            return Err("DOCUMENT_OCR_OUTPUT_INVALID".into());
        }
        let map = &probabilities[probabilities.len() - map_len..];
        let contours = bitmap_contours(map, output_width, output_height);
        let mut boxes = Vec::new();
        for contour in contours.into_iter().take(MAX_TEXT_BOXES) {
            let Some(boxed) = minimum_area_quad(&contour) else {
                continue;
            };
            if quad_short_side(&boxed) < DET_MIN_BOX_SIDE
                || box_score(map, output_width, output_height, &boxed) < DET_BOX_THRESHOLD
            {
                continue;
            }
            let expanded = unclip_quad(&boxed, DET_UNCLIP_RATIO);
            if quad_short_side(&expanded) < DET_MIN_BOX_SIDE + 2.0 {
                continue;
            }
            boxes.push(scale_quad(
                &expanded,
                output_width as f32,
                output_height as f32,
                source_width as f32,
                source_height as f32,
            ));
        }
        boxes.sort_by(|left, right| {
            let left_top = quad_origin(left);
            let right_top = quad_origin(right);
            (left_top.1 / 12.0)
                .total_cmp(&(right_top.1 / 12.0))
                .then_with(|| left_top.0.total_cmp(&right_top.0))
        });
        Ok(boxes)
    }

    fn recognize_crop(&mut self, image: &DynamicImage) -> Result<Option<(String, f32)>, String> {
        let (width, height) = image.dimensions();
        if width == 0 || height == 0 {
            return Ok(None);
        }
        let target_width = ((width as f32 * REC_HEIGHT as f32 / height as f32).ceil() as u32)
            .clamp(1, REC_MAX_WIDTH);
        let resized = image
            .resize_exact(target_width, REC_HEIGHT, imageops::FilterType::Triangle)
            .to_rgb8();
        let canvas_width = target_width.max(REC_MIN_WIDTH);
        let area = canvas_width as usize * REC_HEIGHT as usize;
        // PaddleOCR pads the already-normalized CHW tensor with 0.0. Padding
        // an RGB image with black first would normalize the unused region to
        // -1.0 and measurably changes recognition on short text crops.
        let mut input = vec![0_f32; area * 3];
        for (index, pixel) in resized.pixels().enumerate() {
            let y = index / target_width as usize;
            let x = index % target_width as usize;
            let canvas_index = y * canvas_width as usize + x;
            for channel in 0..3 {
                input[channel * area + canvas_index] =
                    (pixel[2 - channel] as f32 / 255.0 - 0.5) / 0.5;
            }
        }
        let tensor = Tensor::from_array((
            [1_usize, 3, REC_HEIGHT as usize, canvas_width as usize],
            input,
        ))
        .map_err(|_| "DOCUMENT_OCR_INFERENCE_FAILED".to_string())?;
        let outputs = self
            .recognizer
            .run(ort::inputs!["x" => tensor])
            .map_err(|_| "DOCUMENT_OCR_INFERENCE_FAILED".to_string())?;
        let (shape, scores) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|_| "DOCUMENT_OCR_OUTPUT_INVALID".to_string())?;
        if shape.len() != 3 || shape[0] != 1 {
            return Err("DOCUMENT_OCR_OUTPUT_INVALID".into());
        }
        let steps = shape[1] as usize;
        let classes = shape[2] as usize;
        if classes != self.dictionary.len() + 2 || scores.len() != steps * classes {
            return Err("DOCUMENT_OCR_OUTPUT_INVALID".into());
        }
        let (text, confidence) = ctc_decode(scores, steps, classes, &self.dictionary)?;
        if text.is_empty() {
            Ok(None)
        } else {
            Ok(Some((text, confidence)))
        }
    }
}

fn ctc_decode(
    scores: &[f32],
    steps: usize,
    classes: usize,
    dictionary: &[String],
) -> Result<(String, f32), String> {
    if classes != dictionary.len() + 2 || scores.len() != steps.saturating_mul(classes) {
        return Err("DOCUMENT_OCR_OUTPUT_INVALID".into());
    }
    let space_class = dictionary.len() + 1;
    let mut previous = 0_usize;
    let mut text = String::new();
    let mut confidence = 0_f32;
    let mut count = 0_u32;
    for step in 0..steps {
        let row = &scores[step * classes..(step + 1) * classes];
        let (index, score) = row
            .iter()
            .copied()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(&right.1))
            .unwrap_or((0, 0.0));
        if index != 0 && index != previous {
            if index == space_class {
                text.push(' ');
                confidence += score;
                count += 1;
            } else if let Some(character) = dictionary.get(index - 1) {
                text.push_str(character);
                confidence += score;
                count += 1;
            }
        }
        previous = index;
    }
    Ok((text, confidence / count.max(1) as f32))
}

fn align32(value: u32) -> u32 {
    ((value as f32 / 32.0).round() as u32).max(1) * 32
}

fn detector_dimensions(width: u32, height: u32) -> (u32, u32) {
    let mut ratio = if width.min(height) < DET_MIN_SIDE {
        DET_MIN_SIDE as f32 / width.min(height) as f32
    } else {
        1.0
    };
    if width.max(height) as f32 * ratio > DET_MAX_SIDE as f32 {
        ratio = DET_MAX_SIDE as f32 / width.max(height) as f32;
    }
    (
        align32((width as f32 * ratio) as u32).max(32),
        align32((height as f32 * ratio) as u32).max(32),
    )
}

fn bitmap_contours(map: &[f32], width: usize, height: usize) -> Vec<Vec<Point>> {
    let mut seen = vec![false; map.len()];
    let mut result = Vec::new();
    for start in 0..map.len() {
        if seen[start] || map[start] < DET_THRESHOLD {
            continue;
        }
        let mut queue = VecDeque::from([start]);
        seen[start] = true;
        let mut contour = Vec::new();
        while let Some(index) = queue.pop_front() {
            let x = index % width;
            let y = index / width;
            let boundary = x == 0
                || y == 0
                || x + 1 == width
                || y + 1 == height
                || map[index - 1] < DET_THRESHOLD
                || map[index + 1] < DET_THRESHOLD
                || map[index - width] < DET_THRESHOLD
                || map[index + width] < DET_THRESHOLD;
            if boundary {
                contour.push(Point {
                    x: x as f32,
                    y: y as f32,
                });
            }
            for next_y in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                for next_x in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                    let next = next_y * width + next_x;
                    if !seen[next] && map[next] >= DET_THRESHOLD {
                        seen[next] = true;
                        queue.push_back(next);
                    }
                }
            }
        }
        if contour.len() >= 3 {
            result.push(contour);
        }
    }
    result
}

fn cross(origin: Point, a: Point, b: Point) -> f32 {
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

fn convex_hull(points: &[Point]) -> Vec<Point> {
    let mut points = points.to_vec();
    points.sort_by(|left, right| {
        left.x
            .total_cmp(&right.x)
            .then_with(|| left.y.total_cmp(&right.y))
    });
    points.dedup_by(|left, right| left.x == right.x && left.y == right.y);
    if points.len() <= 2 {
        return points;
    }
    let mut lower = Vec::new();
    for point in &points {
        while lower.len() >= 2
            && cross(lower[lower.len() - 2], lower[lower.len() - 1], *point) <= 0.0
        {
            lower.pop();
        }
        lower.push(*point);
    }
    let mut upper = Vec::new();
    for point in points.iter().rev() {
        while upper.len() >= 2
            && cross(upper[upper.len() - 2], upper[upper.len() - 1], *point) <= 0.0
        {
            upper.pop();
        }
        upper.push(*point);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

fn minimum_area_quad(contour: &[Point]) -> Option<Quad> {
    let hull = convex_hull(contour);
    if hull.len() < 3 {
        return None;
    }
    let mut best: Option<(f32, [Point; 4])> = None;
    for index in 0..hull.len() {
        let start = hull[index];
        let end = hull[(index + 1) % hull.len()];
        let angle = -(end.y - start.y).atan2(end.x - start.x);
        let (sin, cos) = angle.sin_cos();
        let mut min_x = f32::INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        for point in &hull {
            let x = point.x * cos - point.y * sin;
            let y = point.x * sin + point.y * cos;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        let area = (max_x - min_x) * (max_y - min_y);
        if best
            .as_ref()
            .is_some_and(|(best_area, _)| area >= *best_area)
        {
            continue;
        }
        let inverse = |x: f32, y: f32| Point {
            x: x * cos + y * sin,
            y: -x * sin + y * cos,
        };
        best = Some((
            area,
            [
                inverse(min_x, min_y),
                inverse(max_x, min_y),
                inverse(max_x, max_y),
                inverse(min_x, max_y),
            ],
        ));
    }
    best.map(|(_, points)| Quad {
        points: order_quad(points),
    })
}

fn order_quad(points: [Point; 4]) -> [Point; 4] {
    let mut top_left = points[0];
    let mut top_right = points[0];
    let mut bottom_right = points[0];
    let mut bottom_left = points[0];
    for point in points {
        if point.x + point.y < top_left.x + top_left.y {
            top_left = point;
        }
        if point.x + point.y > bottom_right.x + bottom_right.y {
            bottom_right = point;
        }
        if point.x - point.y > top_right.x - top_right.y {
            top_right = point;
        }
        if point.x - point.y < bottom_left.x - bottom_left.y {
            bottom_left = point;
        }
    }
    [top_left, top_right, bottom_right, bottom_left]
}

fn distance(left: Point, right: Point) -> f32 {
    (left.x - right.x).hypot(left.y - right.y)
}

fn quad_short_side(quad: &Quad) -> f32 {
    distance(quad.points[0], quad.points[3]).min(distance(quad.points[1], quad.points[2]))
}

fn unclip_quad(quad: &Quad, ratio: f32) -> Quad {
    let width = distance(quad.points[0], quad.points[1]);
    let height = distance(quad.points[0], quad.points[3]);
    if width <= f32::EPSILON || height <= f32::EPSILON {
        return *quad;
    }
    let distance = width * height * ratio / (2.0 * (width + height));
    let center = Point {
        x: quad.points.iter().map(|point| point.x).sum::<f32>() / 4.0,
        y: quad.points.iter().map(|point| point.y).sum::<f32>() / 4.0,
    };
    let x_axis = Point {
        x: (quad.points[1].x - quad.points[0].x) / width,
        y: (quad.points[1].y - quad.points[0].y) / width,
    };
    let y_axis = Point {
        x: (quad.points[3].x - quad.points[0].x) / height,
        y: (quad.points[3].y - quad.points[0].y) / height,
    };
    let half_width = width / 2.0 + distance;
    let half_height = height / 2.0 + distance;
    let point = |x: f32, y: f32| Point {
        x: center.x + x_axis.x * x + y_axis.x * y,
        y: center.y + x_axis.y * x + y_axis.y * y,
    };
    Quad {
        points: [
            point(-half_width, -half_height),
            point(half_width, -half_height),
            point(half_width, half_height),
            point(-half_width, half_height),
        ],
    }
}

fn point_in_quad(point: Point, quad: &Quad) -> bool {
    let mut sign = 0.0_f32;
    for index in 0..4 {
        let value = cross(quad.points[index], quad.points[(index + 1) % 4], point);
        if value.abs() <= f32::EPSILON {
            continue;
        }
        if sign == 0.0 {
            sign = value.signum();
        } else if value.signum() != sign {
            return false;
        }
    }
    true
}

fn box_score(map: &[f32], width: usize, height: usize, quad: &Quad) -> f32 {
    let min_x = quad
        .points
        .iter()
        .map(|point| point.x.floor().max(0.0) as usize)
        .min()
        .unwrap_or(0)
        .min(width.saturating_sub(1));
    let max_x = quad
        .points
        .iter()
        .map(|point| point.x.ceil().max(0.0) as usize)
        .max()
        .unwrap_or(0)
        .min(width.saturating_sub(1));
    let min_y = quad
        .points
        .iter()
        .map(|point| point.y.floor().max(0.0) as usize)
        .min()
        .unwrap_or(0)
        .min(height.saturating_sub(1));
    let max_y = quad
        .points
        .iter()
        .map(|point| point.y.ceil().max(0.0) as usize)
        .max()
        .unwrap_or(0)
        .min(height.saturating_sub(1));
    let mut total = 0.0;
    let mut count = 0_u32;
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            if point_in_quad(
                Point {
                    x: x as f32,
                    y: y as f32,
                },
                quad,
            ) {
                total += map[y * width + x];
                count += 1;
            }
        }
    }
    total / count.max(1) as f32
}

fn scale_quad(
    quad: &Quad,
    from_width: f32,
    from_height: f32,
    to_width: f32,
    to_height: f32,
) -> Quad {
    Quad {
        points: quad.points.map(|point| Point {
            x: (point.x / from_width * to_width)
                .round()
                .clamp(0.0, to_width),
            y: (point.y / from_height * to_height)
                .round()
                .clamp(0.0, to_height),
        }),
    }
}

fn quad_origin(quad: &Quad) -> (f32, f32) {
    (
        quad.points
            .iter()
            .map(|point| point.x)
            .fold(f32::INFINITY, f32::min),
        quad.points
            .iter()
            .map(|point| point.y)
            .fold(f32::INFINITY, f32::min),
    )
}

fn perspective_crop(image: &DynamicImage, quad: &Quad) -> Result<DynamicImage, String> {
    let width = distance(quad.points[0], quad.points[1])
        .max(distance(quad.points[2], quad.points[3]))
        .round() as u32;
    let height = distance(quad.points[0], quad.points[3])
        .max(distance(quad.points[1], quad.points[2]))
        .round() as u32;
    if width < 2 || height < 2 {
        return Err("DOCUMENT_OCR_OUTPUT_INVALID".into());
    }
    let transform = solve_homography(
        [
            Point { x: 0.0, y: 0.0 },
            Point {
                x: (width - 1) as f32,
                y: 0.0,
            },
            Point {
                x: (width - 1) as f32,
                y: (height - 1) as f32,
            },
            Point {
                x: 0.0,
                y: (height - 1) as f32,
            },
        ],
        quad.points,
    )
    .ok_or_else(|| "DOCUMENT_OCR_OUTPUT_INVALID".to_string())?;
    let source = image.to_rgb8();
    let mut crop = image::RgbImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let denominator = transform[6] * x as f32 + transform[7] * y as f32 + 1.0;
            let source_x =
                (transform[0] * x as f32 + transform[1] * y as f32 + transform[2]) / denominator;
            let source_y =
                (transform[3] * x as f32 + transform[4] * y as f32 + transform[5]) / denominator;
            crop.put_pixel(x, y, bilinear_pixel(&source, source_x, source_y));
        }
    }
    let crop = DynamicImage::ImageRgb8(crop);
    Ok(if height as f32 / width as f32 >= 1.5 {
        crop.rotate270()
    } else {
        crop
    })
}

fn solve_homography(from: [Point; 4], to: [Point; 4]) -> Option<[f32; 8]> {
    let mut matrix = [[0.0_f32; 9]; 8];
    for index in 0..4 {
        let x = from[index].x;
        let y = from[index].y;
        let u = to[index].x;
        let v = to[index].y;
        matrix[index * 2] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        matrix[index * 2 + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    for column in 0..8 {
        let pivot = (column..8).max_by(|left, right| {
            matrix[*left][column]
                .abs()
                .total_cmp(&matrix[*right][column].abs())
        })?;
        if matrix[pivot][column].abs() < 1e-6 {
            return None;
        }
        matrix.swap(column, pivot);
        let divisor = matrix[column][column];
        for value in &mut matrix[column][column..=8] {
            *value /= divisor;
        }
        let pivot_row = matrix[column];
        for (row, values) in matrix.iter_mut().enumerate() {
            if row == column {
                continue;
            }
            let factor = values[column];
            for (index, value) in values.iter_mut().enumerate().skip(column) {
                *value -= factor * pivot_row[index];
            }
        }
    }
    Some(std::array::from_fn(|index| matrix[index][8]))
}

fn bilinear_pixel(image: &image::RgbImage, x: f32, y: f32) -> image::Rgb<u8> {
    let x = x.clamp(0.0, image.width().saturating_sub(1) as f32);
    let y = y.clamp(0.0, image.height().saturating_sub(1) as f32);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(image.width() - 1);
    let y1 = (y0 + 1).min(image.height() - 1);
    let dx = x - x0 as f32;
    let dy = y - y0 as f32;
    let top_left = image.get_pixel(x0, y0);
    let top_right = image.get_pixel(x1, y0);
    let bottom_left = image.get_pixel(x0, y1);
    let bottom_right = image.get_pixel(x1, y1);
    image::Rgb(std::array::from_fn(|channel| {
        let top = top_left[channel] as f32 * (1.0 - dx) + top_right[channel] as f32 * dx;
        let bottom = bottom_left[channel] as f32 * (1.0 - dx) + bottom_right[channel] as f32 * dx;
        (top * (1.0 - dy) + bottom * dy).round() as u8
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_bitmap_contours_are_separate_and_feed_rotated_boxes() {
        let map = [
            0.9, 0.9, 0.0, 0.8, 0.8, // two components
            0.9, 0.9, 0.0, 0.8, 0.8, 0.0, 0.0, 0.0, 0.0, 0.0,
        ];
        let contours = bitmap_contours(&map, 5, 3);
        assert_eq!(contours.len(), 2);
        assert!(minimum_area_quad(&contours[0]).is_some());
        let rotated = [
            Point { x: 2.0, y: 0.0 },
            Point { x: 4.0, y: 2.0 },
            Point { x: 2.0, y: 4.0 },
            Point { x: 0.0, y: 2.0 },
        ];
        let quad = minimum_area_quad(&rotated).unwrap();
        assert!(distance(quad.points[0], quad.points[1]) > 2.7);
        assert!(quad_short_side(&unclip_quad(&quad, DET_UNCLIP_RATIO)) > 2.8);
    }

    #[test]
    fn detector_resize_matches_locked_paddle_rules() {
        assert_eq!(detector_dimensions(100, 50), (1472, 736));
        let (width, height) = detector_dimensions(8000, 4000);
        assert_eq!((width, height), (4000, 2016));
    }

    #[test]
    fn perspective_crop_rectifies_a_quad() {
        let mut image = image::RgbImage::new(12, 12);
        for y in 0..12 {
            for x in 0..12 {
                image.put_pixel(x, y, image::Rgb([x as u8 * 10, y as u8 * 10, 0]));
            }
        }
        let quad = Quad {
            points: [
                Point { x: 2.0, y: 1.0 },
                Point { x: 10.0, y: 3.0 },
                Point { x: 9.0, y: 9.0 },
                Point { x: 1.0, y: 8.0 },
            ],
        };
        let crop = perspective_crop(&DynamicImage::ImageRgb8(image), &quad).unwrap();
        assert!(crop.width() >= 8);
        assert!(crop.height() >= 6);
    }

    #[test]
    fn ctc_decode_collapses_repeats_and_keeps_the_model_space_class() {
        let dictionary = vec!["A".to_string(), "中".to_string()];
        let classes = dictionary.len() + 2;
        let winners = [(1, 0.9), (1, 0.8), (0, 0.7), (3, 0.95), (2, 0.85)];
        let mut scores = vec![0.0; winners.len() * classes];
        for (step, (class, score)) in winners.into_iter().enumerate() {
            scores[step * classes + class] = score;
        }
        let (text, confidence) = ctc_decode(&scores, 5, classes, &dictionary).unwrap();
        assert_eq!(text, "A 中");
        assert!((confidence - 0.9).abs() < 0.0001);
    }
}
