import json
import logging
import ssl
import time
import ftplib
import paho.mqtt.client as mqtt

logger = logging.getLogger(__name__)

class BambuPrinter:
    def __init__(self, ip, access_code, serial):
        self.ip = ip
        self.access_code = access_code
        self.serial = serial
        self.client = None
        self.ams_filaments = [] # List of colors found in AMS
        self.status = "Unknown"
        self.is_ready = False
        
    def connect_mqtt(self):
        """Connects to the printer's MQTT broker."""
        self.client = mqtt.Client(client_id=f"farm_ctrl_{self.serial}")
        self.client.username_pw_set("bblp", self.access_code)
        
        # Bambu printers use SSL/TLS
        self.client.tls_set(cert_reqs=ssl.CERT_NONE)
        self.client.tls_insecure_set(True)
        
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        
        logger.info(f"Connecting to MQTT on {self.ip}...")
        try:
            self.client.connect(self.ip, 8883, 60)
            self.client.loop_start()
        except Exception as e:
            logger.error(f"Failed to connect to printer {self.serial}: {e}")

    def on_connect(self, client, userdata, flags, rc):
        logger.info(f"Connected to {self.serial} with result code {rc}")
        # Subscribe to report topic
        client.subscribe(f"device/{self.serial}/report")
        
        # Request full status update
        payload = {
            "pushing": {
                "sequence_id": "0",
                "command": "pushall"
            }
        }
        self.publish(payload)

    def on_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload.decode())
            self.parse_status(data)
        except Exception as e:
            logger.error(f"Error parsing message: {e}")

    def publish(self, payload):
        topic = f"device/{self.serial}/request"
        self.client.publish(topic, json.dumps(payload))

    def parse_status(self, data):
        """Updates internal state based on printer report."""
        if "print" in data:
            print_data = data["print"]
            if "g_stg" in print_data:
                # g_stg is print stage. 0/1 usually idle/ready.
                # This is a simplification; robust logic needs more states.
                stage = print_data["g_stg"]
                # 0: idle, 1: prep, ...
                self.is_ready = (stage == 0) or (stage == 1)
                
            if "ams" in print_data and "ams" in print_data["ams"]:
                # Parse AMS for colors
                # Structure varies, but usually ams['ams'][0]['tray'][0]['tray_color']
                # tray_color is 8 hex chars (RGBA)
                try:
                    colors = []
                    for ams_unit in print_data["ams"]["ams"]:
                        for tray in ams_unit["tray"]:
                            # Some trays might be empty (id usually defines it)
                            if "tray_color" in tray:
                                # Convert RGBA hex to simple color name mapping if needed
                                # For now storing raw hex
                                colors.append(tray["tray_color"][:6]) # first 6 chars = RGB
                    self.ams_filaments = colors
                except Exception as e:
                    pass # AMS structure data might not be fully populated yet

    def upload_file(self, file_path):
        """Uploads a file to the printer's SD card via FTP."""
        try:
            filename = file_path.split("/")[-1] # Simplistic filename extraction
            logger.info(f"Uploading {filename} to {self.ip} via FTP...")
            
            with ftplib.FTP_TLS(self.ip) as ftp:
                ftp.login("bblp", self.access_code)
                ftp.prot_p() # Secure data connection
                
                with open(file_path, "rb") as f:
                    ftp.storbinary(f"STOR /data/{filename}", f)
            
            logger.info("Upload complete.")
            return True, f"/data/{filename}"
        except Exception as e:
            logger.error(f"FTP Upload failed: {e}")
            return False, None

    def start_print(self, filename, internal_file_path):
        """Sends the command to start printing the uploaded file."""
        # Note: You typically need to specify which AMS slot to use. 
        # This payload assumes using the current/default or requires mapping logic.
        
        # Simplest print command:
        payload = {
            "print": {
                "sequence_id": "0",
                "command": "project_file",
                "param": f"metadata/plate_1.gcode", # Usually implies inside 3mf? 
                # Actually for direct 3mf print, command is slightly different or usually done via Cloud.
                # For LAN mode, 'print_3mf' or similar might be needed, or slicing locally to GCODE is safer.
                
                # If we upload a .gcode.3mf, it's a 3mf.
                # command: "start" is used for gcode files.
                
                "url": f"file://{internal_file_path}",
                "bed_type": "auto",
                "bed_levelling": True,
                "flow_cali": True,
                "vibration_cali": True,
                "layer_inspect": True,
                "use_ams": True
            }
        }
        logger.info(f"Starting print: {internal_file_path}")
        self.publish(payload)


class PrinterManager:
    def __init__(self):
        self.printers = []
        
    def add_printer(self, ip, access_code, serial):
        p = BambuPrinter(ip, access_code, serial)
        p.connect_mqtt()
        self.printers.append(p)
        
    def find_printer_for_job(self, target_hex_color):
        """Finds an idle printer with the matching color."""
        # Simple color match logic - in reality you need strict hex matching or fuzziness
        for p in self.printers:
            if p.is_ready:
                if target_hex_color in p.ams_filaments:
                    return p
        return None

# Example Usage setup
# manager = PrinterManager()
# manager.add_printer("192.168.1.50", "12345678", "00M00A123456789")
