import os
import sys
import json
from PIL import Image, ImageDraw, ImageFont

def create_synthetic_ktp(output_path):
    img = Image.new('RGB', (856, 540), color=(180, 215, 235))
    draw = ImageDraw.Draw(img)
    
    draw.text((250, 20), "PROVINSI DKI JAKARTA", fill=(0, 0, 0))
    draw.text((280, 45), "JAKARTA SELATAN", fill=(0, 0, 0))
    
    draw.text((50, 90), "NIK", fill=(0, 0, 0))
    draw.text((220, 90), ": 3174051205900001", fill=(0, 0, 0))
    
    lines = [
        ("Nama", ": BUDI SANTOSO"),
        ("Tempat/Tgl Lahir", ": JAKARTA, 12-05-1990"),
        ("Jenis Kelamin", ": LAKI-LAKI"),
        ("Alamat", ": JL. SUDIRMAN NO. 45"),
        ("  RT/RW", ": 005/002"),
        ("  Kel/Desa", ": SENAYAN"),
        ("  Kecamatan", ": KEBAYORAN BARU"),
        ("Agama", ": ISLAM"),
        ("Status Perkawinan", ": KAWIN"),
        ("Pekerjaan", ": KARYAWAN SWASTA"),
        ("Kewarganegaraan", ": WNI"),
        ("Berlaku Hingga", ": SEUMUR HIDUP"),
    ]
    
    y = 130
    for label, val in lines:
        draw.text((50, y), label, fill=(0, 0, 0))
        draw.text((220, y), val, fill=(0, 0, 0))
        y += 28
        
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    img.save(output_path)
    print(f"Synthetic KTP saved to {output_path}")

if __name__ == '__main__':
    img_path = os.path.join(os.path.dirname(__file__), 'synthetic_test_ktp.png')
    create_synthetic_ktp(img_path)
    
    os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_textline_orientation=True, lang='en')
    results = ocr.ocr(img_path)
    print("OCR Results type:", type(results))
    print("OCR Results representation:", results)
