import subprocess
import os
import logging
import shutil

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Paths - Update these if your setup differs
ORCA_SLICER_PATH = "./OrcaSlicer.AppImage"
OPENSCAD_PATH = "openscad" # Assumes in PATH after apt install
OUTPUT_DIR_STL = "generated_stls"
OUTPUT_DIR_GCODE = "sliced_gcode"

def generate_stl(scad_template_path, output_filename, parameters):
    """
    Generates an STL from an OpenSCAD file with custom parameters.
    
    Args:
        scad_template_path (str): Path to the .scad file.
        output_filename (str): Name of the output STL file (without path).
        parameters (dict): Dictionary of parameters to pass to OpenSCAD (e.g., {'name': 'Ian', 'color': 'Red'}).
    
    Returns:
        str: Absolute path to the generated STL file, or None if failed.
    """
    output_path = os.path.join(OUTPUT_DIR_STL, output_filename)
    
    cmd = [OPENSCAD_PATH, "-o", output_path]
    
    # Add parameters as -D flags
    for key, value in parameters.items():
        # OpenSCAD requires string values to be quoted in the command line
        # e.g., -D name="Ian"
        if isinstance(value, str):
            cmd.append("-D")
            cmd.append(f'{key}="{value}"')
        else:
            cmd.append("-D")
            cmd.append(f'{key}={value}')
            
    cmd.append(scad_template_path)
    
    logger.info(f"Running OpenSCAD generation: {' '.join(cmd)}")
    
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            logger.info(f"STL successfully generated: {output_path}")
            return os.path.abspath(output_path)
        else:
            logger.error("OpenSCAD finished but file is missing or empty.")
            return None
    except subprocess.CalledProcessError as e:
        logger.error(f"OpenSCAD failed: {e.stderr}")
        return None

def slice_model(stl_path, profile_path, output_name):
    """
    Slices an STL file using OrcaSlicer CLI.
    
    Args:
        stl_path (str): Path to the STL file.
        profile_path (str): Path to the .json process/filament settings or config bundle.
                            NOTE: OrcaSlicer CLI argument support varies. 
                            Using --load-settings is common for processes.
        output_name (str): Base name for the output.
        
    Returns:
        str: Path to the generated 3mf/gcode file.
    """
    # Create a specific directory for this slice job to avoid clutter
    output_dir = os.path.join(OUTPUT_DIR_GCODE, output_name)
    os.makedirs(output_dir, exist_ok=True)
    
    # Basic CLI command for OrcaSlicer
    # Note: --load-settings might need to be split into --load-process, --load-filament depending on JSON export type.
    # For simplicity, we assume 'profile_path' is a config that OrcaSlicer accepts or a bundle.
    # You generally need to load: Machine, Process, and Material profiles.
    
    # Example command:
    # ./OrcaSlicer.AppImage --slice --export-3mf input.stl --outputdir output/ --load-settings config.json
    
    cmd = [
        ORCA_SLICER_PATH,
        "--slice",
        "--export-3mf", # 3MF is preferred for Bambu printers as it contains more metadata
        stl_path,
        "--outputdir", output_dir
    ]
    
    if profile_path:
        cmd.append("--load-settings")
        cmd.append(profile_path)
        
    logger.info(f"Running OrcaSlicer: {' '.join(cmd)}")
    
    try:
        # AppImages need FUSE or --appimage-extract-and-run, but recent Pi OS setup usually handles it 
        # provided libfuse2 is installed (which we do in setup_env.sh).
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        
        # Find the output file
        for file in os.listdir(output_dir):
            if file.endswith(".3mf") or file.endswith(".gcode"):
                full_path = os.path.join(output_dir, file)
                logger.info(f"Slicing complete. Output: {full_path}")
                return os.path.abspath(full_path)
        
        logger.error("Slicing finished but no output file found.")
        return None
        
    except subprocess.CalledProcessError as e:
        logger.error(f"OrcaSlicer failed: {e.stderr}")
        return None
