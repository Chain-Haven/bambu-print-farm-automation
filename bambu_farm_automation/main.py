from flask import Flask, request, jsonify
from generator import generate_stl, slice_model
from printer_controller import PrinterManager
import os
import logging
import threading

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Configuration ---
# In a real deployed scenario, load these from an environment variable or config file
PRINTERS_CONFIG = [
    # {"ip": "192.168.1.101", "access_code": "12345678", "serial": "01P00A12345"},
]
# ---------------------

manager = PrinterManager()
for p_conf in PRINTERS_CONFIG:
    manager.add_printer(p_conf["ip"], p_conf["access_code"], p_conf["serial"])

@app.route('/webhook/print', methods=['POST'])
def handle_print_request():
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400
    
    # Expected payload: {"name": "TextOnModel", "color_hex": "FF0000", "model_type": "keychain"}
    text = data.get("name", "Default")
    color = data.get("color_hex", "FFFFFF") # Expect 6 char hex
    model_type = data.get("model_type", "keychain")
    
    # 1. Map model type to SCAD file
    scad_file = f"models/{model_type}.scad"
    if not os.path.exists(scad_file):
        return jsonify({"error": f"Model type {model_type} not found"}), 404
        
    # Start processing in background to not block the request? 
    # For now, let's keep it sync for simplicity of feedback, or spawn thread.
    
    # threading.Thread(target=process_job, args=(text, color, scad_file)).start()
    
    try:
        # 2. Generate STL
        logger.info(f"Generating STL for {text}...")
        stl_path = generate_stl(scad_file, f"job_{text}_{color}.stl", {"text": text})
        if not stl_path:
            return jsonify({"error": "STL Generation failed"}), 500
            
        # 3. Slice Model
        # We need a generic profile.
        profile = "profiles/generic_pla.json" 
        logger.info(f"Slicing STL...")
        gcode_path = slice_model(stl_path, profile, f"job_{text}_{color}")
        if not gcode_path:
            return jsonify({"error": "Slicing failed"}), 500
            
        # 4. Find Printer
        logger.info("Looking for printer...")
        printer = manager.find_printer_for_job(color)
        
        if printer:
            # 5. Upload and Print
            success, internal_path = printer.upload_file(gcode_path)
            if success:
                printer.start_print(gcode_path, internal_path)
                return jsonify({"status": "success", "message": f"Sent to printer {printer.serial}"})
            else:
                return jsonify({"error": "Upload to printer failed"}), 500
        else:
            return jsonify({"status": "queued", "message": "No matching printer available right now."}), 202
            
    except Exception as e:
        logger.error(f"Job failed: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    # Threaded=True is important if we do blocking calls
    app.run(host='0.0.0.0', port=5000, debug=True)
