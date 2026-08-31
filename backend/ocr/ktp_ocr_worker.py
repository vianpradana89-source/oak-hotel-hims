import os
import sys
import json
import logging
from PIL import Image
import numpy as np

# Suppress Paddle and oneDNN logging
os.environ['FLAGS_use_onednn'] = '0'
os.environ['GLOG_minloglevel'] = '3'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
logging.disable(logging.CRITICAL)

from paddleocr import PaddleOCR

KTP_KEYWORDS = [
    'NIK', 'N1K', 'NLK', 'N!K', 'NAMA', 'NARNA', 'TEMPAT', 'TGL', 'LAHIR', 'KELAMIN',
    'ALAMAT', 'ALARNAT', 'RT', 'RW', 'KEL', 'DESA', 'KECAMATAN', 'AGAMA',
    'STATUS', 'PERKAWINAN', 'KAWIN', 'PEKERJAAN', 'WARGANEGARA', 'WNI', 'BERLAKU',
    'PROVINSI', 'REPUBLIK', 'INDONESIA', 'SEUMUR', 'HIDUP', 'ISLAM', 'KRISTEN', 'KARYAWAN'
]

def group_boxes_into_lines(ocr_boxes):
    if not ocr_boxes:
        return [], []

    items = []
    for box, text, conf in ocr_boxes:
        if not text or not text.strip():
            continue
        xs = [pt[0] for pt in box]
        ys = [pt[1] for pt in box]
        min_x = min(xs)
        max_x = max(xs)
        min_y = min(ys)
        max_y = max(ys)
        center_y = (min_y + max_y) / 2.0
        center_x = (min_x + max_x) / 2.0
        height = max(max_y - min_y, 10.0)
        items.append({
            'box': box,
            'text': text.strip(),
            'conf': float(conf),
            'min_x': min_x,
            'max_x': max_x,
            'min_y': min_y,
            'max_y': max_y,
            'center_y': center_y,
            'center_x': center_x,
            'height': height
        })

    if not items:
        return [], []

    items.sort(key=lambda item: item['center_y'])

    lines = []
    for item in items:
        matched_line = None
        for line in lines:
            line_avg_y = sum(b['center_y'] for b in line) / len(line)
            line_avg_h = sum(b['height'] for b in line) / len(line)
            tolerance = max(line_avg_h, item['height']) * 0.65
            if abs(item['center_y'] - line_avg_y) <= tolerance:
                matched_line = line
                break

        if matched_line is not None:
            matched_line.append(item)
        else:
            lines.append([item])

    lines.sort(key=lambda line: sum(b['center_y'] for b in line) / len(line))

    merged_lines = []
    merged_confidences = []

    for line in lines:
        line.sort(key=lambda b: b['min_x'])
        line_text = " ".join(b['text'] for b in line).strip()
        line_conf = sum(b['conf'] for b in line) / len(line)
        if line_text:
            merged_lines.append(line_text)
            merged_confidences.append(line_conf)

    return merged_lines, merged_confidences

def evaluate_ktp_lines(lines, confidences):
    """
    Evaluates quality of KTP orientation.
    Higher score indicates right-side-up landscape KTP.
    """
    if not lines:
        return -100

    score = 0.0
    line_count = len(lines)
    # Prefer standard number of lines for a KTP (8 to 22 lines)
    if 8 <= line_count <= 25:
        score += 20.0
    elif line_count <= 4:
        score -= 30.0 # likely rotated sideways reading vertically

    keyword_hits = 0
    top_header_found = False
    nik_near_top = False

    for idx, line in enumerate(lines):
        upper = line.upper()
        # Check if line is not overly bloated (rotated lines merge entire columns into 1 line)
        if len(line) > 120:
            score -= 10.0

        for kw in KTP_KEYWORDS:
            if kw in upper:
                keyword_hits += 1

        if idx < 4:
            if 'PROVINSI' in upper or 'REPUBLIK' in upper or 'JAKARTA' in upper or 'KOTA' in upper:
                top_header_found = True
            if 'NIK' in upper or 'N1K' in upper or 'NLK' in upper:
                nik_near_top = True

    score += keyword_hits * 3.0
    if top_header_found:
        score += 15.0
    if nik_near_top:
        score += 15.0

    avg_conf = sum(confidences) / len(confidences) if confidences else 0.0
    score += avg_conf * 10.0

    return score

def run_ocr_on_pil_image(ocr, pil_img):
    img_np = np.array(pil_img)
    result = ocr.ocr(img_np, cls=False)
    
    ocr_boxes = []
    if result and isinstance(result, list):
        for page in result:
            if not page:
                continue
            for line in page:
                if len(line) >= 2 and isinstance(line[1], (tuple, list)):
                    box = line[0]
                    text = str(line[1][0]).strip()
                    conf = float(line[1][1])
                    ocr_boxes.append((box, text, conf))
    
    return group_boxes_into_lines(ocr_boxes)

def run_ocr_with_auto_orientation(image_path):
    if not os.path.exists(image_path):
        return {
            "success": False,
            "provider": "LOCAL_PADDLE_OCR",
            "error": f"Image file not found: {image_path}",
            "raw_lines": [],
            "confidence": 0.0
        }

    try:
        ocr = PaddleOCR(use_angle_cls=False, lang='en', show_log=False)
        base_img = Image.open(image_path).convert('RGB')
        w, h = base_img.size

        # Determine rotation candidate angles
        # If portrait (H > W), test [90, 270, 0, 180]
        # If landscape (W >= H), test [0, 180, 90, 270]
        if h > w:
            test_angles = [90, 270, 0, 180]
        else:
            test_angles = [0, 180, 90, 270]

        best_angle = test_angles[0]
        best_score = -999
        best_lines = []
        best_confs = []
        best_img = base_img

        for angle in test_angles:
            if angle == 0:
                current_img = base_img
            else:
                current_img = base_img.rotate(360 - angle, expand=True)

            lines, confs = run_ocr_on_pil_image(ocr, current_img)
            score = evaluate_ktp_lines(lines, confs)

            if score > best_score:
                best_score = score
                best_angle = angle
                best_lines = lines
                best_confs = confs
                best_img = current_img

            # Early exit if we get a high-quality right-side-up match
            if score >= 60.0:
                break

        # If best angle is not 0, save the oriented image over the target file
        if best_angle != 0:
            best_img.save(image_path, quality=95)

        avg_conf = sum(best_confs) / len(best_confs) if best_confs else 0.0

        return {
            "success": True,
            "provider": "LOCAL_PADDLE_OCR",
            "raw_lines": best_lines,
            "confidence": round(avg_conf, 4),
            "orientation_angle": best_angle,
            "score": best_score
        }
    except Exception as e:
        return {
            "success": False,
            "provider": "LOCAL_PADDLE_OCR",
            "error": str(e),
            "raw_lines": [],
            "confidence": 0.0
        }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        out = {
            "success": False,
            "provider": "LOCAL_PADDLE_OCR",
            "error": "Missing image file path argument",
            "raw_lines": [],
            "confidence": 0.0
        }
        print(json.dumps(out))
        sys.exit(1)

    target_image = sys.argv[1]
    result = run_ocr_with_auto_orientation(target_image)
    print(json.dumps(result))
