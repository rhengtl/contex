# ocr_engine.py
from PIL import Image
from transformers import TrOCRProcessor
from optimum.onnxruntime import ORTModelForVision2Seq
import io

# Load model and processor once
try:
    print("Loading OCR model and processor...")
    processor = TrOCRProcessor.from_pretrained('breezedeus/pix2text-mfr')
    model = ORTModelForVision2Seq.from_pretrained('breezedeus/pix2text-mfr', use_cache=False)
    print("Model and processor loaded successfully.")
except Exception as e:
    print(f"Error loading model or processor: {e}")
    processor = None
    model = None

def is_model_loaded():
    return model is not None and processor is not None

def process_image(file_bytes):
    if not is_model_loaded():
        raise RuntimeError("OCR model not loaded")

    img = Image.open(io.BytesIO(file_bytes)).convert('RGB')
    pixel_values = processor(images=img, return_tensors="pt").pixel_values
    generated_ids = model.generate(pixel_values)
    generated_text_list = processor.batch_decode(generated_ids, skip_special_tokens=True)

    return generated_text_list[0] if generated_text_list and generated_text_list[0] else '[No text recognized]'
    